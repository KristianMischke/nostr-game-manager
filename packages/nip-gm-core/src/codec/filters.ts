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
  const kinds = options.includeMessages
    ? gameKinds(mode)
    : mode === 'casual'
      ? [KIND.STATE_EPHEMERAL, KIND.STATE]
      : [KIND.STATE];
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

/** Lobby address for a GM and lobby id. */
export function lobbyAddress(gm: Hex, lobbyId: string): AddressPointer {
  return { kind: KIND.LOBBY, pubkey: gm, identifier: lobbyId };
}

/** Announcement address for a GM and game module id. */
export function announcementAddress(gm: Hex, game: string): AddressPointer {
  return { kind: KIND.GM_ANNOUNCEMENT, pubkey: gm, identifier: game };
}

export { formatAddress };
