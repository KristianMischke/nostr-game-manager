import { describe, expect, it } from 'vitest';
import type { Rng, RngStream } from '../module/context.js';
import type { ResolvedMove } from '../module/types.js';
import { isCanonicalOrder, orderRound, type OrderingContext } from './ordering.js';

/** Deterministic stand-in for the real HKDF stream; reverses, so it is order-sensitive. */
const stubRng: Rng = {
  at: (): RngStream => ({
    bytes: (n) => new Uint8Array(n),
    int: () => 0,
    shuffle: <T>(items: readonly T[]): T[] => [...items].reverse(),
  }),
};

const seats = ['aa', 'bb', 'cc'];
const ctx: OrderingContext = { seq: 7, rng: stubRng, seats };

const moves: ResolvedMove<string>[] = [
  { id: 'ff', player: 'aa', seat: 0, move: 'first-seat' },
  { id: '11', player: 'cc', seat: 2, move: 'last-seat' },
  { id: '77', player: 'bb', seat: 1, move: 'mid-seat' },
];

const ids = (ms: ResolvedMove<string>[]) => ms.map((m) => m.id);

describe('orderRound', () => {
  it('orders by ascending event id', () => {
    expect(ids(orderRound({ kind: 'event-id' }, moves, ctx))).toEqual(['11', '77', 'ff']);
  });

  it('orders by seat, not arrival', () => {
    expect(ids(orderRound({ kind: 'seat' }, moves, ctx))).toEqual(['ff', '77', '11']);
  });

  it('shuffles a canonical base order, so arrival order cannot change the result', () => {
    const forward = ids(orderRound({ kind: 'shuffled' }, moves, ctx));
    const reversed = ids(orderRound({ kind: 'shuffled' }, [...moves].reverse(), ctx));
    expect(forward).toEqual(reversed);
    // stub shuffle reverses the id-sorted base
    expect(forward).toEqual(['ff', '77', '11']);
  });

  it('applies a custom comparator, tie-broken by id', () => {
    const order = { kind: 'custom' as const, compare: () => 0 };
    expect(ids(orderRound(order, moves, ctx))).toEqual(['11', '77', 'ff']);
  });

  it('resolves unseated players last', () => {
    const withGuest: ResolvedMove<string>[] = [
      ...moves,
      { id: '00', player: 'zz', seat: -1, move: 'hot-joined' },
    ];
    expect(ids(orderRound({ kind: 'seat' }, withGuest, ctx))).toEqual(['ff', '77', '11', '00']);
  });

  it('does not mutate its input', () => {
    const before = ids(moves);
    orderRound({ kind: 'seat' }, moves, ctx);
    expect(ids(moves)).toEqual(before);
  });

  it('is stable across repeated calls for every declarative variant', () => {
    for (const kind of ['seat', 'event-id', 'shuffled'] as const) {
      const a = ids(orderRound({ kind }, moves, ctx));
      const b = ids(orderRound({ kind }, [...moves].reverse(), ctx));
      expect(a, kind).toEqual(b);
    }
  });
});

describe('isCanonicalOrder', () => {
  it('accepts a correctly ordered round', () => {
    const ordered = orderRound({ kind: 'seat' }, moves, ctx);
    expect(isCanonicalOrder({ kind: 'seat' }, ordered, ctx)).toBe(true);
  });

  it('rejects a GM that published moves out of order', () => {
    const ordered = orderRound({ kind: 'seat' }, moves, ctx);
    expect(isCanonicalOrder({ kind: 'seat' }, [...ordered].reverse(), ctx)).toBe(false);
  });
});
