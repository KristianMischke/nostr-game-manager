/**
 * Game head — kind 32602, addressable, `d` = game id.
 *
 * NIP-GM §Head snapshot. One replaceable event per game holding the latest full
 * public state, refreshed every `snapshot_interval` deltas and at game end.
 * Late joiners and spectators fetch the head plus subsequent deltas rather than
 * the whole log, and a restarting GM recovers from it.
 *
 * History is not lost: the start event and delta log remain authoritative, and
 * the head is only a cache.
 */
import { KIND } from '../kinds.js';
import { fail, ok, type EventTemplate, type Hex, type NostrEvent, type ParseResult } from '../types.js';
import { canonicalJson, parseJsonObject } from './json.js';
import { intTagValue, isHex64, tagValue } from './tags.js';

export interface GameHead {
  gameId: Hex;
  /** Sequence number of the latest delta folded into this snapshot. */
  seq: number;
  game: string;
  version: string;
  /** The module's serialized public state. */
  state: unknown;
}

export function buildHead(head: GameHead): EventTemplate {
  return {
    kind: KIND.GAME_HEAD,
    tags: [
      ['d', head.gameId],
      ['e', head.gameId, '', 'root'],
      ['seq', String(head.seq)],
      ['game', head.game],
      ['version', head.version],
    ],
    // Canonical key order so identical state yields identical bytes, which is
    // what makes snapshot comparison meaningful across GM and auditor.
    content: canonicalJson({ seq: head.seq, state: head.state }),
  };
}

export function parseHead(event: NostrEvent): ParseResult<GameHead> {
  if (event.kind !== KIND.GAME_HEAD) return fail('wrong_kind');

  const gameId = tagValue(event.tags, 'd');
  if (!isHex64(gameId)) return fail('bad_d');

  const seq = intTagValue(event.tags, 'seq');
  if (seq === undefined) return fail('bad_seq');

  const game = tagValue(event.tags, 'game');
  if (!game) return fail('missing_game');

  const version = tagValue(event.tags, 'version');
  if (!version) return fail('missing_version');

  const parsed = parseJsonObject(event.content);
  if (!parsed.ok) return parsed;
  const raw = parsed.value;

  if (Number.isSafeInteger(raw.seq) && raw.seq !== seq) return fail('seq_mismatch');
  if (!('state' in raw)) return fail('missing_state');

  return ok({ gameId, seq, game, version, state: raw.state });
}
