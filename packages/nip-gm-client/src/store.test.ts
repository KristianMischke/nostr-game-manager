import { describe, expect, it, vi } from 'vitest';
import { createStore, select } from './store.js';
import { needsMyMove } from './snapshot.js';

describe('createStore', () => {
  it('returns a referentially stable snapshot between changes', () => {
    // The invariant useSyncExternalStore depends on; violating it loops React.
    const store = createStore({ n: 1 });
    expect(store.getSnapshot()).toBe(store.getSnapshot());
  });

  it('notifies subscribers on change', () => {
    const store = createStore({ n: 1 });
    const listener = vi.fn();
    store.subscribe(listener);
    store.set({ n: 2 });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('does not notify when the snapshot is unchanged', () => {
    const store = createStore({ n: 1 });
    const listener = vi.fn();
    store.subscribe(listener);
    store.set(store.getSnapshot());
    expect(listener).not.toHaveBeenCalled();
  });

  it('has an idempotent unsubscribe (StrictMode double-unmounts)', () => {
    const store = createStore({ n: 1 });
    const listener = vi.fn();
    const unsub = store.subscribe(listener);
    unsub();
    unsub();
    store.set({ n: 2 });
    expect(listener).not.toHaveBeenCalled();
  });

  it('tolerates a listener unsubscribing during notification', () => {
    const store = createStore({ n: 1 });
    const seen: string[] = [];
    const unsubA = store.subscribe(() => {
      seen.push('a');
      unsubA();
    });
    store.subscribe(() => seen.push('b'));
    store.set({ n: 2 });
    expect(seen).toEqual(['a', 'b']);
  });
});

describe('select', () => {
  it('does not notify when the selected slice is unchanged', () => {
    // The case that matters: an opponent's move lands, my slice is untouched.
    const store = createStore({ board: 'x', scores: { me: 0 } });
    const board = select(store, (s) => s.board);
    const listener = vi.fn();
    board.subscribe(listener);

    store.set({ board: 'x', scores: { me: 5 } });
    expect(listener).not.toHaveBeenCalled();

    store.set({ board: 'y', scores: { me: 5 } });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('keeps the selected value referentially stable under a custom equality', () => {
    const store = createStore({ seats: ['a', 'b'], seq: 1 });
    const seats = select(
      store,
      (s) => s.seats,
      (a, b) => a.length === b.length && a.every((v, i) => v === b[i]),
    );
    const first = seats.getSnapshot();
    store.set({ seats: ['a', 'b'], seq: 2 });
    expect(seats.getSnapshot()).toBe(first);
  });
});

describe('needsMyMove', () => {
  const me = 'aa';

  it('is true when I am awaited and have not submitted', () => {
    expect(needsMyMove([me, 'bb'], me, null)).toBe(true);
  });

  it('goes false once my move is in flight, even though the GM still awaits me', () => {
    // The whole reason this is not `awaiting.includes(me)`: in a simultaneous
    // round the GM keeps me p-tagged until the round closes.
    const pending = { id: 'ff', seq: 3, move: {}, submittedAt: 0 };
    expect(needsMyMove([me, 'bb'], me, pending)).toBe(false);
  });

  it('is false when I am not in the round', () => {
    expect(needsMyMove(['bb'], me, null)).toBe(false);
  });

  it('is false for a spectator with no identity', () => {
    expect(needsMyMove([me], undefined, null)).toBe(false);
  });
});
