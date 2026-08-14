/**
 * The `Signer` and `KeySigner` ports.
 *
 * Note the split, which is load-bearing rather than cosmetic (see the doc
 * comments in `nip-gm-core/ports.ts`):
 *
 * - {@link fromNDKSigner} covers **players**. Anything NDK can sign with —
 *   a NIP-07 extension, a NIP-46 bunker, a local key — satisfies `Signer`.
 * - {@link createKeySigner} covers **GMs**, and requires a raw local key.
 *   A GM must publish `ECDH(gm_privkey, ephemeral_pubkey)` in its round-closing
 *   deltas so anyone can decrypt the committed moves and audit the round. Remote
 *   signers do not expose conversation keys, so a GM cannot be a NIP-46 user.
 *   That is a protocol constraint, not a limitation of this file.
 */
import type NDK from '@nostr-dev-kit/ndk';
import { NDKNip07Signer, NDKPrivateKeySigner, type NDKSigner, nip19 } from '@nostr-dev-kit/ndk';
import {
  conversationKey,
  decrypt,
  encrypt,
  getEventHash,
  getPublicKey,
  signEvent as signWithKey,
  type Hex,
  type KeySigner,
  type NostrEvent,
  type Signer,
  type UnsignedEvent,
} from 'nip-gm-core';

/**
 * Adapt any `NDKSigner` to the `Signer` port.
 *
 * The event id is computed here with core's `getEventHash` rather than taken
 * from NDK. Both implement the same NIP-01 serialization, but the id is what
 * NIP-GM treats as a commitment — the game id *is* the start event's id, and a
 * move's id is what breaks revision ties — so it is computed by the same code
 * that will later verify it.
 *
 * @param ndk needed only to mint the `NDKUser` values NDK's encrypt/decrypt
 *   take as recipients.
 */
export function fromNDKSigner(ndk: NDK, signer: NDKSigner): Signer {
  return {
    async getPublicKey(): Promise<Hex> {
      return (await signer.user()).pubkey;
    },

    async signEvent(event: UnsignedEvent): Promise<NostrEvent> {
      // The signer owns the pubkey; a caller's guess must not survive into the
      // id, or the id would not match what the signature covers.
      const pubkey = (await signer.user()).pubkey;
      const unsigned: UnsignedEvent = { ...event, pubkey };
      const id = getEventHash(unsigned);
      const sig = await signer.sign({ ...unsigned, id });
      return { ...unsigned, id, sig };
    },

    async nip44Encrypt(peerPubkey: Hex, plaintext: string): Promise<string> {
      return signer.encrypt(ndk.getUser({ pubkey: peerPubkey }), plaintext, 'nip44');
    },

    async nip44Decrypt(peerPubkey: Hex, ciphertext: string): Promise<string> {
      return signer.decrypt(ndk.getUser({ pubkey: peerPubkey }), ciphertext, 'nip44');
    },
  };
}

/** A player `Signer` backed by a NIP-07 browser extension. */
export function createNip07Signer(ndk: NDK): Signer {
  return fromNDKSigner(ndk, new NDKNip07Signer(undefined, ndk));
}

/**
 * A `KeySigner` holding a raw secret key — what a GM needs.
 *
 * Accepts an `nsec`, 64-char hex, or raw bytes. Everything is implemented with
 * core's crypto rather than NDK's, because `conversationKey` has no NDK
 * equivalent and splitting the two would risk the encrypt path and the reveal
 * path disagreeing about what key was used.
 */
export function createKeySigner(secret: string | Uint8Array): KeySigner {
  const privkey = toSecretBytes(secret);
  const pubkey = getPublicKey(privkey);

  return {
    async getPublicKey(): Promise<Hex> {
      return pubkey;
    },

    async signEvent(event: UnsignedEvent): Promise<NostrEvent> {
      return signWithKey(event, privkey);
    },

    async nip44Encrypt(peerPubkey: Hex, plaintext: string): Promise<string> {
      return encrypt(plaintext, conversationKey(privkey, peerPubkey));
    },

    async nip44Decrypt(peerPubkey: Hex, ciphertext: string): Promise<string> {
      return decrypt(ciphertext, conversationKey(privkey, peerPubkey));
    },

    async conversationKey(peerPubkey: Hex): Promise<Uint8Array> {
      return conversationKey(privkey, peerPubkey);
    },
  };
}

/**
 * The same local key as an `NDKSigner`, for apps that also want NDK to sign
 * ordinary (non-NIP-GM) events with it — a profile, a chat message.
 */
export function createNDKKeySigner(secret: string | Uint8Array): NDKPrivateKeySigner {
  return new NDKPrivateKeySigner(toSecretBytes(secret));
}

function toSecretBytes(secret: string | Uint8Array): Uint8Array {
  if (secret instanceof Uint8Array) {
    if (secret.length !== 32) throw new Error('secret key must be 32 bytes');
    return secret;
  }

  if (secret.startsWith('nsec')) {
    const decoded = nip19.decode(secret);
    if (decoded.type !== 'nsec') throw new Error('expected an nsec');
    return decoded.data as Uint8Array;
  }

  if (!/^[0-9a-f]{64}$/i.test(secret)) {
    throw new Error('secret key must be an nsec or 64-char hex');
  }
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) bytes[i] = Number.parseInt(secret.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}
