/**
 * GM announcement — kind 32600, addressable, `d` = game module id.
 *
 * NIP-GM §GM Announcement. One per supported game, so clients can browse a
 * directory even when the GM is not answering discovery. Clients should treat
 * this as the source of truth for compatibility, and a discovery offer only as
 * a liveness signal.
 */
import { KIND, type PersistenceMode } from '../kinds.js';
import {
  fail,
  ok,
  type EventTemplate,
  type NostrEvent,
  type ParseResult,
  type Tag,
} from '../types.js';
import { optionalInt, optionalString, parseJsonObject, stringArray } from './json.js';
import { tagRest, tagValue } from './tags.js';

export interface AnnouncementConfig {
  name: string;
  about?: string;
  icon?: string;
  /** Omitted means unlimited. */
  maxConcurrentGames?: number;
  capabilities: string[];
}

export interface GMAnnouncement {
  /** Reverse-domain game module id — the `d` tag. */
  game: string;
  version: string;
  rulesHash?: string;
  relays: string[];
  modes: PersistenceMode[];
  config: AnnouncementConfig;
}

export function buildAnnouncement(a: GMAnnouncement): EventTemplate {
  const tags: Tag[] = [
    ['d', a.game],
    ['version', a.version],
  ];
  if (a.rulesHash) tags.push(['rules_hash', a.rulesHash]);
  if (a.relays.length) tags.push(['relays', ...a.relays]);
  if (a.modes.length) tags.push(['modes', ...a.modes]);

  const config: Record<string, unknown> = {
    name: a.config.name,
    capabilities: a.config.capabilities,
  };
  if (a.config.about) config.about = a.config.about;
  if (a.config.icon) config.icon = a.config.icon;
  if (a.config.maxConcurrentGames !== undefined) {
    config.max_concurrent_games = a.config.maxConcurrentGames;
  }

  return { kind: KIND.GM_ANNOUNCEMENT, tags, content: JSON.stringify(config) };
}

export function parseAnnouncement(event: NostrEvent): ParseResult<GMAnnouncement> {
  if (event.kind !== KIND.GM_ANNOUNCEMENT) return fail('wrong_kind');

  const game = tagValue(event.tags, 'd');
  if (!game) return fail('missing_d');

  const version = tagValue(event.tags, 'version');
  if (!version) return fail('missing_version');

  const parsed = parseJsonObject(event.content);
  if (!parsed.ok) return parsed;
  const raw = parsed.value;

  const name = optionalString(raw.name);
  if (!name) return fail('missing_name');

  const modes = tagRest(event.tags, 'modes').filter(
    (m): m is PersistenceMode => m === 'verified' || m === 'casual',
  );

  return ok({
    game,
    version,
    rulesHash: tagValue(event.tags, 'rules_hash'),
    relays: tagRest(event.tags, 'relays'),
    // An announcement with no `modes` tag is not claiming zero modes; it is
    // claiming the default (NIP-GM §Persistence Modes).
    modes: modes.length ? modes : ['verified'],
    config: {
      name,
      about: optionalString(raw.about),
      icon: optionalString(raw.icon),
      maxConcurrentGames: optionalInt(raw.max_concurrent_games),
      capabilities: stringArray(raw.capabilities),
    },
  });
}

/** Filter for browsing announcements, optionally for one game module. */
export function announcementFilter(game?: string) {
  return game
    ? { kinds: [KIND.GM_ANNOUNCEMENT], '#d': [game] }
    : { kinds: [KIND.GM_ANNOUNCEMENT] };
}
