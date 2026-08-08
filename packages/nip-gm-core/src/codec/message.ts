/**
 * Game messages — kinds 2600 (regular) / 21600 (ephemeral mirror).
 *
 * NIP-GM §Game Messages. All player↔GM traffic rides one kind, differentiated
 * by an `action` tag and by author: the GM's pubkey is known from its
 * announcement, so player→GM and GM→player traffic are unambiguous without a
 * separate kind for each direction.
 */
import { KIND, messageKind, type PersistenceMode } from '../kinds.js';
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
import { parseJsonObject } from './json.js';
import {
  addressTag,
  formatAddress,
  isHex64,
  referencedEventId,
  rootEventId,
  rootTag,
  tagValue,
} from './tags.js';

export type PlayerAction = 'create' | 'join' | 'leave' | 'ready' | 'move' | 'presence';
export type MessageAction = PlayerAction | 'response';

interface Base {
  /** Recipient — the GM for player actions, the player for responses. */
  recipient: Hex;
  /**
   * Raw content, exactly as it appeared. May be NIP-44 ciphertext; the codec
   * neither decrypts nor guesses, since only the holder of a key can tell.
   */
  content: string;
}

export interface CreateMessage extends Base {
  action: 'create';
  /** The GM announcement being asked to open a lobby. */
  announcement: AddressPointer;
}

export interface LobbyMessage extends Base {
  action: 'join' | 'leave' | 'ready';
  lobby: AddressPointer;
  /** On a `ready` from the lobby leader, `["intent", "start"]` starts the game. */
  intent?: string;
}

export interface MoveMessage extends Base {
  action: 'move';
  gameId: Hex;
  /**
   * Present when the move is hidden information: the player's per-round
   * ephemeral pubkey, to which the GM's conversation-key reveal will apply.
   */
  ephemeral?: Hex;
}

export interface PresenceMessage extends Base {
  action: 'presence';
  gameId: Hex;
}

export interface ResponseMessage extends Base {
  action: 'response';
  /** The player message being answered. */
  target: Hex;
  gameId?: Hex;
}

export type GameMessage =
  | CreateMessage
  | LobbyMessage
  | MoveMessage
  | PresenceMessage
  | ResponseMessage;

/** Structured GM response content (NIP-GM §Game Messages — GM responses). */
export type ResponseBody =
  | { status: 'accepted'; lobby?: string }
  | { status: 'applied'; state: Hex }
  | { status: 'rejected'; reason: string };

export function buildCreate(
  announcement: AddressPointer,
  gm: Hex,
  encryptedContent: string,
  mode: PersistenceMode = 'verified',
): EventTemplate {
  return {
    kind: messageKind(mode),
    tags: [
      ['action', 'create'],
      ['a', formatAddress(announcement)],
      ['p', gm],
    ],
    content: encryptedContent,
  };
}

export function buildLobbyAction(
  action: 'join' | 'leave' | 'ready',
  lobby: AddressPointer,
  gm: Hex,
  content = '',
  options: { intent?: string; mode?: PersistenceMode } = {},
): EventTemplate {
  const tags: Tag[] = [
    ['action', action],
    ['a', formatAddress(lobby)],
    ['p', gm],
  ];
  if (options.intent) tags.push(['intent', options.intent]);
  return { kind: messageKind(options.mode ?? 'verified'), tags, content };
}

export function buildMove(
  gameId: Hex,
  gm: Hex,
  content: string,
  options: { ephemeral?: Hex; relay?: string; mode?: PersistenceMode } = {},
): EventTemplate {
  const tags: Tag[] = [
    ['action', 'move'],
    rootTag(gameId, options.relay),
    ['p', gm],
  ];
  if (options.ephemeral) tags.push(['ephemeral', options.ephemeral]);
  return { kind: messageKind(options.mode ?? 'verified'), tags, content };
}

export function buildResponse(
  target: Hex,
  player: Hex,
  body: ResponseBody,
  options: { gameId?: Hex; relay?: string; mode?: PersistenceMode } = {},
): EventTemplate {
  const tags: Tag[] = [
    ['action', 'response'],
    ['e', target],
    ['p', player],
  ];
  if (options.gameId) tags.push(rootTag(options.gameId, options.relay));
  return {
    kind: messageKind(options.mode ?? 'verified'),
    tags,
    content: JSON.stringify(body),
  };
}

export function parseMessage(event: NostrEvent): ParseResult<GameMessage> {
  if (event.kind !== KIND.MESSAGE && event.kind !== KIND.MESSAGE_EPHEMERAL) {
    return fail('wrong_kind');
  }

  const action = tagValue(event.tags, 'action');
  if (!action) return fail('missing_action');

  const recipient = tagValue(event.tags, 'p');
  if (!isHex64(recipient)) return fail('bad_recipient');

  const base: Base = { recipient, content: event.content };

  switch (action) {
    case 'create': {
      const announcement = addressTag(event.tags);
      if (!announcement) return fail('bad_announcement_address');
      if (announcement.kind !== KIND.GM_ANNOUNCEMENT) return fail('wrong_announcement_kind');
      return ok({ ...base, action: 'create', announcement });
    }

    case 'join':
    case 'leave':
    case 'ready': {
      const lobby = addressTag(event.tags);
      if (!lobby) return fail('bad_lobby_address');
      if (lobby.kind !== KIND.LOBBY) return fail('wrong_lobby_kind');
      return ok({ ...base, action, lobby, intent: tagValue(event.tags, 'intent') });
    }

    case 'move': {
      const gameId = rootEventId(event.tags);
      if (!gameId) return fail('missing_root');
      const ephemeral = tagValue(event.tags, 'ephemeral');
      if (ephemeral !== undefined && !isHex64(ephemeral)) return fail('bad_ephemeral');
      return ok({ ...base, action: 'move', gameId, ephemeral });
    }

    case 'presence': {
      const gameId = rootEventId(event.tags);
      if (!gameId) return fail('missing_root');
      return ok({ ...base, action: 'presence', gameId });
    }

    case 'response': {
      // Unmarked `e` is the message answered; the root `e` is the game.
      const target = referencedEventId(event.tags);
      if (!target) return fail('missing_target');
      return ok({ ...base, action: 'response', target, gameId: rootEventId(event.tags) });
    }

    default:
      return fail('unknown_action');
  }
}

export function parseResponseBody(content: string): ParseResult<ResponseBody> {
  const parsed = parseJsonObject(content);
  if (!parsed.ok) return parsed;
  const raw = parsed.value;

  switch (raw.status) {
    case 'accepted':
      return ok({
        status: 'accepted',
        lobby: typeof raw.lobby === 'string' ? raw.lobby : undefined,
      });
    case 'applied':
      return isHex64(raw.state) ? ok({ status: 'applied', state: raw.state }) : fail('bad_state');
    case 'rejected':
      return typeof raw.reason === 'string' && raw.reason.length > 0
        ? ok({ status: 'rejected', reason: raw.reason })
        : fail('bad_reason');
    default:
      return fail('bad_status');
  }
}
