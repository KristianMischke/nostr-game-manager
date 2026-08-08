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

export interface UnsignedEvent {
  pubkey: Hex;
  created_at: number;
  kind: number;
  tags: Tag[];
  content: string;
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
