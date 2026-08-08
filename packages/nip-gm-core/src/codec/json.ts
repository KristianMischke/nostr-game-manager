/** Shared helpers for decoding untrusted JSON out of event content. */
import { fail, ok, type ParseResult } from '../types.js';

export type JsonObject = Record<string, unknown>;

export function parseJsonObject(content: string): ParseResult<JsonObject> {
  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch {
    return fail('malformed_json');
  }
  // Arrays and null are typeof 'object'; neither is a valid content payload here.
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return fail('not_an_object');
  }
  return ok(raw as JsonObject);
}

export function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function optionalInt(value: unknown): number | undefined {
  return Number.isSafeInteger(value) ? (value as number) : undefined;
}

export function intOr(value: unknown, fallback: number): number {
  return Number.isSafeInteger(value) ? (value as number) : fallback;
}

export function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

/**
 * Serialize with keys in a stable order, recursively.
 *
 * Snapshots and vectors are compared as bytes, so two runs that produce equal
 * values must produce equal text. JS object key order is insertion order (with
 * integer-like keys hoisted and sorted), which is exactly the kind of incidental
 * detail that differs between a GM building state forward and an auditor
 * rebuilding it from a log.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value === null || typeof value !== 'object') return value;
  const source = value as JsonObject;
  const out: JsonObject = {};
  for (const key of Object.keys(source).sort()) out[key] = sortKeys(source[key]);
  return out;
}
