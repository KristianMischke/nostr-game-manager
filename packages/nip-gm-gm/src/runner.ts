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
 * ## Surviving a restart
 *
 * A runner can be rebuilt mid-game from a snapshot its predecessor wrote down
 * (`RunnerOptions.resume`), and everything above is why the snapshot is the GM's
 * own `serialize()` output rather than the head: the head is `redact()`'d for
 * public consumption, so a module's hidden state — Orders' scheduled storms — is
 * not in it, and neither is `awaiting`. A GM restored from its own head would
 * quietly play a different game from the one it committed to.
 *
 * The open round is restored the same way, by feeding the move events back
 * through `handleMove`. That is not thrift: the admission path is where the
 * evidence is built, and a second path that reconstructed `accepted` directly
 * would be a second chance to build it differently.
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
  type EngineSnapshot,
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
import type { RoundCommit, StoredRevision, StoredRound } from './store.js';

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
  /** Republishes `status` while the round is open; see `statusInterval`. */
  heartbeat: { cancel(): void } | null;
  /** Clock time this round times out at, or null when it is untimed. */
  deadline: number | null;
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
  /**
   * Seconds between `status` republications while a timed round is open; 0
   * disables them. Ignored for an untimed round, which has no countdown to
   * report and where status on move arrival is the whole story.
   *
   * A heartbeat exists because `status` is ephemeral: relays store nothing, so a
   * client that joins (or reloads) mid-round hears the round's deadline only
   * when the next move happens to arrive — which in a round where nobody moves
   * is never. See {@link DEFAULT_STATUS_INTERVAL}.
   */
  statusInterval?: number;
  onEnd?(gameId: Hex, result: GameResult | undefined): void;
  /**
   * Rebuild a game in progress instead of dealing a new one.
   *
   * Present, call {@link GameRunner.resume} rather than {@link GameRunner.open}.
   */
  resume?: RunnerResume;
  /**
   * Where the runner writes itself down. Absent, nothing is durable.
   *
   * Every method is called at a point where a crash immediately afterwards is
   * survivable and a crash immediately before it loses nothing that was
   * published — see the second rule in `store.ts`.
   */
  persist?: RunnerPersistence;
  /**
   * Seconds of slack a resumed round's deadline gets, at minimum.
   *
   * A round whose deadline passed while the process was down would otherwise
   * time out the instant the new one boots — every open game on the daemon
   * resolving at once, from a deploy. The clamp is not auditable state: the
   * delta records the `now` at close either way, and a timeout is a signed
   * system input whenever it happens.
   */
  resumeGrace?: number;
}

/** A game in progress, as its predecessor wrote it down. */
export interface RunnerResume {
  /** Absent for a game that had not played a round yet; see `StoredGame.snapshot`. */
  snapshot?: EngineSnapshot;
  /** The round that was open, if the process died inside one. */
  round?: {
    record: StoredRound;
    /** Raw signed move events already admitted, in arrival order. */
    accepted: NostrEvent[];
  };
}

/** The runner's durable safe points. See `store.ts`. */
export interface RunnerPersistence {
  roundOpened(round: StoredRound): Promise<void>;
  revisionAccepted(revision: StoredRevision): Promise<void>;
  roundCommitted(commit: RoundCommit): Promise<void>;
  sent(eventId: Hex): Promise<void>;
}

/**
 * Ten seconds: frequent enough that a client joining mid-round starts its
 * countdown almost immediately, rare enough to be nothing next to move traffic
 * — and it costs a relay nothing to keep, being ephemeral.
 */
export const DEFAULT_STATUS_INTERVAL = 10;

/**
 * Fifteen seconds of slack for a round resumed after the deadline passed.
 *
 * Long enough to cover an ordinary restart — drain, boot, relay handshake — and
 * short enough that it is not a way to play on after time. See
 * {@link RunnerOptions.resumeGrace}.
 */
export const DEFAULT_RESUME_GRACE = 15;

export interface GameRunner {
  readonly gameId: Hex;
  readonly seq: number;
  readonly isOver: boolean;
  /** Publish the seq-0 head and open round 1. */
  open(): Promise<void>;
  /**
   * Reinstate a game in progress. Mutually exclusive with {@link open}.
   *
   * Requires `RunnerOptions.resume`; throws without it rather than quietly
   * opening a fresh round on an old game, which would republish `seq` 1 over a
   * game already at 40 and break the chain for every client following it.
   */
  resume(): Promise<void>;
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
  const statusInterval = options.statusInterval ?? DEFAULT_STATUS_INTERVAL;

  const engine = new GameEngine(module, {
    gameId,
    config: options.config,
    seats,
    seed: options.commitment.seed,
    restore: options.resume?.snapshot,
  });

  const persist = options.persist;

  let round: OpenRound<Move> | null = null;
  let stopped = false;
  /**
   * True while a resumed round's moves are being fed back in.
   *
   * Suppresses two things that are correct the first time and wrong the second:
   * a `status` per admitted revision, which would be a burst of ephemeral events
   * announcing nothing new, and rejections, which would tell a player their move
   * from fifteen minutes ago was refused when in fact it was applied.
   */
  let replaying = false;

  const reject = async (target: NostrEvent, reason: string): Promise<void> => {
    if (replaying) return;
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
    if (!round || stopped || replaying) return;
    const winners = selectRevisions(candidates());
    const received: Record<Hex, ReceivedRevision> = {};
    for (const [player, winner] of winners) {
      received[player] = { rev: winner.envelope.rev, final: winner.envelope.final };
    }
    // Recomputed per publication rather than stamped once at open: what a client
    // needs is the time left *when this event was sent*, so that anchoring it to
    // its own clock on receipt lands on the same instant the GM's timer will.
    const remaining =
      round.deadline === null ? undefined : Math.max(0, round.deadline - clock.now());
    // Always ephemeral, and carries no `p` tags: repeating them at revision
    // cadence would drown the "your turn" notification players subscribe for.
    await publish(buildStatus({ gameId, seq: round.seq, received, remaining }));
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

  /** Keep republishing `status` until the round closes. */
  const scheduleHeartbeat = (opened: OpenRound<Move>): void => {
    if (statusInterval <= 0 || opened.deadline === null) return;
    opened.heartbeat = clock.setTimeout(statusInterval, () => {
      opened.heartbeat = null;
      if (round !== opened || opened.closing || stopped) return;
      // Rescheduled before publishing, not after: publishing is async, and a
      // chain that waited for it would drift by one relay round trip per beat.
      scheduleHeartbeat(opened);
      void publishStatus();
    });
  };

  /** A round's durable form, built once so memory and storage cannot disagree. */
  const roundRecord = (seq: number, prev: Hex, awaiting: Hex[], at: number): StoredRound => ({
    gameId,
    seq,
    prev,
    awaiting,
    openedAt: at,
    // Absolute, not a duration. A duration is only meaningful next to the clock
    // reading that produced it, and the whole point here is that the process
    // holding that reading may not be the one that acts on it.
    deadline: lobby.turnTimeout > 0 ? at + lobby.turnTimeout : null,
  });

  /**
   * Open a round from its record.
   *
   * `store` is false when the record is already durable — `commitRound` writes
   * the next round in the same transaction as the delta that opens it, because
   * its `prev` is that delta's id and a crash in between must not lose it.
   */
  const openRound = async (record: StoredRound, store: boolean): Promise<void> => {
    const opened: OpenRound<Move> = {
      seq: record.seq,
      prev: record.prev,
      awaiting: [...record.awaiting],
      accepted: new Map(),
      timer: null,
      heartbeat: null,
      deadline: record.deadline,
      closing: false,
    };
    round = opened;
    if (store) await persist?.roundOpened(record);

    if (opened.deadline !== null) {
      opened.timer = clock.setTimeout(Math.max(0, opened.deadline - clock.now()), () => {
        opened.timer = null;
        // A timeout is not a decision made offstage: it becomes a signed system
        // input on the closing delta, so replay reproduces it exactly.
        void closeRound({ type: 'timeout' });
      });

      // The opening status is what starts every connected client's countdown.
      // Without it the first news of the deadline would be the first move of the
      // round, and a round where nobody moves — the one where the countdown
      // matters most — would never show a clock at all.
      scheduleHeartbeat(opened);
      await publishStatus();
    }
  };

  async function closeRound(system: SystemInput | null = null): Promise<void> {
    const current = round;
    if (!current || current.closing || stopped || engine.isOver) return;
    current.closing = true;
    current.timer?.cancel();
    current.heartbeat?.cancel();

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

    // Everything this round will ever publish is signed first and sent second.
    // Between the two sits one durable act, so that a crash can only ever land
    // on "nothing happened" or "it happened, finish sending it" — never on "the
    // relay has a delta this GM has no memory of having produced".
    const delta = await publish.prepare(
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

    const privates: NostrEvent[] = [];
    for (const [recipient, value] of outcome.privateState ?? []) {
      const content = await signer.nip44Encrypt(recipient, JSON.stringify(value));
      // Prepared, not sent, for a reason particular to these: NIP-44 draws a
      // fresh nonce per encryption, so re-encrypting the same private state
      // after a crash produces different ciphertext and a different event id.
      // A rebuilt one would be a second private state at the same seq rather
      // than the same one again.
      privates.push(
        await publish.prepare(buildPrivate({ gameId, seq: outcome.seq, recipient, content }, { mode })),
      );
    }

    const end = engine.isOver
      ? await publish.prepare(
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
        )
      : undefined;

    const next = engine.isOver
      ? undefined
      : roundRecord(outcome.seq + 1, delta.id, outcome.awaiting, now);

    await persist?.roundCommitted({
      gameId,
      snapshot: engine.snapshot(),
      ...(engine.result ? { result: engine.result } : {}),
      ...(engine.isOver ? { endedAt: now } : {}),
      outgoing: [
        { event: delta, purpose: 'delta', gameId, seq: outcome.seq },
        ...privates.map((event) => ({ event, purpose: 'private' as const, gameId, seq: outcome.seq })),
        ...(end ? [{ event: end, purpose: 'end' as const, gameId, seq: outcome.seq }] : []),
      ],
      closed: current.seq,
      ...(next ? { next } : {}),
    });

    await publish.send(delta);
    await persist?.sent(delta.id);
    for (const event of privates) {
      await publish.send(event);
      await persist?.sent(event.id);
    }

    round = null;

    if (end) {
      await publishHead();
      await publish.send(end);
      await persist?.sent(end.id);
      options.onEnd?.(gameId, engine.result);
      return;
    }

    if (lobby.snapshotInterval > 0 && outcome.seq % lobby.snapshotInterval === 0) {
      await publishHead();
    }
    await openRound(next as StoredRound, false);
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
      await openRound(roundRecord(1, gameId, engine.awaiting, clock.now()), true);
    },

    async resume(): Promise<void> {
      const from = options.resume;
      if (!from) throw new Error(`cannot resume ${gameId}: no snapshot was given`);

      // Republished at the current seq, not seq 0. This is for whoever arrives
      // next — a reloading player, a spectator — and not for the clients already
      // in the game: a session that has bootstrapped ignores every later head,
      // and it does not need one, because the round below reopens at the same
      // `prev` those clients are already holding.
      await publishHead();

      if (!from.round) {
        // No open round is only ever legitimate at seq 0 — a game announced but
        // never opened, because the process died between publishing the start
        // event and opening round 1. Every later round is written down in the
        // same transaction as the delta that opens it, so a gap here is a store
        // that has lost something rather than a game between rounds.
        if (engine.seq !== 0) {
          throw new Error(`cannot resume ${gameId}: no open round recorded at seq ${engine.seq}`);
        }
        await openRound(roundRecord(1, gameId, engine.awaiting, clock.now()), true);
        return;
      }

      const stored = from.round.record;
      const grace = options.resumeGrace ?? DEFAULT_RESUME_GRACE;
      const deadline =
        stored.deadline === null ? null : Math.max(stored.deadline, clock.now() + grace);

      // The record is reopened before the moves are replayed, because
      // `checkEnvelope` compares each move against the round it belongs to —
      // the same comparison, against the same `seq` and `prev`, that admitted it
      // the first time.
      await openRound({ ...stored, deadline }, false);

      replaying = true;
      try {
        for (const event of from.round.accepted) await this.handleMove(event);
      } finally {
        replaying = false;
      }

      // One status for the whole replay rather than one per move: what a client
      // needs is where the round stands now, and the deadline it should be
      // counting down to.
      await publishStatus();
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

      // Durable before it is acknowledged. A revision the GM has acted on but
      // not written down is one a restart would silently un-accept, and the
      // player — who saw a `status` citing it — would have no reason to resend.
      if (!replaying) {
        await persist?.revisionAccepted({
          gameId,
          seq: current.seq,
          event,
          player,
          rev: envelope.value.rev,
          ...(key ? { key } : {}),
          cause: event.id,
        });
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
      round?.heartbeat?.cancel();
      round = null;
    },
  };
}
