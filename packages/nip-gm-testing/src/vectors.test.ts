import { describe, expect, it } from 'vitest';
import { loadVectorFiles, runCase, type VectorCase } from './vectors.js';

const files = loadVectorFiles('codec');

it('finds the vector corpus', () => {
  // A silently empty corpus would make every suite below vacuously pass.
  expect(files.length).toBeGreaterThan(0);
});

describe.each(files)('vectors/codec/$file', ({ data }) => {
  it('declares at least one case', () => {
    expect(data.cases.length).toBeGreaterThan(0);
  });

  it.each(data.cases.map((c) => [c.name, c] as const))('%s', (_name, vector: VectorCase) => {
    const result = runCase(data.codec, vector);

    if (vector.expect) {
      expect(result).toEqual(vector.expect);
      return;
    }

    if (!result.ok) throw new Error(`expected ok, got ${result.error}`);
    const value = result.value as Record<string, unknown>;

    if (vector.expectSubset) expect(value).toMatchObject(vector.expectSubset);

    if (vector.expectPlayerOrder) {
      const players = value.players as { pubkey: string }[];
      expect(players.map((p) => p.pubkey)).toEqual(vector.expectPlayerOrder);
    }

    if (vector.expectApplied) {
      const content = value.content as { applied: unknown[] };
      expect(content.applied).toEqual(vector.expectApplied);
    }

    const asserted =
      vector.expectSubset ?? vector.expectPlayerOrder ?? vector.expectApplied ?? undefined;
    // A case with no assertions would pass forever without testing anything.
    expect(asserted, 'vector case asserts nothing').toBeDefined();
  });
});
