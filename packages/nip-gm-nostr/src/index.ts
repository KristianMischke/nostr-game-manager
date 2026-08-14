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
 * ## Hosting a GM
 *
 * `nip-gm-gm`'s `bin/gm.ts` resolves its adapter package by name and expects
 * exactly `createTransport({ relays })` and `createKeySigner(secret)`. Those
 * names are therefore API, not incidental.
 *
 * ```ts
 * const gm = createGM({
 *   modules: [myGameModule],
 *   signer: createKeySigner(process.env.GM_NSEC!),
 *   transport: createTransport({ relays: ['wss://relay.example'] }),
 *   policy: { allowCreate: 'anyone' },
 * });
 * await gm.start();
 * ```
 *
 * ## Playing as a client
 *
 * ```ts
 * const transport = createTransport({ relays, ndk });   // share the app's NDK
 * const signer = fromNDKSigner(ndk, new NDKNip07Signer());
 * const session = createGameSession({ transport, signer, module, gm, gameId });
 * ```
 *
 * Milestone 6.
 */
export * from './event.js';
export * from './transport.js';
export * from './signers.js';
