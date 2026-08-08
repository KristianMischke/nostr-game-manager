/**
 * A minimal observable store.
 *
 * This is the seam that keeps game state out of any UI framework. Sessions own
 * a store; `nip-gm-react` bridges it with `useSyncExternalStore` and a future
 * `nip-gm-solid` binding would be a similarly thin adapter. The GM daemon, the
 * verifier and headless tests use the same sessions with no framework present
 * at all.
 *
 * Two invariants exist specifically to satisfy `useSyncExternalStore`:
 *
 * 1. `getSnapshot()` returns a **referentially stable** value between changes.
 *    A store that built a fresh object per call would put React into an
 *    infinite render loop, so snapshots are replaced only in `set`.
 * 2. `subscribe()` returns an idempotent unsubscribe, and double-subscribing
 *    the same listener is harmless — React StrictMode double-mounts effects in
 *    development.
 */

export type Listener = () => void;
export type Unsubscribe = () => void;

export interface ReadableStore<T> {
  getSnapshot(): T;
  subscribe(listener: Listener): Unsubscribe;
}

export interface WritableStore<T> extends ReadableStore<T> {
  set(next: T): void;
  update(fn: (current: T) => T): void;
}

export function createStore<T>(initial: T): WritableStore<T> {
  let snapshot = initial;
  const listeners = new Set<Listener>();

  // Every method is defined as a closure rather than using `this`, so callers
  // may destructure freely — `useSyncExternalStore(store.subscribe, ...)` passes
  // these unbound.
  const getSnapshot = (): T => snapshot;

  const subscribe = (listener: Listener): Unsubscribe => {
    listeners.add(listener);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      listeners.delete(listener);
    };
  };

  const set = (next: T): void => {
    // Skip the notify when nothing actually changed, so a delta that does not
    // affect a slice cannot cause a re-render.
    if (Object.is(next, snapshot)) return;
    snapshot = next;
    // Copy first: a listener may unsubscribe itself during notification.
    for (const listener of [...listeners]) listener();
  };

  return { getSnapshot, subscribe, set, update: (fn) => set(fn(snapshot)) };
}

/**
 * A derived read-only view over part of a store.
 *
 * This is what keeps a busy game usable: in a simultaneous-round game every
 * player acts every tick, so a component subscribed to the whole snapshot
 * re-renders on every opponent's move landing. Selecting a slice with an
 * equality check confines that to components whose data actually moved.
 *
 * The selected value is cached so it stays referentially stable while `equals`
 * reports it unchanged.
 */
export function select<T, S>(
  source: ReadableStore<T>,
  selector: (value: T) => S,
  equals: (a: S, b: S) => boolean = Object.is,
): ReadableStore<S> {
  let cachedFrom = source.getSnapshot();
  let cached = selector(cachedFrom);

  const current = (): S => {
    const next = source.getSnapshot();
    if (Object.is(next, cachedFrom)) return cached;
    cachedFrom = next;
    const selected = selector(next);
    if (!equals(cached, selected)) cached = selected;
    return cached;
  };

  return {
    getSnapshot: current,
    subscribe(listener) {
      let previous = current();
      return source.subscribe(() => {
        const next = current();
        if (equals(previous, next)) return;
        previous = next;
        listener();
      });
    },
  };
}
