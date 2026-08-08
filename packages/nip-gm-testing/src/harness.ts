/**
 * Play a scripted game and emit the full signed event log.
 *
 * This is what turns an in-memory module into something the verifier can audit:
 * it does what a GM daemon will do — commit a seed, publish a start event,
 * collect per-round encrypted moves, close rounds with revealed keys, publish
 * the end reveal — but synchronously and with no relay involved.
 *
 * Milestone 5 replaces the orchestration with the real daemon; the event log it
 * produces should be indistinguishable.
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
  type AppliedMove,
  type GameModule,
  type Hex,
  type NostrEvent,
  type ResolvedMove,
  type SystemInput,
} from 'nip-gm-core';
import { bytesToHex } from '@noble/hashes/utils';
import type { MemorySigner } from './memory-signer.js';

/** What a player does in one round; `undefined` means they did not submit. */
export interface ScriptedRound<Move> {
  moves: { player: MemorySigner; move: Move; wire: { type: string; data: unknown } }[];
  system?: SystemInput | null;
  now?: number;
}

export interface HarnessOptions<Config, Move> {
  gm: MemorySigner;
  players: MemorySigner[];
  config: Config;
  rounds: ScriptedRound<Move>[];
  /** Fixed so logs are byte-reproducible across runs. */
  startedAt?: number;
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

  const commitment = createSeedCommitment();

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

  for (const [index, round] of options.rounds.entries()) {
    if (engine.isOver) break;

    const seq = engine.seq + 1;
    const now = round.now ?? startedAt + (index + 1) * 60;
    const prev = stateEvents.length ? stateEvents[stateEvents.length - 1].id : gameId;

    // --- players commit hidden moves under fresh per-round keys -------------
    const submitted: (ResolvedMove<Move> & { key: string })[] = [];

    for (const entry of round.moves) {
      const ephemeral = generateEphemeralKeypair();
      const convKey = playerConversationKey(ephemeral, gm.pubkey);
      const ciphertext = encrypt(
        formatMoveEnvelope({ seq, prev, type: entry.wire.type, data: entry.wire.data }),
        convKey,
      );

      const event = await entry.player.signEvent({
        ...buildMove(gameId, gm.pubkey, ciphertext, { ephemeral: ephemeral.pubkey }),
        pubkey: entry.player.pubkey,
        created_at: now - 1,
      });

      moveEvents.push(event);
      submitted.push({
        id: event.id,
        player: entry.player.pubkey,
        seat: seats.indexOf(entry.player.pubkey),
        move: entry.move,
        key: bytesToHex(convKey),
      });
    }

    // --- GM resolves and closes the round -----------------------------------
    const outcome = engine.applyRound(submitted, round.system ?? null, now);

    const applied: AppliedMove[] = outcome.ordered.map((m) => {
      const source = submitted.find((s) => s.id === m.id);
      if (!source) throw new Error('ordered a move that was not submitted');
      const wire = round.moves.find((e) => e.player.pubkey === source.player)?.wire;
      return { id: m.id, move: wire, key: source.key };
    });

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
