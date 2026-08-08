/**
 * Move envelope and revision-selection vectors.
 *
 * These pin the two rules that decide *which move a round actually applies*.
 * A port can have a correct codec, a correct RNG and a correct engine and still
 * resolve a revised round differently, at which point its GM and everyone
 * else's auditor disagree about what happened — with no way to tell who is
 * right from the events alone. Hence a corpus rather than prose.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  allFinal,
  parseMoveEnvelope,
  selectRevisions,
  supersededRevisions,
  type Hex,
  type MoveEnvelope,
  type RevisionCandidate,
} from 'nip-gm-core';
import { vectorsRoot } from './vectors.js';

const load = <T>(file: string): T =>
  JSON.parse(readFileSync(join(vectorsRoot(), 'envelope', file), 'utf8'));

interface ParseCase {
  name: string;
  content: string;
  expect: { ok: true; value: MoveEnvelope } | { ok: false; error: string };
}

interface SelectCase {
  name: string;
  candidates: { id: Hex; player: Hex; rev: number; final: boolean }[];
  winners: Record<Hex, Hex>;
  superseded: Hex[];
  all_final: boolean;
  awaiting: Hex[];
}

describe("vectors/envelope/'parse.json'", () => {
  const { cases } = load<{ cases: ParseCase[] }>('parse.json');

  it('has cases', () => expect(cases.length).toBeGreaterThan(0));

  it.each(cases.map((c) => [c.name, c] as const))('%s', (_name, testCase) => {
    expect(parseMoveEnvelope(testCase.content)).toEqual(testCase.expect);
  });
});

describe("vectors/envelope/'revisions.json'", () => {
  const { cases } = load<{ cases: SelectCase[] }>('revisions.json');

  const build = (testCase: SelectCase): RevisionCandidate[] =>
    testCase.candidates.map((c) => ({
      id: c.id,
      player: c.player,
      // seq/prev/type/data play no part in selection; only rev, final and id do.
      envelope: {
        seq: 1,
        prev: '0'.repeat(64),
        rev: c.rev,
        final: c.final,
        type: 'queue',
        data: null,
      },
    }));

  it('has cases', () => expect(cases.length).toBeGreaterThan(0));

  it.each(cases.map((c) => [c.name, c] as const))('%s', (_name, testCase) => {
    const candidates = build(testCase);
    const winners = selectRevisions(candidates);

    const actualWinners = Object.fromEntries([...winners].map(([p, c]) => [p, c.id]));
    expect(actualWinners).toEqual(testCase.winners);

    expect(supersededRevisions(candidates, winners).map((c) => c.id)).toEqual(testCase.superseded);
    expect(allFinal(winners, testCase.awaiting)).toBe(testCase.all_final);
  });

  it('gives the same answer for every permutation of the input', () => {
    // The property behind the per-case ordering vectors: a GM and an auditor
    // fetch the same round from different relays and must still agree.
    for (const testCase of cases) {
      const candidates = build(testCase);
      const expected = Object.fromEntries(
        [...selectRevisions(candidates)].map(([p, c]) => [p, c.id]),
      );

      for (const permuted of permutations(candidates)) {
        const actual = Object.fromEntries(
          [...selectRevisions(permuted)].map(([p, c]) => [p, c.id]),
        );
        expect(actual).toEqual(expected);
      }
    }
  });
});

/** All orderings, capped — the vector sets are tiny by design. */
function permutations<T>(items: readonly T[]): T[][] {
  if (items.length <= 1) return [[...items]];
  if (items.length > 6) return [[...items], [...items].reverse()];

  const out: T[][] = [];
  for (let i = 0; i < items.length; i++) {
    const rest = [...items.slice(0, i), ...items.slice(i + 1)];
    for (const tail of permutations(rest)) out.push([items[i], ...tail]);
  }
  return out;
}
