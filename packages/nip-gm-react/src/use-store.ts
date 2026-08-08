/**
 * The entire React binding, in one function.
 *
 * Game state lives in a `nip-gm-client` store, not in React. This hook is the
 * only bridge, which is what lets the same sessions drive the GM daemon, the
 * verifier, headless tests and (later) a Solid binding with nothing shared but
 * the store contract.
 *
 * `useSyncExternalStore` — rather than `useState` + an effect — is what keeps
 * concurrent React from tearing: a render that begins mid-delta still sees one
 * consistent snapshot.
 */
import { useMemo, useSyncExternalStore } from 'react';
import { select, type ReadableStore } from 'nip-gm-client';

export function useStore<T>(store: ReadableStore<T>): T {
  // Passed unbound; createStore defines these as closures, not methods.
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}

/**
 * Subscribe to a slice of a store.
 *
 * Not optional polish for a simultaneous-round game: every player acts every
 * tick, so a component on the whole snapshot re-renders each time any
 * opponent's move lands. Selecting with an equality check confines re-renders
 * to components whose data actually moved.
 *
 * `selector` and `equals` are read once per store identity — pass stable
 * references (module scope or `useCallback`), as changing them mid-life will
 * not resubscribe.
 */
export function useStoreSelector<T, S>(
  store: ReadableStore<T>,
  selector: (value: T) => S,
  equals?: (a: S, b: S) => boolean,
): S {
  // Memoised on the store alone: the derived store caches the selected value,
  // and rebuilding it per render would discard that cache every time.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const derived = useMemo(() => select(store, selector, equals), [store]);
  return useStore(derived);
}
