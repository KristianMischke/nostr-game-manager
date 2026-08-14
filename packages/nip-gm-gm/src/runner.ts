/**
 * One game, from start event to end event.
 *
 * The runner is where the protocol's hardest requirement lives: a simultaneous
 * round must be **verifiable the moment it closes**. That is not achieved by
 * publishing a result and being trusted — it is achieved by publishing, in one
 * signed delta, every move that was applied, the plaintext of each, the
 * conversation key that decrypts each one's original signed ciphertext, and
 * every revision that was discarded along with *its* key. An auditor then
 * re-runs `selectRevisions` and the module and either reproduces this delta or
 * has cryptographic evidence that the GM is faulty.
 *
 * So everything here is arranged around leaving that evidence:
 *
 * - Nothing is decided from ambient state. The clock is injected, randomness
 *   comes from the committed seed, and a timeout becomes a signed `system` input
 *   on a delta rather than a decision that happened offstage.
 * - The GM runs `selectRevisions` rather than picking a winner, so its choice is
 *   the same function an auditor applies rather than a claim an auditor must
 *   accept.
 * - Discarded revisions are published with their keys. Omitting them would leave
 *   the audit's revision check vacuous, which is the difference between "the GM
 *   proved it applied the highest revision" and "the GM said so".
 *
 * What is deliberately *not* here: crash recovery. A restarting GM must replay
 * its own log rather than reload the head, because the head is redacted for
 * public consumption and a module's hidden state (Orders' scheduled storms) is
 * not in it. That is a separate milestone, and doing it wrong quietly would be
 * worse than not doing it.
 */
import {
  allFinal,
  buildDelta,
  buildEnd,
  buildHead,
  buildPrivate,
  buildResponse,
  buildStatus,
  checkEnvelope,
  decrypt,
  GameEngine,
  parseMessage,
  parseMoveEnvelope,
  selectRevisions,
  supersededRevisions,
  verifyEvent,
  type AppliedMove,
  type Clock,
  type GameModule,
  type GameResult,
  type Hex,
  type KeySigner,
  type LobbyConfig,
  type NostrEvent,
  type ReceivedRevision,
  type ResolvedMove,
  type RevisionCandidate,
  type SeedCommitment,
  type SystemInput,
} from 'nip-gm-core';
import { bytesToHex } from '@noble/hashes/utils';
import type { Publisher } from './publisher.js';

/** One accepted revision, with everything the closing delta will have to publish. */
interface Accepted<Move> {
  candidate: RevisionCandidate;
  /** Hex NIP-44 conversation key; undefined for a plaintext move. */
  key?: string;
  wire: { type: string; data: unknown };
  move: Move;
}

interface OpenRound<Move> {
  seq: number;
  /** Event id of the public state event this round is played against. */
  prev: Hex;
  awaiting: Hex[];
  /** Move event id → what we accepted. Every revision, not just the winners. */
  accepted: Map<Hex, Accepted<Move>>;
  timer: { cancel(): void } | null;
  closing: boolean;
}

export interface RunnerOptions<Config, State, Move, Patch> {
  module: GameModule<Config, State, Move, Patch>;
  /**
   * Signs and publishes. The head is addressable and republished on every
   * snapshot, so it needs the strictly-increasing `created_at` this guarantees —
   * a relay drops a rewrite that does not advance the timestamp, leaving joining
   * clients to bootstrap from a stale board. See `publisher.ts`.
   */
  publish: Publisher;
  /** Still needed directly: only the GM's raw key can encrypt and reveal. */
  signer: KeySigner;
  clock: Clock;
  gmPubkey: Hex;
  /** The already-published start event; its id is the game id. */
  start: NostrEvent;
  seats: Hex[];
  config: Config;
  commitment: SeedCommitment;
  lobby: LobbyConfig;
  onEnd?(gameId: Hex, result: GameResult | undefined): void;
}

export interface GameRunner {
  readonly gameId: Hex;
  readonly seq: number;
  readonly isOver: boolean;
  /** Publish the seq-0 head and open round 1. */
  open(): Promise<void>;
  /** Feed a kind-2600 move message. Ignores anything not addressed to this game. */
  handleMove(event: NostrEvent): Promise<void>;
  /** Close the open round early, as if the timeout had fired. */
  closeRound(system?: SystemInput | null): Promise<void>;
  stop(): void;
}

export function createRunner<Config, State, Move, Patch>(
  options: RunnerOptions<Config, State, Move, Patch>,
): GameRunner {
  const { module, publish, signer, clock, start, seats, lobby } = options;
  const gameId = start.id;
  const mode = lobby.mode;

  const engine = new GameEngine(module, {
    gameId,
    config: options.config,
    seats,
    seed: options.commitment.seed,
  });

  let round: OpenRound<Move> | null = null;
  let stopped = false;

  const reject = async (target: NostrEvent, reason: string): Promise<void> => {
    await publish(
      buildResponse(target.id, target.pubkey, { status: 'rejected', reason }, { gameId, mode }),
    );
  };

  /** The highest `rev` currently held per player — what `checkEnvelope` compares against. */
  const submittedRevs = (): Map<Hex, number> => {
    const out = new Map<Hex, number>();
    if (!round) return out;
    for (const { candidate } of round.accepted.values()) {
      const held = out.get(candidate.player);
      if (held === undefined || candidate.envelope.rev > held) {
        out.set(candidate.player, candidate.envelope.rev);
      }
    }
    return out;
  };

  const candidates = (): RevisionCandidate[] =>
    round ? [...round.accepted.values()].map((a) => a.candidate) : [];

  const publishStatus = async (): Promise<void> => {
    if (!round) return;
    const winners = selectRevisions(candidates());
    const received: Record<Hex, ReceivedRevision> = {};
    for (const [player, winner] of winners) {
      received[player] = { rev: winner.envelope.rev, final: winner.envelope.final };
    }
    // Always ephemeral, and carries no `p` tags: repeating them at revision
    // cadence would drown the "your turn" notification players subscribe for.
    await publish(buildStatus({ gameId, seq: round.seq, received }));
  };

  const publishHead = async (): Promise<void> => {
    // Redacted, not serialized: the head is public, and a module's hidden state
    // published in it would be handed to every player and every spectator.
    const state = module.redact
      ? module.redact(engine.state, undefined)
      : module.serialize(engine.state);
    await publish(
      buildHead({ gameId, seq: engine.seq, game: module.id, version: module.version, state }),
    );
  };

  const openRound = (seq: number, prev: Hex, awaiting: Hex[]): void => {
    round = { seq, prev, awaiting, accepted: new Map(), timer: null, closing: false };

    if (lobby.turnTimeout > 0) {
      const opened = round;
      opened.timer = clock.setTimeout(lobby.turnTimeout, () => {
        opened.timer = null;
        // A timeout is not a decision made offstage: it becomes a signed system
        // input on the closing delta, so replay reproduces it exactly.
        void closeRound({ type: 'timeout' });
      });
    }
  };

  async function closeRound(system: SystemInput | null = null): Promise<void> {
    const current = round;
    if (!current || current.closing || stopped || engine.isOver) return;
    current.closing = true;
    current.timer?.cancel();

    const all = candidates();
    const winners = selectRevisions(all);

    const resolved: ResolvedMove<Move>[] = [];
    for (const [player, winner] of winners) {
      const entry = current.accepted.get(winner.id);
      if (!entry) continue;
      resolved.push({ id: winner.id, player, seat: seats.indexOf(player), move: entry.move });
    }

    const now = clock.now();
    const outcome = engine.applyRound(resolved, system, now);

    const cite = (id: Hex): AppliedMove => {
      const entry = current.accepted.get(id);
      if (!entry) throw new Error(`cannot cite move ${id}: not in this round`);
      return { id, move: entry.wire, key: entry.key };
    };

    const superseded = supersededRevisions(all, winners).map((c) => cite(c.id));

    const delta = await publish(
      buildDelta(
        {
          gameId,
          seq: outcome.seq,
          awaiting: outcome.awaiting,
          content: {
            seq: outcome.seq,
            applied: outcome.ordered.map((m) => cite(m.id)),
            patch: outcome.patch as unknown,
            system,
            superseded: superseded.length ? superseded : undefined,
          },
        },
        { mode },
      ),
    );

    for (const [recipient, value] of outcome.privateState ?? []) {
      const content = await signer.nip44Encrypt(recipient, JSON.stringify(value));
      await publish(buildPrivate({ gameId, seq: outcome.seq, recipient, content }, { mode }));
    }

    round = null;

    if (engine.isOver) {
      await publishHead();
      await publish(
        buildEnd({
          gameId,
          players: seats,
          content: {
            result: engine.result ?? { winners: [] },
            // The reveal that makes every derivation in the game recomputable.
            seed: bytesToHex(options.commitment.seed),
            salt: bytesToHex(options.commitment.salt),
          },
        }),
      );
      options.onEnd?.(gameId, engine.result);
      return;
    }

    if (lobby.snapshotInterval > 0 && outcome.seq % lobby.snapshotInterval === 0) {
      await publishHead();
    }
    openRound(outcome.seq + 1, delta.id, outcome.awaiting);
  }

  return {
    gameId,
    get seq(): number {
      return engine.seq;
    },
    get isOver(): boolean {
      return engine.isOver;
    },

    async open(): Promise<void> {
      // The seq-0 head is what lets a client bootstrap at all: it cannot replay
      // the module (no seed until the end), so it needs a state to fold onto.
      await publishHead();
      openRound(1, gameId, engine.awaiting);
    },

    async handleMove(event: NostrEvent): Promise<void> {
      const current = round;
      if (!current || stopped || engine.isOver) return;
      if (!verifyEvent(event)) return;

      const parsed = parseMessage(event);
      if (!parsed.ok || parsed.value.action !== 'move') return;
      if (parsed.value.gameId !== gameId) return;

      const player = event.pubkey;
      if (!seats.includes(player)) {
        await reject(event, 'not_seated');
        return;
      }

      // Hidden move: derive the conversation key from the ephemeral pubkey in
      // the event. No player cooperation and no transmitted private key —
      // ECDH(gm_priv, ephemeral_pub) equals what the player computed.
      let key: string | undefined;
      let plaintext: string;
      if (parsed.value.ephemeral) {
        const conversationKey = await signer.conversationKey(parsed.value.ephemeral);
        try {
          plaintext = decrypt(parsed.value.content, conversationKey);
        } catch {
          await reject(event, 'undecryptable');
          return;
        }
        key = bytesToHex(conversationKey);
      } else {
        plaintext = parsed.value.content;
      }

      const envelope = parseMoveEnvelope(plaintext);
      if (!envelope.ok) {
        await reject(event, `bad_envelope:${envelope.error}`);
        return;
      }

      // Protocol-level admission: right round, right `prev`, not superseded by a
      // revision already in hand. An auditor re-runs exactly this.
      const check = checkEnvelope(
        envelope.value,
        { seq: current.seq, prev: current.prev },
        player,
        { awaiting: current.awaiting, submitted: submittedRevs() },
      );
      if (!check.ok) {
        await reject(event, check.reason);
        return;
      }

      const wire = { type: envelope.value.type, data: envelope.value.data };
      const move = module.parseMove(wire);
      if (move === undefined) {
        await reject(event, 'unparseable_move');
        return;
      }

      const resolved: ResolvedMove<Move> = {
        id: event.id,
        player,
        seat: seats.indexOf(player),
        move,
      };
      // Through the engine rather than the module directly, so the context the
      // GM validates against is the one the engine will apply with.
      const legal = engine.validate(resolved, clock.now());
      if (!legal.ok) {
        await reject(event, legal.reason);
        return;
      }

      current.accepted.set(event.id, {
        candidate: { id: event.id, player, envelope: envelope.value },
        key,
        wire,
        move,
      });

      // Acknowledge before considering the close, so a player whose `final`
      // revision closes the round still learns it landed.
      await publishStatus();

      if (allFinal(selectRevisions(candidates()), current.awaiting)) await closeRound(null);
    },

    closeRound,

    stop(): void {
      stopped = true;
      round?.timer?.cancel();
      round = null;
    },
  };
}
