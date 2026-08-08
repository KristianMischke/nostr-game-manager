/**
 * RNG and seed-commitment vectors.
 *
 * Unlike the NIP-44 corpus these are ours, generated from the implementation —
 * their job is to pin a construction that is otherwise only described in prose,
 * so a C#/Rust/Python port can prove it derives identical bytes. The
 * construction itself is documented in `crypto/rng.ts`; if a change here is ever
 * needed it is a protocol change, not a refactor.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import { combineSeeds, createRng, seedCommit, type Hex } from 'nip-gm-core';
import { vectorsRoot } from './vectors.js';

interface StreamCase {
  seed: string;
  game_id: string;
  seq: number;
  label: string;
  bytes_64: string;
  int_6_from_start: number[];
  int_6_after_64_bytes: number[];
  shuffle_8_from_start: number[];
}

interface CommitFile {
  commits: { seed: string; salt: string; commit: string }[];
  combined: { gm_seed: string; player_seeds: Record<string, string>; effective: string }[];
}

const load = <T>(...path: string[]): T =>
  JSON.parse(readFileSync(join(vectorsRoot(), ...path), 'utf8')) as T;

const streams = load<{ cases: StreamCase[] }>('rng', 'streams.json').cases;
const commits = load<CommitFile>('commit', 'seeds.json');

describe('rng/streams', () => {
  it('has cases', () => {
    expect(streams.length).toBeGreaterThan(0);
  });

  it.each(streams.map((c, i) => [`${i}: seq=${c.seq} label=${c.label}`, c] as const))(
    'case %s',
    (_name, c) => {
      const rng = createRng(hexToBytes(c.seed), c.game_id as Hex);

      expect(bytesToHex(rng.at(c.seq, c.label).bytes(64))).toBe(c.bytes_64);

      const fromStart = rng.at(c.seq, c.label);
      expect(Array.from({ length: 5 }, () => fromStart.int(6))).toEqual(c.int_6_from_start);

      // Drawing after 64 bytes crosses two HMAC block boundaries, so this pins
      // the continuation rule a port is most likely to get wrong.
      const advanced = rng.at(c.seq, c.label);
      advanced.bytes(64);
      expect(Array.from({ length: 5 }, () => advanced.int(6))).toEqual(c.int_6_after_64_bytes);

      expect(rng.at(c.seq, c.label).shuffle([0, 1, 2, 3, 4, 5, 6, 7])).toEqual(
        c.shuffle_8_from_start,
      );
    },
  );

  it('gives every case a distinct stream', () => {
    // Guards against an addressing bug that collapsed distinct addresses onto
    // one stream, which the per-case assertions alone would not catch.
    const seen = new Set(streams.map((c) => c.bytes_64));
    expect(seen.size).toBe(streams.length);
  });
});

describe('commit/seeds', () => {
  it.each(commits.commits.map((c, i) => [i, c] as const))('commit case %i', (_i, c) => {
    expect(seedCommit(hexToBytes(c.seed), hexToBytes(c.salt))).toBe(c.commit);
  });

  it.each(commits.combined.map((c, i) => [i, c] as const))('combined case %i', (_i, c) => {
    const seeds = Object.fromEntries(
      Object.entries(c.player_seeds).map(([k, v]) => [k, hexToBytes(v)]),
    );
    expect(bytesToHex(combineSeeds(hexToBytes(c.gm_seed), seeds))).toBe(c.effective);
  });

  it('combines independently of contribution order', () => {
    const withPlayers = commits.combined.find((c) => Object.keys(c.player_seeds).length > 1);
    expect(withPlayers, 'expected a multi-player case').toBeDefined();

    const entries = Object.entries(withPlayers!.player_seeds).map(
      ([k, v]) => [k, hexToBytes(v)] as const,
    );
    const forward = combineSeeds(hexToBytes(withPlayers!.gm_seed), Object.fromEntries(entries));
    const reversed = combineSeeds(
      hexToBytes(withPlayers!.gm_seed),
      Object.fromEntries([...entries].reverse()),
    );
    expect(bytesToHex(forward)).toBe(bytesToHex(reversed));
    expect(bytesToHex(forward)).toBe(withPlayers!.effective);
  });
});
