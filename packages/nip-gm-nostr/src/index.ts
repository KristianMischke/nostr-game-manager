/**
 * Concrete bindings for the `Transport` and `KeySigner` ports, over NDK.
 *
 * NDK is a *peer* dependency, pinned to the version already used across the
 * author's other projects, so an app that already has an NDK instance shares
 * one relay pool rather than being handed a second.
 *
 * Everything above this package speaks only the port interfaces from
 * `nip-gm-core`, so swapping in a leaner `nostr-tools` SimplePool binding for
 * the daemon later is a contained change.
 *
 * Milestone 6.
 */
export {};
