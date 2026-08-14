/**
 * Tests for the parts of the binding that hold logic rather than plumbing.
 *
 * The `Transport` itself is not unit-tested here: it is a thin shim over NDK's
 * subscription machinery, and the DAG forbids this package from importing
 * `nip-gm-testing`'s in-memory relay. It is covered instead by the end-to-end
 * game run against a real relay.
 */
import NDK, { NDKEvent, nip19 } from '@nostr-dev-kit/ndk';
import { conversationKey, getPublicKey, signEvent, verifyEvent } from 'nip-gm-core';
import { describe, expect, it } from 'vitest';
import { toNDKEvent, toNostrEvent } from './event.js';
import { createKeySigner } from './signers.js';

const SECRET = new Uint8Array(32).fill(7);
const PUBKEY = getPublicKey(SECRET);
const NSEC = nip19.nsecEncode(SECRET);

function sampleEvent() {
  return signEvent(
    {
      pubkey: PUBKEY,
      created_at: 1_700_000_000,
      kind: 2600,
      // Two `p` tags whose order is meaningful — this is seat order.
      tags: [
        ['action', 'move'],
        ['p', 'a'.repeat(64)],
        ['p', 'b'.repeat(64)],
      ],
      content: 'hello',
    },
    SECRET,
  );
}

describe('event conversion', () => {
  it('round-trips a signed event through NDK unchanged', () => {
    const ndk = new NDK();
    const original = sampleEvent();

    const back = toNostrEvent(toNDKEvent(ndk, original));

    expect(back).toEqual(original);
    // The id must survive verbatim: NIP-GM treats it as a commitment (the game
    // id is the start event's id).
    expect(back && verifyEvent(back)).toBe(true);
  });

  it('preserves tag order', () => {
    const ndk = new NDK();
    const back = toNostrEvent(toNDKEvent(ndk, sampleEvent()));

    expect(back?.tags.map((t) => t[0])).toEqual(['action', 'p', 'p']);
    expect(back?.tags[1][1]).toBe('a'.repeat(64));
    expect(back?.tags[2][1]).toBe('b'.repeat(64));
  });

  it('copies tags rather than aliasing NDK-owned arrays', () => {
    const ndk = new NDK();
    const ndkEvent = toNDKEvent(ndk, sampleEvent());
    const back = toNostrEvent(ndkEvent);

    ndkEvent.tags[0][0] = 'mutated';

    expect(back?.tags[0][0]).toBe('action');
  });

  it('rejects unsigned and malformed events instead of throwing', () => {
    const ndk = new NDK();
    const { id: _id, sig: _sig, ...unsigned } = sampleEvent();

    expect(toNostrEvent(new NDKEvent(ndk, unsigned))).toBeUndefined();
    expect(toNostrEvent({ ...sampleEvent(), id: 'short' })).toBeUndefined();
    expect(toNostrEvent({ ...sampleEvent(), created_at: undefined as never })).toBeUndefined();
    expect(toNostrEvent({ ...sampleEvent(), tags: [['ok'], 'not-a-tag' as never] })).toBeUndefined();
  });
});

describe('createKeySigner', () => {
  it('accepts raw bytes, hex and nsec for the same key', async () => {
    const hex = [...SECRET].map((b) => b.toString(16).padStart(2, '0')).join('');

    expect(await createKeySigner(SECRET).getPublicKey()).toBe(PUBKEY);
    expect(await createKeySigner(hex).getPublicKey()).toBe(PUBKEY);
    expect(await createKeySigner(NSEC).getPublicKey()).toBe(PUBKEY);
  });

  it('rejects malformed secrets', () => {
    expect(() => createKeySigner('nope')).toThrow();
    expect(() => createKeySigner(new Uint8Array(16))).toThrow();
  });

  it('signs events that verify', async () => {
    const signer = createKeySigner(SECRET);
    const event = await signer.signEvent({
      pubkey: PUBKEY,
      created_at: 1_700_000_000,
      kind: 2601,
      tags: [['state', 'delta']],
      content: '{}',
    });

    expect(verifyEvent(event)).toBe(true);
    expect(event.pubkey).toBe(PUBKEY);
  });

  it('round-trips nip44 with itself', async () => {
    const signer = createKeySigner(SECRET);
    const peer = getPublicKey(new Uint8Array(32).fill(9));

    const ciphertext = await signer.nip44Encrypt(peer, 'the moves');

    expect(await signer.nip44Decrypt(peer, ciphertext)).toBe('the moves');
  });

  it('exposes the conversation key a GM needs for round reveals', async () => {
    const peerSecret = new Uint8Array(32).fill(9);
    const signer = createKeySigner(SECRET);

    const fromGm = await signer.conversationKey(getPublicKey(peerSecret));

    // Symmetric by construction — this is what lets the GM reveal a player's
    // move key without the player's cooperation.
    expect(fromGm).toEqual(conversationKey(peerSecret, PUBKEY));
  });
});
