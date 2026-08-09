/**
 * Play a scripted game and emit the full signed event log.
 *
 * This is what turns an in-memory module into something the verifier can audit:
 * it does what a GM daemon will do — commit a seed, publish a start event,
 * collect per-round encrypted moves, close rounds with revealed keys, publish
 * the end reveal — but synchronously and with no relay involved.
 *
 * The real daemon now exists (`nip-gm-gm`, exercised end to end in
 * `session.test.ts`), and this is deliberately *not* retired in its favour. The
 * two test different things: the daemon proves the protocol works when a GM
 * behaves, while this harness scripts the log directly and so can produce logs a
 * correct GM would never emit — a hidden revision, a stale winner, a forged
 * plaintext. Auditing is only meaningfully tested against those.
 */
import {
  buildDelta,
  buildEnd,
  buildMove,
  buildStart,
  createSeedCommitment,
  encrypt,
  formatMoveEnvelope,
  GameEngine,
  generateEphemeralKeypair,
  KIND,
  playerConversationKey,
  seedCommit,
  selectRevisions,
  supersededRevisions,
  type AppliedMove,
  type GameModule,
  type Hex,
  type NostrEvent,
  type ResolvedMove,
  type RevisionCandidate,
  type SystemInput,
} from 'nip-gm-core';
import { bytesToHex } from '@noble/hashes/utils';
import type { MemorySigner } from './memory-signer.js';

/** One player's participation in a round. */
export interface ScriptedSubmission<Move> {
  player: MemorySigner;
  /** The move that should end up applied — the highest revision. */
  move: Move;
  wire: { type: string; data: unknown };
  /**
   * Earlier revisions this player published and then replaced, oldest first
   * (NIP-GM §Move revisions). They take revisions 0..n-1 and `wire` takes n, so
   * a submission without drafts is an ordinary single-shot move at rev 0.
   */
  drafts?: { type: string; data: unknown }[];
}

/** What a player does in one round; omission means they did not submit. */
export interface ScriptedRound<Move> {
  moves: ScriptedSubmission<Move>[];
  system?: SystemInput | null;
  now?: number;
}

export interface HarnessOptions<Config, Move> {
  gm: MemorySigner;
  players: MemorySigner[];
  config: Config;
  rounds: ScriptedRound<Move>[];
  /**
   * Pin the start event's timestamp. Together with {@link HarnessOptions.seed}
   * this fixes the game id across runs.
   *
   * It does *not* make the whole log reproducible: every move draws a fresh
   * ephemeral keypair and NIP-44 chooses a random nonce, so ciphertexts and
   * therefore move event ids differ per run — and under an id-sensitive
   * resolution order, so does the final state. Two runs are self-consistent
   * games, not the same game.
   */
  startedAt?: number;
  /**
   * Fixed GM seed and salt. Without these the commitment is freshly random per
   * run, so the derived randomness differs even when everything else matches.
   */
  seed?: Uint8Array;
  salt?: Uint8Array;
}

export interface GameTranscript<State> {
  gameId: Hex;
  gmPubkey: Hex;
  seats: Hex[];
  start: NostrEvent;
  moves: NostrEvent[];
  states: NostrEvent[];
  end: NostrEvent;
  finalState: State;
  seed: Uint8Array;
}

export async function runScriptedGame<Config, State, Move, Patch>(
  module: GameModule<Config, State, Move, Patch>,
  options: HarnessOptions<Config, Move>,
): Promise<GameTranscript<State>> {
  const { gm, players, config } = options;
  const startedAt = options.startedAt ?? 1_700_000_000;
  const seats = players.map((p) => p.pubkey);

  const commitment =
    options.seed && options.salt
      ? {
          seed: options.seed,
          salt: options.salt,
          commit: seedCommit(options.seed, options.salt),
        }
      : createSeedCommitment();

  const start = await gm.signEvent({
    ...buildStart({
      lobby: { kind: KIND.LOBBY, pubkey: gm.pubkey, identifier: 'harness' },
      seats,
      game: module.id,
      version: module.version,
      content: { config: config as unknown, seedCommit: commitment.commit },
    }),
    pubkey: gm.pubkey,
    created_at: startedAt,
  });

  const gameId = start.id;
  const engine = new GameEngine(module, { gameId, config, seats, seed: commitment.seed });

  const moveEvents: NostrEvent[] = [];
  const stateEvents: NostrEvent[] = [];
  /** Move event id → hex conversation key, for the round-closing reveal. */
  const keyOf = new Map<Hex, string>();

  for (const [index, round] of options.rounds.entries()) {
    if (engine.isOver) break;

    const seq = engine.seq + 1;
    const now = round.now ?? startedAt + (index + 1) * 60;
    const prev = stateEvents.length ? stateEvents[stateEvents.length - 1].id : gameId;

    // --- players commit hidden moves under fresh per-round keys -------------
    const submitted: (ResolvedMove<Move> & { key: string })[] = [];
    const candidates: RevisionCandidate[] = [];
    const wireOf = new Map<Hex, { type: string; data: unknown }>();

    for (const entry of round.moves) {
      // One ephemeral key per (player, round), not per revision: every revision
      // of a round is exposed by the same reveal at close, so separate keys
      // would buy nothing and multiply what the delta has to publish.
      const ephemeral = generateEphemeralKeypair();
      const convKey = playerConversationKey(ephemeral, gm.pubkey);
      const key = bytesToHex(convKey);

      const revisions = [
        ...(entry.drafts ?? []).map((wire) => ({ wire, final: false })),
        { wire: entry.wire, final: true },
      ];

      let winner: { id: Hex; wire: { type: string; data: unknown } } | undefined;

      for (const [rev, revision] of revisions.entries()) {
        const ciphertext = encrypt(
          formatMoveEnvelope({
            seq,
            prev,
            rev,
            final: revision.final,
            type: revision.wire.type,
            data: revision.wire.data,
          }),
          convKey,
        );

        const event = await entry.player.signEvent({
          ...buildMove(gameId, gm.pubkey, ciphertext, { ephemeral: ephemeral.pubkey }),
          pubkey: entry.player.pubkey,
          // Revisions are published across the round, not at its close.
          created_at: now - revisions.length + rev,
        });

        moveEvents.push(event);
        candidates.push({
          id: event.id,
          player: entry.player.pubkey,
          envelope: {
            seq,
            prev,
            rev,
            final: revision.final,
            type: revision.wire.type,
            data: revision.wire.data,
          },
        });
        keyOf.set(event.id, key);
        if (revision.final) winner = { id: event.id, wire: revision.wire };
      }

      if (!winner) throw new Error('a submission produced no final revision');
      wireOf.set(winner.id, winner.wire);
      submitted.push({
        id: winner.id,
        player: entry.player.pubkey,
        seat: seats.indexOf(entry.player.pubkey),
        move: entry.move,
        key,
      });
    }

    // The GM does not trust the script's word for which revision won: it runs
    // the same selector an auditor will, so a harness bug shows up as a
    // divergence rather than being papered over on both sides.
    const winners = selectRevisions(candidates);
    for (const chosen of submitted) {
      if (winners.get(chosen.player)?.id !== chosen.id) {
        throw new Error(`selectRevisions disagreed with the script for ${chosen.player}`);
      }
    }

    // --- GM resolves and closes the round -----------------------------------
    const outcome = engine.applyRound(submitted, round.system ?? null, now);

    const applied: AppliedMove[] = outcome.ordered.map((m) => {
      const source = submitted.find((s) => s.id === m.id);
      if (!source) throw new Error('ordered a move that was not submitted');
      return { id: m.id, move: wireOf.get(m.id), key: source.key };
    });

    const superseded: AppliedMove[] = supersededRevisions(candidates, winners).map((c) => ({
      id: c.id,
      move: { type: c.envelope.type, data: c.envelope.data },
      key: keyOf.get(c.id),
    }));

    stateEvents.push(
      await gm.signEvent({
        ...buildDelta({
          gameId,
          seq: outcome.seq,
          awaiting: outcome.awaiting,
          content: {
            seq: outcome.seq,
            applied,
            patch: outcome.patch as unknown,
            system: round.system ?? null,
            superseded: superseded.length ? superseded : undefined,
          },
        }),
        pubkey: gm.pubkey,
        created_at: now,
      }),
    );
  }

  const end = await gm.signEvent({
    ...buildEnd({
      gameId,
      players: seats,
      content: {
        result: engine.result ?? { winners: [] },
        seed: bytesToHex(commitment.seed),
        salt: bytesToHex(commitment.salt),
      },
    }),
    pubkey: gm.pubkey,
    created_at: startedAt + (options.rounds.length + 1) * 60,
  });

  return {
    gameId,
    gmPubkey: gm.pubkey,
    seats,
    start,
    moves: moveEvents,
    states: [...stateEvents, end],
    end,
    finalState: engine.state,
    seed: commitment.seed,
  };
}
