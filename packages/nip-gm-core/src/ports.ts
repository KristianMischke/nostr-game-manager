/**
 * The dependency-injection seam. Everything that touches the outside world —
 * relays, keys, the clock — enters through these interfaces.
 *
 * They live in core (rather than in the client) because both `nip-gm-gm` and
 * `nip-gm-nostr` need them: the adapter implements them, the daemon and client
 * consume them. They are type declarations only, so core stays I/O-free.
 */
import type { Filter, Hex, NostrEvent, UnsignedEvent } from './types.js';

export interface Subscription {
  /** Idempotent: calling more than once must be safe (React StrictMode double-mounts). */
  close(): void;
}

export interface SubscribeHandlers {
  onEvent(event: NostrEvent): void;
  /** Fired once the relay signals end-of-stored-events, if the transport can tell. */
  onEose?(): void;
}

export interface Transport {
  publish(event: NostrEvent): Promise<void>;
  subscribe(filters: Filter[], handlers: SubscribeHandlers): Subscription;
  /** One-shot query for stored events; resolves at EOSE. */
  query(filters: Filter[]): Promise<NostrEvent[]>;
}

/**
 * What a player needs. Satisfiable by a NIP-07 browser extension or a NIP-46
 * remote signer, which is what makes per-game throwaway keys practical
 * (NIP-GM §Security and Privacy Notes).
 */
export interface Signer {
  getPublicKey(): Promise<Hex>;
  signEvent(event: UnsignedEvent): Promise<NostrEvent>;
  nip44Encrypt(peerPubkey: Hex, plaintext: string): Promise<string>;
  nip44Decrypt(peerPubkey: Hex, ciphertext: string): Promise<string>;
}

/**
 * What a GM needs, additionally: the raw NIP-44 conversation key.
 *
 * The GM reveals `ECDH(gm_privkey, ephemeral_pubkey)` in round-closing deltas
 * and in the end event's `key_reveals`, which is what lets anyone decrypt the
 * committed moves and audit the round (NIP-GM §Hidden Information). Remote
 * signers generally do not expose this, so a GM requires a local key. That
 * constraint is expressed here in the type system rather than discovered at
 * integration time.
 */
export interface KeySigner extends Signer {
  conversationKey(peerPubkey: Hex): Promise<Uint8Array>;
}

/**
 * Injected time. The GM must never branch on ambient wall-clock: NIP-GM
 * §Game Modules requires timeouts be materialized as signed system inputs so
 * that replay is deterministic. Injecting the clock keeps tests instant and
 * makes accidental `Date.now()` use visible in review.
 */
export interface Clock {
  /** Unix seconds, matching `created_at`. */
  now(): number;
  /** Resolves after `seconds`; the returned handle cancels it. */
  setTimeout(seconds: number, fn: () => void): { cancel(): void };
}

export const systemClock: Clock = {
  now: () => Math.floor(Date.now() / 1000),
  setTimeout: (seconds, fn) => {
    const t = setTimeout(fn, seconds * 1000);
    return { cancel: () => clearTimeout(t) };
  },
};
