/**
 * The full hidden-move loop for a simultaneous round, end to end.
 *
 * This is the hot path for any game where every player queues orders that
 * resolve together on a tick, and it exercises the claim NIP-GM's `verified`
 * mode rests on: that a third party holding no keys can confirm a round was
 * resolved honestly.
 */
import { describe, expect, it } from 'vitest';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import {
  buildDelta,
  buildEnd,
  buildMove,
  buildStart,
  createRng,
  createSeedCommitment,
  decrypt,
  encrypt,
  formatMoveEnvelope,
  generateEphemeralKeypair,
  getEventHash,
  gmConversationKey,
  isCanonicalOrder,
  KIND,
  orderRound,
  parseMessage,
  parseState,
  playerConversationKey,
  verifyEvent,
  verifySeedCommit,
  type AppliedMove,
  type Hex,
  type ResolvedMove,
  type ResolutionOrder,
} from 'nip-gm-core';
import { signerFromSeed } from './memory-signer.js';

const RESOLUTION: ResolutionOrder = { kind: 'shuffled' };
const LOBBY = { kind: KIND.LOBBY, pubkey: '0'.repeat(64) as Hex, identifier: 'test' };

async function playRound() {
  const gm = signerFromSeed(1);
  const alice = signerFromSeed(2);
  const bob = signerFromSeed(3);

  // --- Before play: the GM commits to a seed it cannot later change. --------
  const commitment = createSeedCommitment();

  const startEvent = await gm.signEvent({
    ...buildStart({
      lobby: { ...LOBBY, pubkey: gm.pubkey },
      seats: [alice.pubkey, bob.pubkey],
      game: 'net.example.orders',
      version: '0.1.0',
      content: { config: {}, seedCommit: commitment.commit },
    }),
    pubkey: gm.pubkey,
    created_at: 1_700_000_000,
  });
  const gameId = startEvent.id;

  // --- Each player commits a hidden move under a fresh per-round key. -------
  const submit = async (signer: typeof alice, move: unknown) => {
    const ephemeral = generateEphemeralKeypair();
    const convKey = playerConversationKey(ephemeral, gm.pubkey);
    const ciphertext = encrypt(
      formatMoveEnvelope({ seq: 1, prev: gameId, type: 'orders', data: move }),
      convKey,
    );
    const event = await signer.signEvent({
      ...buildMove(gameId, gm.pubkey, ciphertext, { ephemeral: ephemeral.pubkey }),
      pubkey: await signer.getPublicKey(),
      created_at: 1_700_000_010,
    });
    return { event, move };
  };

  const submissions = [
    await submit(alice, { march: 'north' }),
    await submit(bob, { march: 'south' }),
  ];

  // --- GM side: decrypt, order canonically, close the round. ----------------
  const seats = [alice.pubkey, bob.pubkey];
  const rng = createRng(commitment.seed, gameId);

  const decrypted: (ResolvedMove & { key: string })[] = [];
  for (const { event } of submissions) {
    const parsed = parseMessage(event);
    if (!parsed.ok || parsed.value.action !== 'move') throw new Error('bad move event');

    // The GM derives the player's key itself — no cooperation needed.
    const convKey = gmConversationKey(gm.privkey, parsed.value.ephemeral!);
    const envelope = JSON.parse(decrypt(event.content, convKey));

    decrypted.push({
      id: event.id,
      player: event.pubkey,
      seat: seats.indexOf(event.pubkey),
      move: envelope.data,
      key: bytesToHex(convKey),
    });
  }

  const ordered = orderRound(RESOLUTION, decrypted, { seq: 1, rng, seats });
  const applied: AppliedMove[] = ordered.map((m) => ({
    id: m.id,
    move: m.move,
    key: (m as (typeof decrypted)[number]).key,
  }));

  const deltaEvent = await gm.signEvent({
    ...buildDelta({
      gameId,
      seq: 1,
      awaiting: seats,
      content: { seq: 1, applied, patch: { round: 1 }, system: null },
    }),
    pubkey: gm.pubkey,
    created_at: 1_700_000_020,
  });

  const endEvent = await gm.signEvent({
    ...buildEnd({
      gameId,
      players: seats,
      content: {
        result: { winners: [alice.pubkey] },
        seed: bytesToHex(commitment.seed),
        salt: bytesToHex(commitment.salt),
      },
    }),
    pubkey: gm.pubkey,
    created_at: 1_700_000_030,
  });

  return { gm, seats, gameId, commitment, submissions, deltaEvent, endEvent, startEvent, rng };
}

describe('simultaneous round commit-reveal', () => {
  it('hides moves from everyone but the GM until the round closes', async () => {
    const { submissions } = await playRound();
    for (const { event } of submissions) {
      // On the relay, all an observer has is ciphertext.
      expect(event.content).not.toContain('march');
      expect(() => JSON.parse(event.content)).toThrow();
    }
  });

  it('lets an auditor with no keys verify every cited move', async () => {
    const { submissions, deltaEvent } = await playRound();

    const parsed = parseState(deltaEvent);
    if (!parsed.ok || parsed.value.type !== 'delta') throw new Error('bad delta');
    const applied = parsed.value.content.applied;

    const ciphertexts = new Map(submissions.map(({ event }) => [event.id, event.content]));
    expect(applied).toHaveLength(2);

    for (const entry of applied) {
      // Decrypt the original commitment with the revealed key and confirm it
      // matches the plaintext the GM published.
      const ciphertext = ciphertexts.get(entry.id);
      expect(ciphertext, 'delta cites a move that exists').toBeDefined();

      const envelope = JSON.parse(decrypt(ciphertext!, hexToBytes(entry.key!)));
      expect(envelope.data).toEqual(entry.move);
    }
  });

  it('detects a GM that publishes a plaintext not matching the ciphertext', async () => {
    const { submissions, deltaEvent } = await playRound();

    const parsed = parseState(deltaEvent);
    if (!parsed.ok || parsed.value.type !== 'delta') throw new Error('bad delta');

    // A dishonest GM claims Alice ordered something she did not.
    const forged = { ...parsed.value.content.applied[0], move: { march: 'retreat' } };
    const ciphertext = submissions.find((s) => s.event.id === forged.id)!.event.content;
    const envelope = JSON.parse(decrypt(ciphertext, hexToBytes(forged.key!)));

    expect(envelope.data).not.toEqual(forged.move);
  });

  it('detects a GM that publishes moves out of canonical order', async () => {
    const { deltaEvent, gameId, commitment, seats } = await playRound();

    const parsed = parseState(deltaEvent);
    if (!parsed.ok || parsed.value.type !== 'delta') throw new Error('bad delta');

    const rng = createRng(commitment.seed, gameId);
    const asPublished: ResolvedMove[] = parsed.value.content.applied.map((a) => ({
      id: a.id,
      player: '',
      seat: -1,
      move: a.move,
    }));

    expect(isCanonicalOrder(RESOLUTION, asPublished, { seq: 1, rng, seats })).toBe(true);
    expect(
      isCanonicalOrder(RESOLUTION, [...asPublished].reverse(), {
        seq: 1,
        rng: createRng(commitment.seed, gameId),
        seats,
      }),
    ).toBe(false);
  });

  it('verifies the seed commitment against the end-event reveal', async () => {
    const { endEvent, commitment } = await playRound();

    const parsed = parseState(endEvent);
    if (!parsed.ok || parsed.value.type !== 'end') throw new Error('bad end');

    const { seed, salt } = parsed.value.content;
    expect(verifySeedCommit(commitment.commit, hexToBytes(seed!), hexToBytes(salt!))).toBe(true);
    // A GM that swapped the seed after seeing play fails here.
    expect(verifySeedCommit(commitment.commit, new Uint8Array(32).fill(1), hexToBytes(salt!))).toBe(
      false,
    );
  });

  it('signs every event so the whole record is attributable', async () => {
    const { startEvent, deltaEvent, endEvent, submissions, gm, seats } = await playRound();

    for (const event of [startEvent, deltaEvent, endEvent]) {
      expect(verifyEvent(event)).toBe(true);
      expect(event.pubkey).toBe(gm.pubkey);
    }
    for (const { event } of submissions) {
      expect(verifyEvent(event)).toBe(true);
      expect(seats).toContain(event.pubkey);
    }
  });

  it('makes the game id the start event id, as the spec requires', async () => {
    const { startEvent, gameId, deltaEvent } = await playRound();
    expect(gameId).toBe(getEventHash(startEvent));

    const parsed = parseState(deltaEvent);
    expect(parsed.ok && parsed.value.type === 'delta' && parsed.value.gameId).toBe(gameId);
  });

  it('gives each round an independent key, so one reveal does not open another', async () => {
    // The reason NIP-GM requires a fresh ephemeral key per round: a conversation
    // key decrypts everything between one pair of keys.
    const gm = signerFromSeed(1);
    const roundKeys = [1, 2].map(() => {
      const ephemeral = generateEphemeralKeypair();
      return {
        ciphertext: encrypt('secret', playerConversationKey(ephemeral, gm.pubkey)),
        key: gmConversationKey(gm.privkey, ephemeral.pubkey),
      };
    });

    expect(decrypt(roundKeys[0].ciphertext, roundKeys[0].key)).toBe('secret');
    // Revealing round 1's key must not open round 2's commitment.
    expect(() => decrypt(roundKeys[1].ciphertext, roundKeys[0].key)).toThrow();
  });
});

