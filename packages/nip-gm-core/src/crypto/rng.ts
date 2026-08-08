/**
 * Deterministic, addressed randomness.
 *
 * NIP-GM §Hidden Information requires that every shuffle and roll derive
 * deterministically from the committed seed, so that revealing the seed lets
 * anyone recompute the whole game. This is that derivation.
 *
 * ## Construction (ports must match exactly)
 *
 * ```
 * prk        = HKDF-Extract(SHA-256, IKM = seed, salt = UTF8("nip-gm-rng-v1"))
 * streamKey  = HKDF-Expand(SHA-256, PRK = prk, info = UTF8(gameId | seq | label), L = 32)
 * block(i)   = HMAC-SHA256(streamKey, UInt32BE(i))
 * stream     = block(0) || block(1) || block(2) || ...
 * ```
 *
 * where `info` is the three fields joined by `'|'` and `seq` is rendered as
 * decimal ASCII with no padding.
 *
 * HMAC in counter mode rather than a single HKDF-Expand because expand caps at
 * 255·32 bytes; a long shuffle would hit that ceiling, and a scheme that changes
 * shape at a length boundary is a portability trap.
 *
 * ## Why addressing matters
 *
 * A stream is named by `(seq, label)` rather than drawn from an implicit
 * sequence. Two consequences:
 *
 * - **The GM cannot grind.** It does not get to sample repeatedly and keep a
 *   favourable draw, because an auditor recomputes the stream at exactly the
 *   address the module asked for. An implicit counter would let a GM vary how
 *   many draws it made and thereby move the result.
 * - **Future rounds are computable now.** `at(seq + 3, 'storm')` is fully
 *   determined once the seed is committed but unknowable until reveal, which is
 *   what lets a module schedule a random event several turns ahead — and even
 *   announce it publicly — while staying verifiable.
 *
 * `at()` is a pure function of its address: calling it twice yields the same
 * values both times, starting from the beginning of the stream. A stream
 * instance is stateful as you draw from it, but obtaining one never is.
 */
import { expand as hkdfExpand, extract as hkdfExtract } from '@noble/hashes/hkdf';
import { hmac } from '@noble/hashes/hmac';
import { sha256 } from '@noble/hashes/sha256';
import { utf8ToBytes } from '@noble/hashes/utils';
import type { Rng, RngStream } from '../module/context.js';
import type { Hex } from '../types.js';

const SALT = /* @__PURE__ */ utf8ToBytes('nip-gm-rng-v1');
const BLOCK = 32;

function streamKey(prk: Uint8Array, gameId: string, seq: number, label: string): Uint8Array {
  return hkdfExpand(sha256, prk, utf8ToBytes(`${gameId}|${seq}|${label}`), 32);
}

function createStream(key: Uint8Array): RngStream {
  let counter = 0;
  // Annotated because hmac() returns a view over ArrayBufferLike, which does not
  // unify with the ArrayBuffer-backed type inferred from `new Uint8Array(0)`.
  let buffer: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
  let offset = 0;

  const refill = (): void => {
    const index = new Uint8Array(4);
    new DataView(index.buffer).setUint32(0, counter++, false);
    buffer = hmac(sha256, key, index);
    offset = 0;
  };

  const bytes = (n: number): Uint8Array => {
    if (!Number.isSafeInteger(n) || n < 0) throw new Error('expected non-negative integer');
    const out = new Uint8Array(n);
    let written = 0;
    while (written < n) {
      if (offset >= buffer.length) refill();
      const take = Math.min(n - written, BLOCK - offset);
      out.set(buffer.subarray(offset, offset + take), written);
      offset += take;
      written += take;
    }
    return out;
  };

  const int = (maxExclusive: number): number => {
    if (!Number.isSafeInteger(maxExclusive) || maxExclusive < 1) {
      throw new Error('expected positive integer');
    }
    if (maxExclusive === 1) return 0;
    // Rejection sampling: discard the tail that would otherwise make low values
    // marginally more likely. Deterministic, because rejections consume stream
    // bytes identically for every implementation.
    const limit = Math.floor(0x1_0000_0000 / maxExclusive) * maxExclusive;
    for (;;) {
      const b = bytes(4);
      const value = ((b[0] << 24) >>> 0) + (b[1] << 16) + (b[2] << 8) + b[3];
      if (value < limit) return value % maxExclusive;
    }
  };

  return {
    bytes,
    int,
    shuffle<T>(items: readonly T[]): T[] {
      // Fisher-Yates from the end. Returns a new array; the input is untouched.
      const out = [...items];
      for (let i = out.length - 1; i > 0; i--) {
        const j = int(i + 1);
        [out[i], out[j]] = [out[j], out[i]];
      }
      return out;
    },
  };
}

/**
 * Build the RNG for a game from its committed seed and game id.
 *
 * Mixing in `gameId` means the same seed replayed into a different game yields
 * different draws, so a leaked seed cannot be exploited across matches.
 */
export function createRng(seed: Uint8Array, gameId: Hex): Rng {
  const prk = hkdfExtract(sha256, seed, SALT);
  return {
    at: (seq: number, label: string): RngStream => {
      if (!Number.isSafeInteger(seq) || seq < 0) throw new Error('expected non-negative seq');
      return createStream(streamKey(prk, gameId, seq, label));
    },
  };
}
