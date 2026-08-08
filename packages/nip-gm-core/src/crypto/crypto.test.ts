import { describe, expect, it } from 'vitest';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils';
import { base64Decode, base64Encode } from './base64.js';
import { combineSeeds, createSeedCommitment, seedCommit, verifySeedCommit } from './commit.js';
import { generateSecretKey, getEventHash, getPublicKey, signEvent, verifyEvent } from './event.js';
import { generateEphemeralKeypair, gmConversationKey, playerConversationKey } from './ephemeral.js';
import { createRng } from './rng.js';
import { conversationKey, decrypt, encrypt } from './nip44.js';
import type { Hex, UnsignedEvent } from '../types.js';

const GAME = 'e'.repeat(64) as Hex;
const seed = new Uint8Array(32).fill(7);

describe('base64', () => {
  it('round-trips every length up to 3 blocks', () => {
    for (let n = 0; n < 24; n++) {
      const bytes = new Uint8Array(n).map((_, i) => (i * 37) & 255);
      expect(base64Decode(base64Encode(bytes))).toEqual(bytes);
    }
  });

  it('matches known encodings', () => {
    expect(base64Encode(utf8ToBytes('hello'))).toBe('aGVsbG8=');
    expect(base64Encode(utf8ToBytes('hi'))).toBe('aGk=');
    expect(new TextDecoder().decode(base64Decode('aGVsbG8='))).toBe('hello');
  });

  it.each([
    ['bad length', 'aGVsbG8'],
    ['illegal character', 'aGVs*G8='],
    ['padding in the middle', 'aG=sbG8='],
    ['triple padding', 'aG==='],
  ])('rejects %s', (_label, text) => {
    expect(() => base64Decode(text)).toThrow();
  });
});

describe('seed commitment', () => {
  it('verifies a matching seed and salt', () => {
    const { seed: s, salt, commit } = createSeedCommitment();
    expect(verifySeedCommit(commit, s, salt)).toBe(true);
  });

  it('rejects a substituted seed — the point of committing', () => {
    const { salt, commit } = createSeedCommitment();
    expect(verifySeedCommit(commit, new Uint8Array(32).fill(9), salt)).toBe(false);
  });

  it('rejects a substituted salt', () => {
    const { seed: s, commit } = createSeedCommitment();
    expect(verifySeedCommit(commit, s, new Uint8Array(32).fill(9))).toBe(false);
  });

  it('is a plain sha256 of seed || salt', () => {
    expect(seedCommit(new Uint8Array([1]), new Uint8Array([2]))).toHaveLength(64);
  });

  it('samples a different seed each time', () => {
    expect(createSeedCommitment().commit).not.toBe(createSeedCommitment().commit);
  });
});

describe('combineSeeds', () => {
  const a = 'a'.repeat(64) as Hex;
  const b = 'b'.repeat(64) as Hex;

  it('folds contributions in pubkey order, not arrival order', () => {
    // The GM sees reveals in whatever order they arrive; an auditor sees them
    // in whatever order a relay returns. Both must derive the same seed.
    const one = combineSeeds(seed, { [a]: new Uint8Array([1]), [b]: new Uint8Array([2]) });
    const two = combineSeeds(seed, { [b]: new Uint8Array([2]), [a]: new Uint8Array([1]) });
    expect(bytesToHex(one)).toBe(bytesToHex(two));
  });

  it('changes if any contribution changes', () => {
    const base = combineSeeds(seed, { [a]: new Uint8Array([1]) });
    const altered = combineSeeds(seed, { [a]: new Uint8Array([2]) });
    expect(bytesToHex(base)).not.toBe(bytesToHex(altered));
  });

  it('changes if the GM seed changes', () => {
    const one = combineSeeds(seed, { [a]: new Uint8Array([1]) });
    const two = combineSeeds(new Uint8Array(32).fill(8), { [a]: new Uint8Array([1]) });
    expect(bytesToHex(one)).not.toBe(bytesToHex(two));
  });
});

describe('createRng', () => {
  const rng = createRng(seed, GAME);

  it('is a pure function of its address', () => {
    expect(bytesToHex(rng.at(5, 'deal').bytes(32))).toBe(bytesToHex(rng.at(5, 'deal').bytes(32)));
  });

  it('separates streams by seq and by label', () => {
    const a = bytesToHex(rng.at(5, 'deal').bytes(16));
    expect(a).not.toBe(bytesToHex(rng.at(6, 'deal').bytes(16)));
    expect(a).not.toBe(bytesToHex(rng.at(5, 'storm').bytes(16)));
  });

  it('separates streams by seed and by game id', () => {
    const a = bytesToHex(rng.at(1, 'x').bytes(16));
    expect(a).not.toBe(bytesToHex(createRng(new Uint8Array(32).fill(8), GAME).at(1, 'x').bytes(16)));
    // Mixing in the game id means a leaked seed cannot be reused across matches.
    expect(a).not.toBe(bytesToHex(createRng(seed, ('f'.repeat(64) as Hex)).at(1, 'x').bytes(16)));
  });

  it('advances within a single stream', () => {
    const stream = rng.at(1, 'x');
    expect(bytesToHex(stream.bytes(8))).not.toBe(bytesToHex(stream.bytes(8)));
  });

  it('produces a continuous stream across block boundaries', () => {
    // 100 bytes spans four 32-byte HMAC blocks; drawing it in pieces must equal
    // drawing it at once, or ports will disagree at the seam.
    const whole = bytesToHex(rng.at(2, 'y').bytes(100));
    const stream = rng.at(2, 'y');
    const pieces = [stream.bytes(30), stream.bytes(2), stream.bytes(68)];
    expect(pieces.map(bytesToHex).join('')).toBe(whole);
  });

  it('computes future rounds now — the scheduled-randomness property', () => {
    // A GM can decide at seq 5 what lands at seq 8, and an auditor confirms it
    // from the revealed seed alone.
    const scheduled = rng.at(8, 'storm').int(64);
    expect(createRng(seed, GAME).at(8, 'storm').int(64)).toBe(scheduled);
  });

  describe('int', () => {
    it('stays in range', () => {
      const stream = rng.at(0, 'roll');
      for (let i = 0; i < 500; i++) {
        const v = stream.int(6);
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThan(6);
      }
    });

    it('returns 0 for a single outcome without consuming the stream', () => {
      const stream = rng.at(0, 'z');
      expect(stream.int(1)).toBe(0);
      expect(bytesToHex(stream.bytes(4))).toBe(bytesToHex(rng.at(0, 'z').bytes(4)));
    });

    it('rejects a non-positive bound', () => {
      expect(() => rng.at(0, 'z').int(0)).toThrow();
      expect(() => rng.at(0, 'z').int(-1)).toThrow();
    });

    it('covers the whole range roughly evenly', () => {
      const counts = new Array(6).fill(0);
      const stream = rng.at(0, 'dice');
      for (let i = 0; i < 6000; i++) counts[stream.int(6)]++;
      for (const c of counts) expect(c).toBeGreaterThan(800);
    });
  });

  describe('shuffle', () => {
    const deck = Array.from({ length: 52 }, (_, i) => i);

    it('is deterministic for an address', () => {
      expect(rng.at(1, 'deal').shuffle(deck)).toEqual(rng.at(1, 'deal').shuffle(deck));
    });

    it('permutes rather than drops or duplicates', () => {
      const shuffled = rng.at(1, 'deal').shuffle(deck);
      expect([...shuffled].sort((a, b) => a - b)).toEqual(deck);
    });

    it('actually reorders', () => {
      expect(rng.at(1, 'deal').shuffle(deck)).not.toEqual(deck);
    });

    it('does not mutate its input', () => {
      const copy = [...deck];
      rng.at(1, 'deal').shuffle(deck);
      expect(deck).toEqual(copy);
    });

    it('handles empty and single-element arrays', () => {
      expect(rng.at(1, 'x').shuffle([])).toEqual([]);
      expect(rng.at(1, 'x').shuffle(['a'])).toEqual(['a']);
    });
  });

  it('rejects a negative seq', () => {
    expect(() => rng.at(-1, 'x')).toThrow();
  });
});

describe('events', () => {
  const privkey = generateSecretKey();
  const template: UnsignedEvent = {
    pubkey: getPublicKey(privkey),
    created_at: 1_700_000_000,
    kind: 2601,
    tags: [
      ['state', 'start'],
      ['p', 'a'.repeat(64)],
      ['p', 'b'.repeat(64)],
    ],
    content: '{"config":{}}',
  };

  it('signs and verifies', () => {
    expect(verifyEvent(signEvent(template, privkey))).toBe(true);
  });

  it('rejects tampered content', () => {
    const event = signEvent(template, privkey);
    expect(verifyEvent({ ...event, content: '{"config":{"cheat":true}}' })).toBe(false);
  });

  it('rejects reordered p tags — seat order is covered by the signature', () => {
    // This is the guarantee seat order rests on (NIP-GM §Start).
    const event = signEvent(template, privkey);
    const tags = [event.tags[0], event.tags[2], event.tags[1]];
    expect(verifyEvent({ ...event, tags })).toBe(false);
  });

  it('rejects a valid signature re-pointed at a different id', () => {
    const event = signEvent(template, privkey);
    const other = signEvent({ ...template, created_at: 1_700_000_001 }, privkey);
    expect(verifyEvent({ ...event, id: other.id })).toBe(false);
  });

  it('changes the id when tag order changes', () => {
    const swapped: UnsignedEvent = {
      ...template,
      tags: [template.tags[0], template.tags[2], template.tags[1]],
    };
    expect(getEventHash(template)).not.toBe(getEventHash(swapped));
  });
});

describe('ephemeral keys', () => {
  it('lets the GM derive the same conversation key the player used', () => {
    // NIP-GM §Hidden Information — this symmetry is why a reveal never needs
    // the player's cooperation and no private key is transmitted.
    const gmPriv = generateSecretKey();
    const gmPub = getPublicKey(gmPriv);
    const ephemeral = generateEphemeralKeypair();

    const byPlayer = playerConversationKey(ephemeral, gmPub);
    const byGm = gmConversationKey(gmPriv, ephemeral.pubkey);
    expect(bytesToHex(byPlayer)).toBe(bytesToHex(byGm));
  });

  it('generates a distinct keypair each call', () => {
    expect(generateEphemeralKeypair().pubkey).not.toBe(generateEphemeralKeypair().pubkey);
  });

  it('gives unrelated keys to different rounds', () => {
    const gmPub = getPublicKey(generateSecretKey());
    const round1 = playerConversationKey(generateEphemeralKeypair(), gmPub);
    const round2 = playerConversationKey(generateEphemeralKeypair(), gmPub);
    // Fresh key per round is what keeps a reveal scoped to one round.
    expect(bytesToHex(round1)).not.toBe(bytesToHex(round2));
  });
});

describe('nip44 round-trip', () => {
  it('encrypts and decrypts between two parties', () => {
    const a = generateSecretKey();
    const b = generateSecretKey();
    const ka = conversationKey(a, getPublicKey(b));
    const kb = conversationKey(b, getPublicKey(a));
    expect(decrypt(encrypt('hole cards: As Kd', ka), kb)).toBe('hole cards: As Kd');
  });

  it('produces a different payload each time for the same plaintext', () => {
    const k = conversationKey(generateSecretKey(), getPublicKey(generateSecretKey()));
    expect(encrypt('same', k)).not.toBe(encrypt('same', k));
  });
});
