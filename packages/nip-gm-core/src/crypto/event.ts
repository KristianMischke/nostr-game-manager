/**
 * Event ids and signatures (NIP-01).
 *
 * NIP-GM leans on the event id being a commitment: the game id *is* the id of
 * the start event, and a player's signed move ciphertext is their commitment to
 * that move. Both only hold because the id covers the tags — including `p` tag
 * order, which is seat order.
 */
import { schnorr, secp256k1 } from '@noble/curves/secp256k1';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils';
import type { Hex, NostrEvent, UnsignedEvent } from '../types.js';

/**
 * The NIP-01 serialization an event id is taken over.
 *
 * `JSON.stringify` produces exactly the escaping NIP-01 mandates for the
 * characters that need it, and array serialization has no key-order freedom to
 * get wrong — which is why the id is stable across implementations while
 * arbitrary object serialization would not be.
 */
export function serializeEvent(event: UnsignedEvent): string {
  return JSON.stringify([
    0,
    event.pubkey,
    event.created_at,
    event.kind,
    event.tags,
    event.content,
  ]);
}

export function getEventHash(event: UnsignedEvent): Hex {
  return bytesToHex(sha256(utf8ToBytes(serializeEvent(event))));
}

/** x-only public key for a 32-byte secret. */
export function getPublicKey(privkey: Uint8Array): Hex {
  return bytesToHex(schnorr.getPublicKey(privkey));
}

/** A random secret key, for throwaway per-game identities and ephemeral keys. */
export function generateSecretKey(): Uint8Array {
  return secp256k1.utils.randomPrivateKey();
}

/**
 * Compute the id and sign, in one step.
 *
 * Exposed so that signer implementations do not each have to reach for the
 * curve library and re-derive the NIP-01 hashing rules.
 */
export function signEvent(event: UnsignedEvent, privkey: Uint8Array): NostrEvent {
  // The signer owns `pubkey`; a caller's guess must not survive into the id.
  const unsigned: UnsignedEvent = { ...event, pubkey: getPublicKey(privkey) };
  const id = getEventHash(unsigned);
  return { ...unsigned, id, sig: bytesToHex(schnorr.sign(id, privkey)) };
}

/**
 * Verify an event's id and signature.
 *
 * Both, deliberately: a valid signature over a *different* id would let a GM's
 * signature be replayed onto altered tags, which is precisely what NIP-GM's
 * audit trail must rule out.
 */
export function verifyEvent(event: NostrEvent): boolean {
  try {
    if (getEventHash(event) !== event.id) return false;
    return schnorr.verify(event.sig, event.id, event.pubkey);
  } catch {
    return false;
  }
}
