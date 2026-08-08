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
 */
import type { AnyGameModule, Clock, KeySigner, Transport } from 'nip-gm-core';

export interface GMPolicy {
  /** Who may ask this GM to open a lobby (NIP-GM §Game Messages — GM policy). */
  allowCreate: 'anyone' | 'allowlist' | 'nobody';
  allowlist?: string[];
  /** Omit for unlimited. */
  maxConcurrentGames?: number;
}

export interface GMOptions {
  modules: AnyGameModule[];
  /**
   * Must be a KeySigner, not a plain Signer: the GM reveals raw NIP-44
   * conversation keys in round-closing deltas, so it needs a local key. A
   * NIP-46 remote signer cannot host a game.
   */
  signer: KeySigner;
  transport: Transport;
  relays: string[];
  policy: GMPolicy;
  /** Injected so tests run instantly and wall-clock never leaks into replay. */
  clock?: Clock;
}

export interface GM {
  start(): Promise<void>;
  stop(): Promise<void>;
}

/** Not yet implemented — milestone 5. The signature is the contract the rest of the plan builds toward. */
export function createGM(_options: GMOptions): GM {
  throw new Error('createGM is not implemented yet (milestone 5: GM runner).');
}
