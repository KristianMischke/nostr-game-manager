/**
 * NIP-44 v2.
 *
 * The primitives — secp256k1, sha256, hmac, hkdf, chacha20 — come from the
 * audited `@noble` packages; what is implemented here is only the *composition*
 * NIP-44 specifies on top of them. That composition is unavoidable: core cannot
 * depend on a nostr library (it must stay portable), and a C#/Rust/Python port
 * has to reproduce exactly these steps anyway.
 *
 * The whole file is pinned by the official NIP-44 vectors, vendored at
 * `vectors/nip44/official.json` and run in `nip-gm-testing`. Do not change
 * anything here without those staying green.
 *
 * NIP-GM uses this for join codes, hidden moves and private state. Note it
 * encrypts content but not metadata — see NIP-GM §Private state for when that
 * is acceptable and when NIP-59 gift wrap is the right escape hatch.
 */
import { chacha20 } from '@noble/ciphers/chacha';
import { secp256k1 } from '@noble/curves/secp256k1';
import { expand as hkdfExpand, extract as hkdfExtract } from '@noble/hashes/hkdf';
import { hmac } from '@noble/hashes/hmac';
import { sha256 } from '@noble/hashes/sha256';
import { concatBytes, randomBytes, utf8ToBytes } from '@noble/hashes/utils';
import type { Hex } from '../types.js';
import { base64Decode, base64Encode } from './base64.js';

const VERSION = 2;
const SALT = /* @__PURE__ */ utf8ToBytes('nip44-v2');

const MIN_PLAINTEXT = 1;
const MAX_PLAINTEXT = 65535;
/** version(1) + nonce(32) + ciphertext(>=32) + mac(32) */
const MIN_PAYLOAD = 99;
const MAX_PAYLOAD = 65603;

/**
 * The NIP-44 conversation key for a keypair and a peer.
 *
 * Symmetric by construction: `ECDH(a_priv, b_pub)` and `ECDH(b_priv, a_pub)`
 * agree. That symmetry is what lets a GM reveal a hidden move's key without the
 * player's cooperation — it derives the same value the player used
 * (NIP-GM §Hidden Information).
 */
export function conversationKey(privkey: Uint8Array, peerPubkey: Hex): Uint8Array {
  // Nostr pubkeys are x-only; '02' picks the even-Y point, per NIP-44.
  const shared = secp256k1.getSharedSecret(privkey, '02' + peerPubkey);
  return hkdfExtract(sha256, shared.subarray(1, 33), SALT);
}

export interface MessageKeys {
  chachaKey: Uint8Array;
  chachaNonce: Uint8Array;
  hmacKey: Uint8Array;
}

export function messageKeys(convKey: Uint8Array, nonce: Uint8Array): MessageKeys {
  if (convKey.length !== 32) throw new Error('invalid conversation key length');
  if (nonce.length !== 32) throw new Error('invalid nonce length');
  const keys = hkdfExpand(sha256, convKey, nonce, 76);
  return {
    chachaKey: keys.subarray(0, 32),
    chachaNonce: keys.subarray(32, 44),
    hmacKey: keys.subarray(44, 76),
  };
}

/**
 * Padded length for a plaintext.
 *
 * Padding to power-of-two-derived buckets means an observer learns only the
 * bucket, not the exact length — which matters when move payloads are small and
 * their size would otherwise leak the move.
 */
export function calcPaddedLen(len: number): number {
  if (!Number.isSafeInteger(len) || len < 1) throw new Error('expected positive integer');
  if (len <= 32) return 32;
  const nextPower = 1 << (Math.floor(Math.log2(len - 1)) + 1);
  const chunk = nextPower <= 256 ? 32 : nextPower / 8;
  return chunk * (Math.floor((len - 1) / chunk) + 1);
}

export function pad(plaintext: string): Uint8Array {
  const unpadded = utf8ToBytes(plaintext);
  const len = unpadded.length;
  if (len < MIN_PLAINTEXT || len > MAX_PLAINTEXT) throw new Error('invalid plaintext length');
  const prefix = new Uint8Array(2);
  new DataView(prefix.buffer).setUint16(0, len, false);
  const suffix = new Uint8Array(calcPaddedLen(len) - len);
  return concatBytes(prefix, unpadded, suffix);
}

export function unpad(padded: Uint8Array): string {
  if (padded.length < 2) throw new Error('invalid padding');
  const len = new DataView(padded.buffer, padded.byteOffset, padded.byteLength).getUint16(0, false);
  const unpadded = padded.subarray(2, 2 + len);
  if (len < MIN_PLAINTEXT || unpadded.length !== len || padded.length !== 2 + calcPaddedLen(len)) {
    throw new Error('invalid padding');
  }
  return new TextDecoder().decode(unpadded);
}

function hmacAad(key: Uint8Array, message: Uint8Array, aad: Uint8Array): Uint8Array {
  if (aad.length !== 32) throw new Error('invalid AAD length');
  return hmac(sha256, key, concatBytes(aad, message));
}

/** Constant-time comparison, so a MAC check cannot be probed by timing. */
function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export function encrypt(
  plaintext: string,
  convKey: Uint8Array,
  nonce: Uint8Array = randomBytes(32),
): string {
  const { chachaKey, chachaNonce, hmacKey } = messageKeys(convKey, nonce);
  const ciphertext = chacha20(chachaKey, chachaNonce, pad(plaintext));
  const mac = hmacAad(hmacKey, ciphertext, nonce);
  return base64Encode(concatBytes(new Uint8Array([VERSION]), nonce, ciphertext, mac));
}

export function decrypt(payload: string, convKey: Uint8Array): string {
  // A '#' prefix is NIP-44's reserved marker for a future, unknown version.
  if (payload.startsWith('#')) throw new Error('unknown encryption version');
  if (payload.length < 132 || payload.length > 87472) throw new Error('invalid payload size');

  const decoded = base64Decode(payload);
  if (decoded.length < MIN_PAYLOAD || decoded.length > MAX_PAYLOAD) {
    throw new Error('invalid payload size');
  }
  if (decoded[0] !== VERSION) throw new Error(`unknown encryption version ${decoded[0]}`);

  const nonce = decoded.subarray(1, 33);
  const ciphertext = decoded.subarray(33, decoded.length - 32);
  const mac = decoded.subarray(decoded.length - 32);

  const { chachaKey, chachaNonce, hmacKey } = messageKeys(convKey, nonce);
  if (!equalBytes(hmacAad(hmacKey, ciphertext, nonce), mac)) throw new Error('invalid MAC');

  return unpad(chacha20(chachaKey, chachaNonce, ciphertext));
}

/**
 * Non-throwing decrypt.
 *
 * A client will encounter private events it cannot read — addressed to someone
 * else, or from a game it has since left — and that is ordinary, not an error
 * worth unwinding a session over.
 */
export function tryDecrypt(payload: string, convKey: Uint8Array): string | undefined {
  try {
    return decrypt(payload, convKey);
  } catch {
    return undefined;
  }
}
