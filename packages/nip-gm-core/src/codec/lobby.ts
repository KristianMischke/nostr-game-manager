/**
 * Lobby — kind 32601, addressable, `d` = lobby id.
 *
 * NIP-GM §Lobby. Published and replaced by the GM as membership and status
 * change, so a client watching the address always sees current membership
 * without replaying joins.
 */
import { KIND, type PersistenceMode } from '../kinds.js';
import {
  fail,
  ok,
  type EventTemplate,
  type Hex,
  type NostrEvent,
  type ParseResult,
  type Tag,
} from '../types.js';
import { intOr, optionalString, parseJsonObject } from './json.js';
import { isHex64, rootEventId, tagRest, tagValue, tagsNamed } from './tags.js';

export type Visibility = 'public' | 'private';
export type JoinWindow = 'before' | 'anytime';
export type LobbyStatus = 'open' | 'starting' | 'active' | 'closed';
export type PlayerState = 'joined' | 'ready';

/** NIP-GM §Behaviors — Start condition. */
export type StartCondition =
  | { kind: 'ready' }
  | { kind: 'timer'; seconds: number }
  | { kind: 'leader' };

export interface LobbyPlayer {
  pubkey: Hex;
  relay?: string;
  state: PlayerState;
}

export interface LobbyConfig {
  name: string;
  mode: PersistenceMode;
  minPlayers: number;
  maxPlayers: number;
  /** Seconds; 0 = none, which is what makes a game async-friendly. */
  turnTimeout: number;
  /** Module-defined system input applied on timeout. */
  timeoutAction?: string;
  /** Replace the head snapshot every N deltas. */
  snapshotInterval: number;
  /** Seconds to delay public deltas; 0 = live spectating. */
  spectatorDelay: number;
  /** Module-defined settings, passed through untouched. */
  config: unknown;
}

export interface Lobby {
  lobbyId: string;
  game: string;
  version: string;
  visibility: Visibility;
  join: JoinWindow;
  start: StartCondition;
  /** Required when `start.kind === 'leader'`. */
  leader?: Hex;
  status: LobbyStatus;
  /** Joined players, in document order. */
  players: LobbyPlayer[];
  relays: string[];
  /** Present once `status === 'active'`. */
  gameId?: Hex;
  config: LobbyConfig;
}

export function formatStartCondition(start: StartCondition): string {
  return start.kind === 'timer' ? `timer:${start.seconds}` : start.kind;
}

export function parseStartCondition(raw: string | undefined): StartCondition | undefined {
  if (raw === 'ready') return { kind: 'ready' };
  if (raw === 'leader') return { kind: 'leader' };
  if (raw?.startsWith('timer:')) {
    const rest = raw.slice('timer:'.length);
    if (!/^\d+$/.test(rest)) return undefined;
    const seconds = Number(rest);
    return Number.isSafeInteger(seconds) ? { kind: 'timer', seconds } : undefined;
  }
  return undefined;
}

export function buildLobby(lobby: Lobby): EventTemplate {
  const tags: Tag[] = [
    ['d', lobby.lobbyId],
    ['game', lobby.game],
    ['version', lobby.version],
    ['visibility', lobby.visibility],
    ['join', lobby.join],
    ['start', formatStartCondition(lobby.start)],
  ];
  if (lobby.leader) tags.push(['leader', lobby.leader]);
  tags.push(['status', lobby.status]);

  // Player order is preserved; it becomes seat order at start.
  for (const p of lobby.players) tags.push(['p', p.pubkey, p.relay ?? '', p.state]);

  if (lobby.relays.length) tags.push(['relays', ...lobby.relays]);
  if (lobby.gameId) tags.push(['e', lobby.gameId, '', 'root']);

  const config: Record<string, unknown> = {
    name: lobby.config.name,
    mode: lobby.config.mode,
    min_players: lobby.config.minPlayers,
    max_players: lobby.config.maxPlayers,
    turn_timeout: lobby.config.turnTimeout,
    snapshot_interval: lobby.config.snapshotInterval,
    spectator_delay: lobby.config.spectatorDelay,
    config: lobby.config.config ?? {},
  };
  if (lobby.config.timeoutAction) config.timeout_action = lobby.config.timeoutAction;

  return { kind: KIND.LOBBY, tags, content: JSON.stringify(config) };
}

export function parseLobby(event: NostrEvent): ParseResult<Lobby> {
  if (event.kind !== KIND.LOBBY) return fail('wrong_kind');

  const lobbyId = tagValue(event.tags, 'd');
  if (!lobbyId) return fail('missing_d');

  const game = tagValue(event.tags, 'game');
  if (!game) return fail('missing_game');

  const version = tagValue(event.tags, 'version');
  if (!version) return fail('missing_version');

  const start = parseStartCondition(tagValue(event.tags, 'start'));
  if (!start) return fail('bad_start');

  const leader = tagValue(event.tags, 'leader');
  // A leader-started lobby with no leader can never start — reject it rather
  // than surfacing a lobby that looks joinable.
  if (start.kind === 'leader' && !isHex64(leader)) return fail('missing_leader');

  const visibility = tagValue(event.tags, 'visibility');
  if (visibility !== 'public' && visibility !== 'private') return fail('bad_visibility');

  const join = tagValue(event.tags, 'join');
  if (join !== 'before' && join !== 'anytime') return fail('bad_join');

  const status = tagValue(event.tags, 'status');
  if (status !== 'open' && status !== 'starting' && status !== 'active' && status !== 'closed') {
    return fail('bad_status');
  }

  const parsed = parseJsonObject(event.content);
  if (!parsed.ok) return parsed;
  const raw = parsed.value;

  const mode = raw.mode === 'casual' ? 'casual' : 'verified';

  const players: LobbyPlayer[] = tagsNamed(event.tags, 'p')
    .filter((t) => isHex64(t[1]))
    .map((t) => ({
      pubkey: t[1] as Hex,
      relay: t[2] || undefined,
      state: t[3] === 'ready' ? 'ready' : 'joined',
    }));

  return ok({
    lobbyId,
    game,
    version,
    visibility,
    join,
    start,
    leader: isHex64(leader) ? leader : undefined,
    status,
    players,
    relays: tagRest(event.tags, 'relays'),
    gameId: rootEventId(event.tags),
    config: {
      name: optionalString(raw.name) ?? '',
      mode,
      minPlayers: intOr(raw.min_players, 2),
      maxPlayers: intOr(raw.max_players, 2),
      turnTimeout: intOr(raw.turn_timeout, 0),
      timeoutAction: optionalString(raw.timeout_action),
      snapshotInterval: intOr(raw.snapshot_interval, 10),
      spectatorDelay: intOr(raw.spectator_delay, 0),
      config: raw.config ?? {},
    },
  });
}

/** Whether the lobby is accepting joins right now (NIP-GM §Behaviors — Join window). */
export function acceptsJoins(lobby: Lobby): boolean {
  if (lobby.players.length >= lobby.config.maxPlayers) return false;
  if (lobby.status === 'open') return true;
  return lobby.join === 'anytime' && lobby.status === 'active';
}

/** Whether start conditions are met. Timer expiry is the caller's to judge. */
export function canStart(lobby: Lobby, now?: number, openedAt?: number): boolean {
  if (lobby.status !== 'open') return false;
  if (lobby.players.length < lobby.config.minPlayers) return false;

  switch (lobby.start.kind) {
    case 'ready':
      return lobby.players.every((p) => p.state === 'ready');
    case 'timer':
      if (now === undefined || openedAt === undefined) return false;
      return now >= openedAt + lobby.start.seconds;
    case 'leader':
      // The leader signals with a ready message carrying ["intent", "start"];
      // the lobby event alone cannot express it.
      return false;
  }
}
