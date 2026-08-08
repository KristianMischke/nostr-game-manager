/**
 * Loader and runner for the language-neutral vector corpus in `/vectors`.
 *
 * This lives in `nip-gm-testing` rather than in core because core is forbidden
 * from importing node builtins — that restriction is what keeps it portable, and
 * reading fixture files off disk is exactly the kind of thing it must not learn
 * to do. A port in another language reimplements this runner against the same
 * JSON.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseAnnouncement,
  parseDiscovery,
  parseHead,
  parseLobby,
  parseMessage,
  parseState,
  type EventTemplate,
  type NostrEvent,
  type ParseResult,
} from 'nip-gm-core';

export type CodecName = 'announcement' | 'lobby' | 'discovery' | 'message' | 'state' | 'head';

export interface VectorCase {
  name: string;
  event: EventTemplate & Partial<NostrEvent>;
  /** Full expected result. */
  expect?: { ok: true; value: unknown } | { ok: false; error: string };
  /** Expect success, and assert only these fields of the parsed value. */
  expectSubset?: Record<string, unknown>;
  /** Lobby only: assert player order exactly. */
  expectPlayerOrder?: string[];
  /** Delta only: assert the normalized `applied` array. */
  expectApplied?: unknown[];
}

export interface VectorFile {
  codec: CodecName;
  cases: VectorCase[];
}

const PARSERS: Record<CodecName, (e: NostrEvent) => ParseResult<unknown>> = {
  announcement: parseAnnouncement,
  lobby: parseLobby,
  discovery: parseDiscovery,
  message: parseMessage,
  state: parseState,
  head: parseHead,
};

/** Repo-root `/vectors`, resolved relative to this file rather than to cwd. */
export function vectorsRoot(): string {
  return fileURLToPath(new URL('../../../vectors/', import.meta.url));
}

export function loadVectorFiles(category = 'codec'): { file: string; data: VectorFile }[] {
  const dir = join(vectorsRoot(), category);
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((file) => ({
      file,
      data: JSON.parse(readFileSync(join(dir, file), 'utf8')) as VectorFile,
    }));
}

/** Fill in the fields a codec never inspects, so vectors stay readable. */
export function asEvent(partial: VectorCase['event']): NostrEvent {
  return {
    id: '0'.repeat(64),
    pubkey: '0'.repeat(64),
    created_at: 1_700_000_000,
    sig: '0'.repeat(64),
    ...partial,
  };
}

export function runCase(codec: CodecName, vector: VectorCase): ParseResult<unknown> {
  return PARSERS[codec](asEvent(vector.event));
}
