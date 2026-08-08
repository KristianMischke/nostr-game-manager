import { describe, expect, it } from 'vitest';
import {
  allFinal,
  checkEnvelope,
  formatMoveEnvelope,
  parseMoveEnvelope,
  selectRevisions,
  supersededRevisions,
  type MoveEnvelope,
  type RevisionCandidate,
} from './envelope.js';
import type { Hex } from './types.js';

const A = 'a'.repeat(64) as Hex;
const B = 'b'.repeat(64) as Hex;
const PREV = 'c'.repeat(64) as Hex;
const OTHER = 'd'.repeat(64) as Hex;

const envelope: MoveEnvelope = {
  seq: 12,
  prev: PREV,
  rev: 0,
  final: false,
  type: 'raise',
  data: { amount: 40 },
};

describe('parseMoveEnvelope', () => {
  it('round-trips', () => {
    expect(parseMoveEnvelope(formatMoveEnvelope(envelope))).toEqual({ ok: true, value: envelope });
  });

  it('round-trips a final revision', () => {
    const final = { ...envelope, rev: 4, final: true };
    expect(parseMoveEnvelope(formatMoveEnvelope(final))).toEqual({ ok: true, value: final });
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
    ['negative rev', '{"seq":1,"prev":"' + PREV + '","type":"x","rev":-1}', 'bad_rev'],
    ['fractional rev', '{"seq":1,"prev":"' + PREV + '","type":"x","rev":1.5}', 'bad_rev'],
    ['string rev', '{"seq":1,"prev":"' + PREV + '","type":"x","rev":"2"}', 'bad_rev'],
    ['non-boolean final', '{"seq":1,"prev":"' + PREV + '","type":"x","final":1}', 'bad_final'],
  ])('rejects %s', (_label, content, error) => {
    expect(parseMoveEnvelope(content)).toEqual({ ok: false, error });
  });

  it('allows absent data, since the module decides whether a move needs any', () => {
    const parsed = parseMoveEnvelope('{"seq":1,"prev":"' + PREV + '","type":"fold"}');
    expect(parsed.ok && parsed.value.data).toBeUndefined();
  });

  it('reads an absent rev as revision 0', () => {
    // A turn-taking game sends one move and never revises; it should not have
    // to carry the field, and pre-revision clients did not.
    const parsed = parseMoveEnvelope('{"seq":1,"prev":"' + PREV + '","type":"fold"}');
    expect(parsed.ok && parsed.value).toMatchObject({ rev: 0, final: false });
  });

  it('rejects a malformed rev rather than coercing it to 0', () => {
    // Coercing would make a corrupted revision outrank a good one at rev 0 —
    // and would let a client claim a low rev by sending garbage.
    expect(parseMoveEnvelope('{"seq":1,"prev":"' + PREV + '","type":"x","rev":null}')).toEqual({
      ok: false,
      error: 'bad_rev',
    });
  });

  it('omits final from the wire when false', () => {
    expect(formatMoveEnvelope(envelope)).not.toContain('final');
    expect(formatMoveEnvelope({ ...envelope, final: true })).toContain('"final":true');
  });
});

describe('checkEnvelope', () => {
  const head = { seq: 12, prev: PREV };
  const membership = { awaiting: [A, B], submitted: new Map<Hex, number>() };

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

  it('rejects a repeat of a revision already held', () => {
    const submitted = new Map<Hex, number>([[A, 0]]);
    expect(checkEnvelope(envelope, head, A, { awaiting: [A, B], submitted })).toEqual({
      ok: false,
      reason: 'duplicate',
    });
  });

  it('rejects a revision older than the one held', () => {
    const submitted = new Map<Hex, number>([[A, 3]]);
    expect(checkEnvelope({ ...envelope, rev: 1 }, head, A, { awaiting: [A, B], submitted })).toEqual(
      { ok: false, reason: 'superseded' },
    );
  });

  it('accepts a revision that advances on the one held', () => {
    // The whole point: a second move from one player is normal now, and must
    // not be mistaken for the duplicate-submission attack the old rule caught.
    const submitted = new Map<Hex, number>([[A, 3]]);
    expect(checkEnvelope({ ...envelope, rev: 4 }, head, A, { awaiting: [A, B], submitted })).toEqual(
      { ok: true },
    );
  });

  it('does not let one player’s revisions bar another’s first submission', () => {
    const submitted = new Map<Hex, number>([[A, 7]]);
    expect(checkEnvelope(envelope, head, B, { awaiting: [A, B], submitted })).toEqual({ ok: true });
  });

  it('lets both players of a simultaneous round submit against one (seq, prev)', () => {
    // NIP-GM §Deltas: everyone in a simultaneous round shares seq and prev.
    expect(checkEnvelope(envelope, head, A, membership)).toEqual({ ok: true });
    expect(
      checkEnvelope(envelope, head, B, { ...membership, submitted: new Map([[A, 0]]) }),
    ).toEqual({ ok: true });
  });

  it('is deterministic — the same inputs always give the same verdict', () => {
    // This is what an auditor re-runs to confirm a rejection was justified.
    const verdicts = Array.from({ length: 5 }, () =>
      checkEnvelope({ ...envelope, seq: 11 }, head, A, membership),
    );
    expect(new Set(verdicts.map((v) => JSON.stringify(v))).size).toBe(1);
  });
});

describe('selectRevisions', () => {
  const at = (id: string, player: Hex, rev: number, final = false): RevisionCandidate => ({
    id: id.repeat(64).slice(0, 64) as Hex,
    player,
    envelope: { ...envelope, rev, final },
  });

  it('keeps the highest revision per player', () => {
    const winners = selectRevisions([at('1', A, 0), at('2', A, 2), at('3', A, 1)]);
    expect(winners.get(A)?.envelope.rev).toBe(2);
  });

  it('is independent of arrival order', () => {
    // Relays return events in no guaranteed order, so a GM and an auditor
    // fetching the same round will routinely see it differently.
    const all = [at('1', A, 0), at('2', A, 2), at('3', A, 1), at('4', B, 5)];
    const forward = selectRevisions(all);
    const reverse = selectRevisions([...all].reverse());
    expect(forward.get(A)?.id).toBe(reverse.get(A)?.id);
    expect(forward.get(B)?.id).toBe(reverse.get(B)?.id);
  });

  it('breaks equivocation at one rev by lowest event id', () => {
    // Two signed events at the same rev is a misbehaving client; the rule
    // exists so the GM and the auditor still reach the same answer.
    const forward = selectRevisions([at('e', A, 3), at('4', A, 3)]);
    const reverse = selectRevisions([at('4', A, 3), at('e', A, 3)]);
    expect(forward.get(A)?.id).toBe('4'.repeat(64));
    expect(reverse.get(A)?.id).toBe('4'.repeat(64));
  });

  it('tracks players independently', () => {
    const winners = selectRevisions([at('1', A, 9), at('2', B, 1)]);
    expect(winners.get(A)?.envelope.rev).toBe(9);
    expect(winners.get(B)?.envelope.rev).toBe(1);
  });

  it('reports every discarded revision so the delta can reveal their keys', () => {
    const all = [at('1', A, 0), at('2', A, 2), at('3', A, 1), at('4', B, 0)];
    const discarded = supersededRevisions(all, selectRevisions(all));
    expect(discarded.map((c) => c.id)).toEqual(['1'.repeat(64), '3'.repeat(64)]);
  });

  it('reports nothing discarded when nobody revised', () => {
    const all = [at('1', A, 0), at('4', B, 0)];
    expect(supersededRevisions(all, selectRevisions(all))).toEqual([]);
  });

  describe('allFinal', () => {
    it('is true only when every awaited player has a final revision', () => {
      const both = selectRevisions([at('1', A, 1, true), at('2', B, 0, true)]);
      expect(allFinal(both, [A, B])).toBe(true);
    });

    it('is false while a player is still revising', () => {
      const winners = selectRevisions([at('1', A, 1, true), at('2', B, 3, false)]);
      expect(allFinal(winners, [A, B])).toBe(false);
    });

    it('is false for a player who has not submitted at all', () => {
      // A silent player must hold the round open until turn_timeout — otherwise
      // `final` would stop being an optimization and start dropping people.
      expect(allFinal(selectRevisions([at('1', A, 0, true)]), [A, B])).toBe(false);
    });

    it('is false when a player’s latest revision withdraws final', () => {
      const winners = selectRevisions([at('1', A, 1, true), at('2', A, 2, false)]);
      expect(allFinal(winners, [A])).toBe(false);
    });
  });
});
