import { describe, expect, it, vi } from 'vitest';
import { createStore, select } from './store.js';
import { moveSyncState, needsMyMove } from './snapshot.js';

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

  const pending = (rev: number, final: boolean) => ({
    id: 'ff',
    seq: 3,
    move: {},
    submittedAt: 0,
    rev,
    final,
  });

  it('goes false once my final move is in flight, even though the GM still awaits me', () => {
    // The whole reason this is not `awaiting.includes(me)`: in a simultaneous
    // round the GM keeps me p-tagged until the round closes.
    expect(needsMyMove([me, 'bb'], me, pending(0, true))).toBe(false);
  });

  it('stays true while I am still revising', () => {
    // A non-final revision is a move under construction. Treating the first
    // publication as "done" would switch the UI off while the player is still
    // queueing actions — the exact failure revisions exist to avoid.
    expect(needsMyMove([me, 'bb'], me, pending(2, false))).toBe(true);
  });

  it('is false when I am not in the round', () => {
    expect(needsMyMove(['bb'], me, null)).toBe(false);
  });

  it('is false for a spectator with no identity', () => {
    expect(needsMyMove([me], undefined, null)).toBe(false);
  });
});

describe('moveSyncState', () => {
  const pending = { id: 'ff', seq: 3, move: {}, submittedAt: 0, rev: 2, final: false };

  it('is local before anything is published', () => {
    expect(moveSyncState(null, -1)).toBe('local');
  });

  it('is sent while the GM has acknowledged nothing', () => {
    expect(moveSyncState(pending, -1)).toBe('sent');
  });

  it('is sent while the GM has only acknowledged an earlier revision', () => {
    expect(moveSyncState(pending, 1)).toBe('sent');
  });

  it('is received once the GM acknowledges this revision', () => {
    expect(moveSyncState(pending, 2)).toBe('received');
  });

  it('is received when the GM has acknowledged a later revision than I track', () => {
    // Can happen after a reconnect drops the local view of what was published.
    expect(moveSyncState(pending, 5)).toBe('received');
  });
});
