/**
 * Discovery — kind 21602, ephemeral, both directions.
 *
 * NIP-GM §Discovery. One kind carries request and offer; the offer is
 * distinguished by its `e` tag referencing a request, plus authorship by an
 * announced GM key.
 */
import { KIND } from '../kinds.js';
import {
  fail,
  ok,
  type AddressPointer,
  type EventTemplate,
  type Hex,
  type NostrEvent,
  type ParseResult,
  type Tag,
} from '../types.js';
import { addressTag, formatAddress, intTagValue, isHex64, tagValue } from './tags.js';

export interface DiscoveryRequest {
  type: 'request';
  game: string;
  version: string;
}

export interface DiscoveryOffer {
  type: 'offer';
  /** The request being answered. */
  requestId: Hex;
  player: Hex;
  /** Coordinates of the GM's 32600 announcement. */
  announcement: AddressPointer;
  /** Open seats or lobbies; 0 means full. */
  capacity: number;
}

export type Discovery = DiscoveryRequest | DiscoveryOffer;

export function buildDiscoveryRequest(game: string, version: string): EventTemplate {
  return {
    kind: KIND.DISCOVERY,
    tags: [
      ['game', game],
      ['version', version],
    ],
    content: '',
  };
}

export function buildDiscoveryOffer(offer: Omit<DiscoveryOffer, 'type'>): EventTemplate {
  const tags: Tag[] = [
    ['e', offer.requestId],
    ['p', offer.player],
    ['a', formatAddress(offer.announcement)],
    ['capacity', String(offer.capacity)],
  ];
  return { kind: KIND.DISCOVERY, tags, content: '' };
}

export function parseDiscovery(event: NostrEvent): ParseResult<Discovery> {
  if (event.kind !== KIND.DISCOVERY) return fail('wrong_kind');

  const requestId = tagValue(event.tags, 'e');

  // An `e` tag is what makes this an offer rather than a request.
  if (requestId !== undefined) {
    if (!isHex64(requestId)) return fail('bad_request_id');

    const player = tagValue(event.tags, 'p');
    if (!isHex64(player)) return fail('bad_player');

    const announcement = addressTag(event.tags);
    if (!announcement) return fail('bad_announcement_address');
    if (announcement.kind !== KIND.GM_ANNOUNCEMENT) return fail('wrong_announcement_kind');

    const capacity = intTagValue(event.tags, 'capacity');
    if (capacity === undefined) return fail('bad_capacity');

    return ok({ type: 'offer', requestId, player, announcement, capacity });
  }

  const game = tagValue(event.tags, 'game');
  if (!game) return fail('missing_game');

  const version = tagValue(event.tags, 'version');
  if (!version) return fail('missing_version');

  return ok({ type: 'request', game, version });
}
