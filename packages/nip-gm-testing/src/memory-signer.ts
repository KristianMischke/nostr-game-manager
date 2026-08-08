/**
 * A local in-memory `KeySigner`.
 *
 * Holds a raw secret key, so it can derive NIP-44 conversation keys — which is
 * what a GM needs and what a NIP-46 remote signer generally cannot give. The
 * same class serves players in tests; production player clients would use a
 * NIP-07 or NIP-46 signer that satisfies the narrower `Signer` interface.
 */
import {
  conversationKey,
  decrypt,
  encrypt,
  generateSecretKey,
  getPublicKey,
  signEvent,
  type Hex,
  type KeySigner,
  type NostrEvent,
  type UnsignedEvent,
} from 'nip-gm-core';

export class MemorySigner implements KeySigner {
  readonly privkey: Uint8Array;
  readonly pubkey: Hex;

  constructor(privkey: Uint8Array = generateSecretKey()) {
    this.privkey = privkey;
    this.pubkey = getPublicKey(privkey);
  }

  async getPublicKey(): Promise<Hex> {
    return this.pubkey;
  }

  async signEvent(event: UnsignedEvent): Promise<NostrEvent> {
    return signEvent(event, this.privkey);
  }

  async nip44Encrypt(peerPubkey: Hex, plaintext: string): Promise<string> {
    return encrypt(plaintext, conversationKey(this.privkey, peerPubkey));
  }

  async nip44Decrypt(peerPubkey: Hex, ciphertext: string): Promise<string> {
    return decrypt(ciphertext, conversationKey(this.privkey, peerPubkey));
  }

  async conversationKey(peerPubkey: Hex): Promise<Uint8Array> {
    return conversationKey(this.privkey, peerPubkey);
  }
}

/** Deterministic signers for readable tests: `signerFromSeed(1)` is stable. */
export function signerFromSeed(n: number): MemorySigner {
  const key = new Uint8Array(32);
  new DataView(key.buffer).setUint32(28, n, false);
  return new MemorySigner(key);
}
