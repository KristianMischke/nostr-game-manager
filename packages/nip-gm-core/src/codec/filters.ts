/**
 * The subscription filters this protocol needs.
 *
 * NIP-GM §Event Kinds: relay-side filtering happens on kind, `#e` (game id),
 * `#a` (lobby) and `#p` (recipient / next actor). Message subtypes live in
 * non-indexed tags deliberately, so there is no filter here that selects on
 * `action` or `state` — that discrimination happens client-side after parsing.
 */
import { KIND, gameKinds, type PersistenceMode } from '../kinds.js';
import { formatAddress } from './tags.js';
import type { AddressPointer, Filter, Hex } from '../types.js';

/** Everything belonging to one game: state events, and optionally raw moves. */
export function gameFilter(
  gameId: Hex,
  options: { mode?: PersistenceMode; includeMessages?: boolean } = {},
): Filter {
  const mode = options.mode ?? 'verified';
  // Both modes include the ephemeral state kind: `status` rides it regardless of
  // mode, so a verified-mode client that filtered it out would never learn the
  // GM had received its move.
  const kinds = options.includeMessages
    ? gameKinds(mode)
    : [KIND.STATE, KIND.STATE_EPHEMERAL];
  return { kinds, '#e': [gameId] };
}

/**
 * Turn notifications across every game a player is in.
 *
 * This is the subscription that makes async play work: deltas carry a `p` tag
 * per player expected to act next, so one filter yields "your turn" everywhere
 * (NIP-GM §Deltas).
 */
export function myTurnFilter(pubkey: Hex, mode: PersistenceMode = 'verified'): Filter {
  return {
    kinds: mode === 'casual' ? [KIND.STATE_EPHEMERAL, KIND.STATE] : [KIND.STATE],
    '#p': [pubkey],
  };
}

/** Private state addressed to me within one game. */
export function myPrivateStateFilter(gameId: Hex, pubkey: Hex): Filter {
  return { kinds: [KIND.STATE, KIND.STATE_EPHEMERAL], '#e': [gameId], '#p': [pubkey] };
}

/** Messages addressed to a GM — what the daemon listens on. */
export function inboxFilter(gm: Hex, since?: number): Filter {
  return { kinds: [KIND.MESSAGE, KIND.MESSAGE_EPHEMERAL], '#p': [gm], ...(since ? { since } : {}) };
}

/** Responses addressed to me, for immediate feedback on join/move. */
export function myResponsesFilter(pubkey: Hex, gm: Hex): Filter {
  return { kinds: [KIND.MESSAGE, KIND.MESSAGE_EPHEMERAL], '#p': [pubkey], authors: [gm] };
}

/** One lobby, by address. */
export function lobbyFilter(lobby: AddressPointer): Filter {
  return { kinds: [KIND.LOBBY], authors: [lobby.pubkey], '#d': [lobby.identifier] };
}

/** Open public lobbies for a game module, optionally from specific GMs. */
export function openLobbiesFilter(game: string, gms?: Hex[]): Filter {
  return { kinds: [KIND.LOBBY], '#game': [game], ...(gms ? { authors: gms } : {}) };
}

/** The head snapshot for a game. */
export function headFilter(gm: Hex, gameId: Hex): Filter {
  return { kinds: [KIND.GAME_HEAD], authors: [gm], '#d': [gameId] };
}

/** Messages referencing a game — the raw move log, for auditing. */
export function gameMessagesFilter(gameId: Hex): Filter {
  return { kinds: [KIND.MESSAGE, KIND.MESSAGE_EPHEMERAL], '#e': [gameId] };
}

/** Everything an auditor needs to verify a finished game (NIP-GM §Verification). */
export function auditFilters(gameId: Hex): Filter[] {
  return [
    { kinds: [KIND.STATE], '#e': [gameId] },
    { kinds: [KIND.MESSAGE], '#e': [gameId] },
    { ids: [gameId] },
  ];
}

/** Discovery offers answering my request. */
export function offersFilter(requestId: Hex): Filter {
  return { kinds: [KIND.DISCOVERY], '#e': [requestId] };
}

/**
 * Discovery traffic — what a GM listens on to answer requests.
 *
 * Deliberately untagged. A request carries `["game", ...]`, which is a
 * multi-character tag no relay is obliged to index, and a GM that filtered on it
 * would answer nothing at all on a relay that does not — the one failure mode
 * worth avoiding here, since silence from a live GM reads to a client as "this
 * GM is down". The kind is ephemeral and its volume is one event per client
 * poll, so taking the lot and discriminating after `parseDiscovery` costs
 * nothing. Offers (this GM's own, and other GMs') match too; they parse as
 * offers and are ignored.
 */
export function discoveryFilter(): Filter {
  return { kinds: [KIND.DISCOVERY] };
}

/** Lobby address for a GM and lobby id. */
export function lobbyAddress(gm: Hex, lobbyId: string): AddressPointer {
  return { kind: KIND.LOBBY, pubkey: gm, identifier: lobbyId };
}

/** Announcement address for a GM and game module id. */
export function announcementAddress(gm: Hex, game: string): AddressPointer {
  return { kind: KIND.GM_ANNOUNCEMENT, pubkey: gm, identifier: game };
}

export { formatAddress };
