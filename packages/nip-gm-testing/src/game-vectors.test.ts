/**
 * Full-game replay vectors.
 *
 * A port that implements `nip-gm-core` and the Orders reference module should
 * replay this log and reproduce every patch, ordering and final state. It is
 * the end-to-end counterpart to the per-primitive vectors: the codec, the RNG
 * and the resolution order can each be individually correct while the engine
 * that composes them is not.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { canonicalJson, replay, type GameLog, type Hex } from 'nip-gm-core';
import { vectorsRoot } from './vectors.js';
import { ordersModule, type OrdersConfig, type OrdersMove } from './example/orders.js';

interface GameVector {
  module: { id: string; version: string; resolution_order: string };
  game_id: Hex;
  seats: Hex[];
  seed: string;
  config: OrdersConfig;
  rounds: GameLog<OrdersConfig, OrdersMove>['rounds'];
  expected: {
    final_seq: number;
    ordered_move_ids: string[][];
    patches: unknown[];
    awaiting: Hex[][];
    final_state: unknown;
  };
}

const vector: GameVector = JSON.parse(
  readFileSync(join(vectorsRoot(), 'games', 'orders.json'), 'utf8'),
);

const hexToBytes = (hex: string): Uint8Array =>
  Uint8Array.from(hex.match(/../g)!.map((h) => Number.parseInt(h, 16)));

describe('vectors/games/orders.json', () => {
  const log: GameLog<OrdersConfig, OrdersMove> = {
    gameId: vector.game_id,
    config: vector.config,
    seats: vector.seats,
    seed: hexToBytes(vector.seed),
    rounds: vector.rounds,
  };

  it('targets the module under test', () => {
    expect(vector.module.id).toBe(ordersModule.id);
    expect(vector.module.version).toBe(ordersModule.version);
    expect(vector.module.resolution_order).toBe(ordersModule.resolutionOrder.kind);
  });

  it('reproduces the final state', () => {
    const result = replay(ordersModule, log);
    expect(JSON.parse(canonicalJson(ordersModule.serialize(result.state)))).toEqual(
      vector.expected.final_state,
    );
    expect(result.seq).toBe(vector.expected.final_seq);
  });

  it('reproduces each round’s canonical move order', () => {
    // The seed-derived permutation is the part a port is most likely to get
    // subtly wrong while still producing a plausible game.
    const result = replay(ordersModule, log);
    expect(result.rounds.map((r) => r.ordered.map((m) => m.id))).toEqual(
      vector.expected.ordered_move_ids,
    );
  });

  it('reproduces each published patch', () => {
    const result = replay(ordersModule, log);
    expect(result.rounds.map((r) => JSON.parse(canonicalJson(r.patch)))).toEqual(
      vector.expected.patches.map((p) => JSON.parse(canonicalJson(p))),
    );
  });

  it('reproduces each round’s next actors', () => {
    const result = replay(ordersModule, log);
    expect(result.rounds.map((r) => r.awaiting)).toEqual(vector.expected.awaiting);
  });

  it('shuffles the resolution order away from arrival order at least once', () => {
    // Guards against a vector that would pass even for a port that ignored
    // resolution order entirely.
    const arrival = vector.rounds.map((r) => r.moves.map((m) => m.id));
    const resolved = vector.expected.ordered_move_ids;
    expect(arrival).not.toEqual(resolved);
  });
});
