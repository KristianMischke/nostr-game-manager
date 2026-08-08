/**
 * Tag accessors.
 *
 * Everything here treats `Tag[]` as an ordered sequence, because in NIP-GM it
 * is one: the order of `p` tags in a start event defines seat order, is covered
 * by the GM's signature, and feeds the game module. No function in this file
 * builds a lookup keyed by tag name and iterates it — that is the one shortcut
 * that would quietly corrupt a game.
 */
import type { AddressPointer, Hex, Tag } from '../types.js';

const HEX64 = /^[0-9a-f]{64}$/;

/** 64-char lowercase hex, as NIP-GM §Identifiers requires in every tag value. */
export function isHex64(value: unknown): value is Hex {
  return typeof value === 'string' && HEX64.test(value);
}

/** Every tag with the given name, in document order. */
export function tagsNamed(tags: readonly Tag[], name: string): Tag[] {
  return tags.filter((t) => t[0] === name);
}

/** The first value of the first tag with the given name. */
export function tagValue(tags: readonly Tag[], name: string): string | undefined {
  return tags.find((t) => t[0] === name)?.[1];
}

/** The first value of every tag with the given name, in document order. */
export function tagValues(tags: readonly Tag[], name: string): string[] {
  return tagsNamed(tags, name)
    .map((t) => t[1])
    .filter((v): v is string => v !== undefined);
}

/**
 * All values of the *first* tag with the given name.
 *
 * For the multi-value tags NIP-GM uses — `["relays", "wss://a", "wss://b"]`,
 * `["modes", "verified", "casual"]` — where the values live in one tag rather
 * than one tag each.
 */
export function tagRest(tags: readonly Tag[], name: string): string[] {
  const tag = tags.find((t) => t[0] === name);
  return tag ? tag.slice(1) : [];
}

/** An `e` tag, decomposed. */
export interface ETag {
  id: Hex;
  relay?: string;
  marker?: string;
}

/** Every `e` tag, in document order. */
export function eTags(tags: readonly Tag[]): ETag[] {
  return tagsNamed(tags, 'e')
    .filter((t) => isHex64(t[1]))
    .map((t) => ({
      id: t[1] as Hex,
      relay: t[2] || undefined,
      marker: t[3] || undefined,
    }));
}

/**
 * The game id: the first `e` tag marked `root`.
 *
 * NIP-GM §Start — every event after the start event carries
 * `["e", "<game_id>", "<relay hint>", "root"]`, so one `#e` filter follows a
 * whole game.
 */
export function rootEventId(tags: readonly Tag[]): Hex | undefined {
  return eTags(tags).find((e) => e.marker === 'root')?.id;
}

/**
 * The event this one answers: the first unmarked `e` tag.
 *
 * GM responses carry both an unmarked `e` (the player message being answered)
 * and a root `e` (the game), so the two must not be confused.
 */
export function referencedEventId(tags: readonly Tag[]): Hex | undefined {
  return eTags(tags).find((e) => e.marker === undefined)?.id;
}

/**
 * Pubkeys from `p` tags, **in document order**.
 *
 * In a start event this is seat order. Callers must not sort the result.
 */
export function pubkeys(tags: readonly Tag[]): Hex[] {
  return tagValues(tags, 'p').filter(isHex64);
}

/** `<kind>:<pubkey>:<identifier>` */
export function formatAddress(pointer: AddressPointer): string {
  return `${pointer.kind}:${pointer.pubkey}:${pointer.identifier}`;
}

export function parseAddress(value: string | undefined): AddressPointer | undefined {
  if (!value) return undefined;
  // The identifier may itself contain ':', so split only the first two fields.
  const first = value.indexOf(':');
  const second = value.indexOf(':', first + 1);
  if (first < 0 || second < 0) return undefined;

  const kind = Number(value.slice(0, first));
  const pubkey = value.slice(first + 1, second);
  const identifier = value.slice(second + 1);

  if (!Number.isInteger(kind) || kind < 0) return undefined;
  if (!isHex64(pubkey)) return undefined;
  return { kind, pubkey, identifier };
}

/** The first `a` tag, parsed. */
export function addressTag(tags: readonly Tag[]): AddressPointer | undefined {
  return parseAddress(tagValue(tags, 'a'));
}

/** A non-negative integer tag value, e.g. `["seq", "13"]`. */
export function intTagValue(tags: readonly Tag[], name: string): number | undefined {
  const raw = tagValue(tags, name);
  if (raw === undefined) return undefined;
  // Number() would accept '1e3', ' 12 ' and '0x0c'; the wire format is decimal.
  if (!/^\d+$/.test(raw)) return undefined;
  const n = Number(raw);
  return Number.isSafeInteger(n) ? n : undefined;
}

/** Build `["e", id, relay, "root"]`, omitting an absent relay hint correctly. */
export function rootTag(gameId: Hex, relay = ''): Tag {
  return ['e', gameId, relay, 'root'];
}
