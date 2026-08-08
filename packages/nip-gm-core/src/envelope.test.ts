import { describe, expect, it } from 'vitest';
import { checkEnvelope, formatMoveEnvelope, parseMoveEnvelope, type MoveEnvelope } from './envelope.js';
import type { Hex } from './types.js';

const A = 'a'.repeat(64) as Hex;
const B = 'b'.repeat(64) as Hex;
const PREV = 'c'.repeat(64) as Hex;
const OTHER = 'd'.repeat(64) as Hex;

const envelope: MoveEnvelope = { seq: 12, prev: PREV, type: 'raise', data: { amount: 40 } };

describe('parseMoveEnvelope', () => {
  it('round-trips', () => {
    expect(parseMoveEnvelope(formatMoveEnvelope(envelope))).toEqual({ ok: true, value: envelope });
  });

  it.each([
    ['malformed json', '{', 'malformed_json'],
    ['an array', '[]', 'not_an_object'],
    ['null', 'null', 'not_an_object'],
    ['missing seq', '{"prev":"' + PREV + '","type":"x"}', 'bad_seq'],
    ['negative seq', '{"seq":-1,"prev":"' + PREV + '","type":"x"}', 'bad_seq'],
    ['fractional seq', '{"seq":1.5,"prev":"' + PREV + '","type":"x"}', 'bad_seq'],
    ['short prev', '{"seq":1,"prev":"abc","type":"x"}', 'bad_prev'],
    ['uppercase prev', '{"seq":1,"prev":"' + 'A'.repeat(64) + '","type":"x"}', 'bad_prev'],
    ['empty type', '{"seq":1,"prev":"' + PREV + '","type":""}', 'bad_type'],
  ])('rejects %s', (_label, content, error) => {
    expect(parseMoveEnvelope(content)).toEqual({ ok: false, error });
  });

  it('allows absent data, since the module decides whether a move needs any', () => {
    const parsed = parseMoveEnvelope('{"seq":1,"prev":"' + PREV + '","type":"fold"}');
    expect(parsed.ok && parsed.value.data).toBeUndefined();
  });
});

describe('checkEnvelope', () => {
  const head = { seq: 12, prev: PREV };
  const membership = { awaiting: [A, B], submitted: [] as Hex[] };

  it('accepts a current, awaited, first submission', () => {
    expect(checkEnvelope(envelope, head, A, membership)).toEqual({ ok: true });
  });

  it('rejects a move answering a closed round', () => {
    expect(checkEnvelope({ ...envelope, seq: 11 }, head, A, membership)).toEqual({
      ok: false,
      reason: 'stale_seq',
    });
  });

  it('rejects a move answering a round that has not opened', () => {
    expect(checkEnvelope({ ...envelope, seq: 13 }, head, A, membership)).toEqual({
      ok: false,
      reason: 'future_seq',
    });
  });

  it('rejects a move pinned to a superseded state', () => {
    expect(checkEnvelope({ ...envelope, prev: OTHER }, head, A, membership)).toEqual({
      ok: false,
      reason: 'stale_prev',
    });
  });

  it('rejects a player who was not asked to act', () => {
    expect(checkEnvelope(envelope, head, OTHER, membership)).toEqual({
      ok: false,
      reason: 'not_awaited',
    });
  });

  it('rejects a second submission in the same round', () => {
    expect(checkEnvelope(envelope, head, A, { awaiting: [A, B], submitted: [A] })).toEqual({
      ok: false,
      reason: 'duplicate',
    });
  });

  it('lets both players of a simultaneous round submit against one (seq, prev)', () => {
    // NIP-GM §Deltas: everyone in a simultaneous round shares seq and prev.
    expect(checkEnvelope(envelope, head, A, membership)).toEqual({ ok: true });
    expect(checkEnvelope(envelope, head, B, { ...membership, submitted: [A] })).toEqual({ ok: true });
  });

  it('is deterministic — the same inputs always give the same verdict', () => {
    // This is what an auditor re-runs to confirm a rejection was justified.
    const verdicts = Array.from({ length: 5 }, () =>
      checkEnvelope({ ...envelope, seq: 11 }, head, A, membership),
    );
    expect(new Set(verdicts.map((v) => JSON.stringify(v))).size).toBe(1);
  });
});
