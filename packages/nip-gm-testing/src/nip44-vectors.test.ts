/**
 * The official NIP-44 v2 vectors, run against our implementation.
 *
 * Vendored at `vectors/nip44/official.json` from github.com/paulmillr/nip44.
 * This is the suite that has to stay green before any real key touches the
 * code — an implementation that merely round-trips against itself proves
 * nothing about interoperating with every other Nostr client.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import {
  calcPaddedLen,
  conversationKey,
  decrypt,
  encrypt,
  messageKeys,
  type Hex,
} from 'nip-gm-core';
import { vectorsRoot } from './vectors.js';

interface Official {
  v2: {
    valid: {
      get_conversation_key: { sec1: string; pub2: string; conversation_key: string }[];
      get_message_keys: {
        conversation_key: string;
        keys: { nonce: string; chacha_key: string; chacha_nonce: string; hmac_key: string }[];
      };
      calc_padded_len: [number, number][];
      encrypt_decrypt: {
        sec1: string;
        sec2: string;
        conversation_key: string;
        nonce: string;
        plaintext: string;
        payload: string;
      }[];
      encrypt_decrypt_long_msg: {
        conversation_key: string;
        nonce: string;
        pattern: string;
        repeat: number;
        plaintext_sha256: string;
        payload_sha256: string;
      }[];
    };
    invalid: {
      encrypt_msg_lengths: number[];
      get_conversation_key: { sec1: string; pub2: string; note: string }[];
      decrypt: {
        conversation_key: string;
        nonce: string;
        payload: string;
        plaintext: string;
        note: string;
      }[];
    };
  };
}

const vectors: Official = JSON.parse(
  readFileSync(join(vectorsRoot(), 'nip44', 'official.json'), 'utf8'),
);

describe('valid/get_conversation_key', () => {
  it.each(vectors.v2.valid.get_conversation_key.map((v, i) => [i, v] as const))(
    'case %i',
    (_i, v) => {
      expect(bytesToHex(conversationKey(hexToBytes(v.sec1), v.pub2 as Hex))).toBe(
        v.conversation_key,
      );
    },
  );
});

describe('valid/get_message_keys', () => {
  const convKey = hexToBytes(vectors.v2.valid.get_message_keys.conversation_key);

  it.each(vectors.v2.valid.get_message_keys.keys.map((v, i) => [i, v] as const))(
    'case %i',
    (_i, v) => {
      const keys = messageKeys(convKey, hexToBytes(v.nonce));
      expect(bytesToHex(keys.chachaKey)).toBe(v.chacha_key);
      expect(bytesToHex(keys.chachaNonce)).toBe(v.chacha_nonce);
      expect(bytesToHex(keys.hmacKey)).toBe(v.hmac_key);
    },
  );
});

describe('valid/calc_padded_len', () => {
  it.each(vectors.v2.valid.calc_padded_len)('%i -> %i', (len, expected) => {
    expect(calcPaddedLen(len)).toBe(expected);
  });
});

describe('valid/encrypt_decrypt', () => {
  it.each(vectors.v2.valid.encrypt_decrypt.map((v, i) => [i, v] as const))('case %i', (_i, v) => {
    const convKey = hexToBytes(v.conversation_key);

    // Encrypting with the vector's nonce must reproduce the exact payload.
    expect(encrypt(v.plaintext, convKey, hexToBytes(v.nonce))).toBe(v.payload);
    expect(decrypt(v.payload, convKey)).toBe(v.plaintext);
  });
});

describe('valid/encrypt_decrypt_long_msg', () => {
  it.each(vectors.v2.valid.encrypt_decrypt_long_msg.map((v, i) => [i, v] as const))(
    'case %i',
    async (_i, v) => {
      const { sha256 } = await import('@noble/hashes/sha256');
      const { utf8ToBytes } = await import('@noble/hashes/utils');

      const plaintext = v.pattern.repeat(v.repeat);
      expect(bytesToHex(sha256(utf8ToBytes(plaintext)))).toBe(v.plaintext_sha256);

      const payload = encrypt(plaintext, hexToBytes(v.conversation_key), hexToBytes(v.nonce));
      expect(bytesToHex(sha256(utf8ToBytes(payload)))).toBe(v.payload_sha256);
      expect(decrypt(payload, hexToBytes(v.conversation_key))).toBe(plaintext);
    },
  );
});

describe('invalid/encrypt_msg_lengths', () => {
  it.each(vectors.v2.invalid.encrypt_msg_lengths)('rejects length %i', (len) => {
    const convKey = new Uint8Array(32).fill(1);
    expect(() => encrypt('a'.repeat(len), convKey)).toThrow();
  });
});

describe('invalid/get_conversation_key', () => {
  it.each(vectors.v2.invalid.get_conversation_key.map((v) => [v.note, v] as const))(
    'rejects %s',
    (_note, v) => {
      expect(() => conversationKey(hexToBytes(v.sec1), v.pub2 as Hex)).toThrow();
    },
  );
});

describe('invalid/decrypt', () => {
  it.each(vectors.v2.invalid.decrypt.map((v) => [v.note, v] as const))(
    'rejects %s',
    (_note, v) => {
      expect(() => decrypt(v.payload, hexToBytes(v.conversation_key))).toThrow();
    },
  );

  it('tryDecrypt returns undefined instead of throwing', async () => {
    const { tryDecrypt } = await import('nip-gm-core');
    const v = vectors.v2.invalid.decrypt[0];
    expect(tryDecrypt(v.payload, hexToBytes(v.conversation_key))).toBeUndefined();
  });
});
