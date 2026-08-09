/**
 * GM daemon runtime.
 *
 * The daemon is a **library first, executable second**: plug in modules, a
 * signer and a transport, and it runs. The intended integration is a ~20-line
 * package of your own —
 *
 * ```ts
 * import { createGM } from 'nip-gm-gm';
 * import { NdkTransport, NsecSigner } from 'nip-gm-nostr';
 * import { myGameModule } from 'my-game-module';
 *
 * const gm = createGM({
 *   modules: [myGameModule],
 *   signer: new NsecSigner(process.env.GM_NSEC!),
 *   transport: new NdkTransport({ relays: ['wss://relay.example'] }),
 *   policy: { allowCreate: 'allowlist', allowlist: [], maxConcurrentGames: 50 },
 * });
 * await gm.start();
 * ```
 *
 * — while `bin/gm.ts` wraps the same call for the config-file case, resolving
 * module packages by name so a published module can be hosted without writing
 * any code.
 *
 * The GM key never belongs in committed configuration. `bin/gm.ts` reads it from
 * `GM_NSEC` or a key file for that reason, and the config schema has no field
 * for it at all.
 */
export * from './policy.js';
export * from './lobby-manager.js';
export * from './runner.js';
export * from './gm.js';
