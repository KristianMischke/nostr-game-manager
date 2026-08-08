/**
 * Minimal structural Nostr types.
 *
 * These are deliberately *ours*, not re-exports from NDK or nostr-tools. Core
 * never imports a nostr library, so an adapter can map any client's event type
 * onto these shapes, and a future C#/Rust/Python port has a fixed wire contract
 * to target rather than a library's object model.
 */

/** 64-char lowercase hex pubkey or event id. Never bech32 — see NIP-GM §Identifiers. */
export type Hex = string;

/**
 * A tag is an ordered array of strings; position is meaningful.
 *
 * Tag ORDER MATTERS and must be preserved end to end: the order of `p` tags in
 * a game start event defines seat order (NIP-GM §Start), it is covered by the
 * GM's signature, and it is a module input. Never round-trip tags through a Map
 * or a plain object keyed by tag name — that silently destroys seat order.
 */
export type Tag = string[];

/**
 * What a codec's `build*` function returns: everything about an event except
 * the parts only a signer can supply. The caller adds `pubkey` and `created_at`
 * and signs.
 */
export interface EventTemplate {
  kind: number;
  tags: Tag[];
  content: string;
}

export interface UnsignedEvent extends EventTemplate {
  pubkey: Hex;
  created_at: number;
}

export interface NostrEvent extends UnsignedEvent {
  id: Hex;
  sig: Hex;
}

/** A relay subscription filter. Only the subset NIP-GM actually needs. */
export interface Filter {
  ids?: Hex[];
  authors?: Hex[];
  kinds?: number[];
  since?: number;
  until?: number;
  limit?: number;
  /** Indexed tag filters, e.g. `'#e'`, `'#p'`, `'#a'`, `'#d'`. */
  [tagFilter: `#${string}`]: string[] | undefined;
}

/**
 * Coordinates of an addressable event: `<kind>:<pubkey>:<d-tag>`.
 * Used for lobbies (`32601:<gm>:<lobby_id>`) and GM announcements
 * (`32600:<gm>:<game_module_id>`).
 */
export interface AddressPointer {
  kind: number;
  pubkey: Hex;
  identifier: string;
}

/**
 * Parse outcome.
 *
 * Everything arriving from a relay is untrusted, so codecs never throw on bad
 * input and never return a half-built value — a malformed event is a normal
 * occurrence, not an exception. `error` is a short stable code so that ports in
 * other languages can agree on rejections (see `vectors/codec`).
 */
export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

export function ok<T>(value: T): ParseResult<T> {
  return { ok: true, value };
}

export function fail<T = never>(error: string): ParseResult<T> {
  return { ok: false, error };
}
