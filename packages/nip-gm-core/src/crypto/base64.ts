/**
 * Strict base64, implemented rather than borrowed.
 *
 * `btoa`/`atob` are lenient about padding and whitespace, and `Buffer` is a node
 * builtin core is not allowed to touch. NIP-44 decryption must *reject* a
 * malformed payload rather than silently decoding a near-miss, so the decoder
 * here validates length, alphabet and padding placement.
 */

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

const LOOKUP = /* @__PURE__ */ (() => {
  const table = new Int16Array(256).fill(-1);
  for (let i = 0; i < ALPHABET.length; i++) table[ALPHABET.charCodeAt(i)] = i;
  return table;
})();

export function base64Encode(bytes: Uint8Array): string {
  let out = '';
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out += ALPHABET[(n >> 18) & 63] + ALPHABET[(n >> 12) & 63] + ALPHABET[(n >> 6) & 63] + ALPHABET[n & 63];
  }
  const remaining = bytes.length - i;
  if (remaining === 1) {
    const n = bytes[i] << 16;
    out += ALPHABET[(n >> 18) & 63] + ALPHABET[(n >> 12) & 63] + '==';
  } else if (remaining === 2) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8);
    out += ALPHABET[(n >> 18) & 63] + ALPHABET[(n >> 12) & 63] + ALPHABET[(n >> 6) & 63] + '=';
  }
  return out;
}

export function base64Decode(text: string): Uint8Array {
  if (text.length === 0) return new Uint8Array(0);
  if (text.length % 4 !== 0) throw new Error('invalid base64: length');

  let padding = 0;
  if (text.charCodeAt(text.length - 1) === 61) padding++;
  if (text.charCodeAt(text.length - 2) === 61) padding++;
  if (padding === 2 && text.charCodeAt(text.length - 3) === 61) {
    throw new Error('invalid base64: padding');
  }

  const out = new Uint8Array((text.length / 4) * 3 - padding);
  let o = 0;

  for (let i = 0; i < text.length; i += 4) {
    const a = LOOKUP[text.charCodeAt(i)];
    const b = LOOKUP[text.charCodeAt(i + 1)];
    // '=' resolves to -1 in the lookup; it is only legal in the final group,
    // which the length arithmetic above has already accounted for.
    const isLast = i + 4 >= text.length;
    const cChar = text.charCodeAt(i + 2);
    const dChar = text.charCodeAt(i + 3);
    const c = cChar === 61 && isLast && padding >= 2 ? 0 : LOOKUP[cChar];
    const d = dChar === 61 && isLast && padding >= 1 ? 0 : LOOKUP[dChar];

    if (a < 0 || b < 0 || c < 0 || d < 0) throw new Error('invalid base64: alphabet');

    const n = (a << 18) | (b << 12) | (c << 6) | d;
    if (o < out.length) out[o++] = (n >> 16) & 255;
    if (o < out.length) out[o++] = (n >> 8) & 255;
    if (o < out.length) out[o++] = n & 255;
  }

  return out;
}
