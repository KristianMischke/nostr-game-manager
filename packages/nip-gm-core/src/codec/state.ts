/**
 * Game state — kinds 2601 (regular) / 21601 (ephemeral mirror).
 *
 * NIP-GM §Game State. All GM-authored lifecycle and state events share one
 * kind, distinguished by a `state` tag: start, delta, private, end, abort.
 */
import { KIND, stateKindFor, type PersistenceMode, type StateType } from '../kinds.js';
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
import { optionalString, parseJsonObject } from './json.js';
import {
  addressTag,
  formatAddress,
  intTagValue,
  isHex64,
  pubkeys,
  rootEventId,
  rootTag,
  tagValue,
} from './tags.js';

/* -------------------------------------------------------------- start ---- */

export interface StartContent {
  rulesHash?: string;
  config: unknown;
  /** `sha256(seed || salt)`, committed before any play (NIP-GM §Hidden Information). */
  seedCommit?: string;
  /** Optional per-player seed commitments, module-defined. */
  playerSeedCommits?: Record<Hex, string>;
}

export interface GameStart {
  type: 'start';
  lobby: AddressPointer;
  /**
   * Seat order. NIP-GM §Start: "the order of `p` tags defines seat order". It
   * lives only in the tags, which are signed, so it is never duplicated into
   * content and must never be sorted.
   */
  seats: Hex[];
  game: string;
  version: string;
  content: StartContent;
}

/* -------------------------------------------------------------- delta ---- */

/**
 * A move cited by a round-closing delta.
 *
 * The object form carries the decrypted plaintext plus the NIP-44 conversation
 * key, so anyone can decrypt the original ciphertext and confirm it matches —
 * which is what makes a simultaneous round verifiable the moment it closes.
 * Plain-move games cite bare event ids instead.
 */
export interface AppliedMove {
  id: Hex;
  move?: unknown;
  /** Hex NIP-44 conversation key, revealed by the GM. */
  key?: string;
}

export interface DeltaContent {
  seq: number;
  /** In resolution order. */
  applied: AppliedMove[];
  patch: unknown;
  /** Non-null when this delta is a GM system input rather than player moves. */
  system: unknown | null;
}

export interface GameDelta {
  type: 'delta';
  gameId: Hex;
  seq: number;
  /** Players expected to act next — the `p` tags. */
  awaiting: Hex[];
  content: DeltaContent;
}

/* ------------------------------------------------------------ private ---- */

export interface GamePrivate {
  type: 'private';
  gameId: Hex;
  seq: number;
  recipient: Hex;
  /** NIP-44 ciphertext; decryption is the client's job, not the codec's. */
  content: string;
}

/* --------------------------------------------------------- end / abort ---- */

export interface EndContent {
  result?: { winners?: Hex[]; scores?: Record<string, number> };
  /** Revealed so auditors can recompute every derivation. */
  seed?: string;
  salt?: string;
  /** move id → hex NIP-44 conversation key, for end-of-game reveal cadence. */
  keyReveals?: Record<Hex, string>;
  reason?: string;
}

export interface GameEnd {
  type: 'end' | 'abort';
  gameId: Hex;
  players: Hex[];
  content: EndContent;
}

export type GameState = GameStart | GameDelta | GamePrivate | GameEnd;

/* -------------------------------------------------------------- build ---- */

export function buildStart(
  start: Omit<GameStart, 'type'>,
  mode: PersistenceMode = 'verified',
): EventTemplate {
  const tags: Tag[] = [
    ['state', 'start'],
    ['a', formatAddress(start.lobby)],
  ];
  // Seat order, verbatim.
  for (const seat of start.seats) tags.push(['p', seat]);
  tags.push(['game', start.game], ['version', start.version]);

  const content: Record<string, unknown> = { config: start.content.config ?? {} };
  if (start.content.rulesHash) content.rules_hash = start.content.rulesHash;
  if (start.content.seedCommit) content.seed_commit = start.content.seedCommit;
  if (start.content.playerSeedCommits) {
    content.player_seed_commits = start.content.playerSeedCommits;
  }

  return { kind: stateKindFor(mode, 'start'), tags, content: JSON.stringify(content) };
}

export function buildDelta(
  delta: Omit<GameDelta, 'type'>,
  options: { mode?: PersistenceMode; relay?: string } = {},
): EventTemplate {
  const tags: Tag[] = [
    ['state', 'delta'],
    rootTag(delta.gameId, options.relay),
    ['seq', String(delta.seq)],
  ];
  for (const p of delta.awaiting) tags.push(['p', p]);

  return {
    kind: stateKindFor(options.mode ?? 'verified', 'delta'),
    tags,
    content: JSON.stringify({
      seq: delta.content.seq,
      applied: delta.content.applied,
      patch: delta.content.patch,
      system: delta.content.system,
    }),
  };
}

export function buildPrivate(
  priv: Omit<GamePrivate, 'type'>,
  options: { mode?: PersistenceMode; relay?: string } = {},
): EventTemplate {
  return {
    kind: stateKindFor(options.mode ?? 'verified', 'private'),
    tags: [
      ['state', 'private'],
      rootTag(priv.gameId, options.relay),
      ['seq', String(priv.seq)],
      ['p', priv.recipient],
    ],
    content: priv.content,
  };
}

export function buildEnd(
  end: Omit<GameEnd, 'type'> & { type?: 'end' | 'abort' },
  options: { relay?: string } = {},
): EventTemplate {
  const type = end.type ?? 'end';
  const tags: Tag[] = [
    ['state', type],
    rootTag(end.gameId, options.relay),
  ];
  for (const p of end.players) tags.push(['p', p]);

  const content: Record<string, unknown> = {};
  if (end.content.result) content.result = end.content.result;
  if (end.content.seed) content.seed = end.content.seed;
  if (end.content.salt) content.salt = end.content.salt;
  if (end.content.keyReveals) content.key_reveals = end.content.keyReveals;
  if (end.content.reason) content.reason = end.content.reason;

  // Lifecycle events stay on the regular kind even in casual mode, so that
  // every game leaves a permanent record (NIP-GM §End and abort).
  return { kind: KIND.STATE, tags, content: JSON.stringify(content) };
}

/* -------------------------------------------------------------- parse ---- */

function parseApplied(raw: unknown): AppliedMove[] {
  if (!Array.isArray(raw)) return [];
  const out: AppliedMove[] = [];
  for (const entry of raw) {
    // Plain-move games cite bare ids; simultaneous rounds cite objects.
    if (isHex64(entry)) {
      out.push({ id: entry });
      continue;
    }
    if (typeof entry === 'object' && entry !== null) {
      const { id, move, key } = entry as Record<string, unknown>;
      if (isHex64(id)) out.push({ id, move, key: optionalString(key) });
    }
  }
  return out;
}

export function parseState(event: NostrEvent): ParseResult<GameState> {
  if (event.kind !== KIND.STATE && event.kind !== KIND.STATE_EPHEMERAL) {
    return fail('wrong_kind');
  }

  const type = tagValue(event.tags, 'state') as StateType | undefined;
  if (!type) return fail('missing_state');

  // Private content is ciphertext, so it must be handled before any JSON parse.
  if (type === 'private') {
    const gameId = rootEventId(event.tags);
    if (!gameId) return fail('missing_root');

    const seq = intTagValue(event.tags, 'seq');
    if (seq === undefined) return fail('bad_seq');

    const recipient = tagValue(event.tags, 'p');
    if (!isHex64(recipient)) return fail('bad_recipient');

    return ok({ type: 'private', gameId, seq, recipient, content: event.content });
  }

  const parsed = parseJsonObject(event.content);
  if (!parsed.ok) return parsed;
  const raw = parsed.value;

  switch (type) {
    case 'start': {
      const lobby = addressTag(event.tags);
      if (!lobby) return fail('bad_lobby_address');
      if (lobby.kind !== KIND.LOBBY) return fail('wrong_lobby_kind');

      const game = tagValue(event.tags, 'game');
      if (!game) return fail('missing_game');

      const version = tagValue(event.tags, 'version');
      if (!version) return fail('missing_version');

      const seats = pubkeys(event.tags);
      if (seats.length === 0) return fail('no_seats');

      const commits = raw.player_seed_commits;
      return ok({
        type: 'start',
        lobby,
        seats,
        game,
        version,
        content: {
          rulesHash: optionalString(raw.rules_hash),
          config: raw.config ?? {},
          seedCommit: optionalString(raw.seed_commit),
          playerSeedCommits:
            typeof commits === 'object' && commits !== null
              ? (commits as Record<Hex, string>)
              : undefined,
        },
      });
    }

    case 'delta': {
      const gameId = rootEventId(event.tags);
      if (!gameId) return fail('missing_root');

      const seq = intTagValue(event.tags, 'seq');
      if (seq === undefined) return fail('bad_seq');

      // The tag and the content both carry seq; disagreement means a malformed
      // or tampered event, and silently trusting either one would let a GM show
      // different orderings to filtering relays and to replaying auditors.
      if (Number.isSafeInteger(raw.seq) && raw.seq !== seq) return fail('seq_mismatch');

      return ok({
        type: 'delta',
        gameId,
        seq,
        awaiting: pubkeys(event.tags),
        content: {
          seq,
          applied: parseApplied(raw.applied),
          patch: raw.patch ?? null,
          system: raw.system ?? null,
        },
      });
    }

    case 'end':
    case 'abort': {
      const gameId = rootEventId(event.tags);
      if (!gameId) return fail('missing_root');

      const result = raw.result;
      const reveals = raw.key_reveals;
      return ok({
        type,
        gameId,
        players: pubkeys(event.tags),
        content: {
          result:
            typeof result === 'object' && result !== null
              ? (result as EndContent['result'])
              : undefined,
          seed: optionalString(raw.seed),
          salt: optionalString(raw.salt),
          keyReveals:
            typeof reveals === 'object' && reveals !== null
              ? (reveals as Record<Hex, string>)
              : undefined,
          reason: optionalString(raw.reason),
        },
      });
    }

    default:
      return fail('unknown_state_type');
  }
}
