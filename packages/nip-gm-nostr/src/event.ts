/**
 * Conversion across the NDK boundary.
 *
 * Core's `NostrEvent` is a plain structural type it defines itself (see
 * `nip-gm-core/types.ts`) and it must never see an `NDKEvent` — that is the
 * whole reason this package exists. Everything crossing the boundary in either
 * direction goes through here.
 */
import { NDKEvent, type NDKRawEvent } from '@nostr-dev-kit/ndk';
import type NDK from '@nostr-dev-kit/ndk';
import type { NostrEvent, Tag } from 'nip-gm-core';

/**
 * Narrow an NDK event to core's shape, or `undefined` if it is not a complete
 * signed event.
 *
 * Returning `undefined` rather than throwing is deliberate: relays deliver
 * whatever they like, and NDK's own type allows `id`/`sig`/`pubkey` to be
 * absent. A malformed event on a subscription is an ordinary occurrence that
 * should be dropped, not an exception that unwinds a game session.
 *
 * Tags are copied element-wise. NDK hands back its own arrays, and `Tag` order
 * — including the order of `p` tags, which is seat order — is covered by the
 * signature, so an aliased array a caller could mutate is a real hazard.
 */
export function toNostrEvent(event: NDKEvent | NDKRawEvent): NostrEvent | undefined {
  const raw: NDKRawEvent = event instanceof NDKEvent ? event.rawEvent() : event;

  if (typeof raw.id !== 'string' || raw.id.length !== 64) return undefined;
  if (typeof raw.sig !== 'string' || raw.sig.length !== 128) return undefined;
  if (typeof raw.pubkey !== 'string' || raw.pubkey.length !== 64) return undefined;
  if (typeof raw.kind !== 'number') return undefined;
  if (typeof raw.created_at !== 'number') return undefined;
  if (typeof raw.content !== 'string') return undefined;
  if (!Array.isArray(raw.tags)) return undefined;

  const tags: Tag[] = [];
  for (const tag of raw.tags) {
    if (!Array.isArray(tag)) return undefined;
    if (!tag.every((v) => typeof v === 'string')) return undefined;
    tags.push([...tag]);
  }

  return {
    id: raw.id,
    pubkey: raw.pubkey,
    created_at: raw.created_at,
    kind: raw.kind,
    tags,
    content: raw.content,
    sig: raw.sig,
  };
}

/**
 * Wrap a fully-signed core event for publication.
 *
 * The event already carries `id` and `sig`, so NDK's `publish()` will not try
 * to re-sign it — which matters, because the instance may have no signer at all
 * (a spectator publishing nothing, or a GM whose signing happens in core).
 */
export function toNDKEvent(ndk: NDK, event: NostrEvent): NDKEvent {
  return new NDKEvent(ndk, {
    id: event.id,
    pubkey: event.pubkey,
    created_at: event.created_at,
    kind: event.kind,
    tags: event.tags.map((tag) => [...tag]),
    content: event.content,
    sig: event.sig,
  });
}
