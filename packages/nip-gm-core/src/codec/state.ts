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
  /**
   * Revisions this round discarded, with their keys (NIP-GM §Move revisions).
   *
   * Present only when a player revised. Revealing these is what makes the GM's
   * choice of winner checkable: without them an auditor can see that sibling
   * move events exist but cannot decrypt them to learn which held the highest
   * `rev`, leaving room to apply a stale revision.
   */
  superseded?: AppliedMove[];
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

/* ------------------------------------------------------------- status ---- */

/** What the GM currently holds for one player in the open round. */
export interface ReceivedRevision {
  rev: number;
  final: boolean;
}

/**
 * A GM progress report for the open round (NIP-GM §Round status).
 *
 * Not a replay input, and verifiers must ignore it — it is GM-asserted, carries
 * no state, and is unordered with respect to everything else. It exists so a
 * player composing a move across a round learns their revisions are landing
 * before the round closes, rather than after.
 */
export interface RoundStatus {
  type: 'status';
  gameId: Hex;
  seq: number;
  /** Player pubkey → the highest revision the GM has accepted from them. */
  received: Record<Hex, ReceivedRevision>;
  /**
   * Seconds left before the GM closes this round on its turn timeout. Absent
   * when the round is untimed.
   *
   * Relative, not an absolute deadline, and deliberately so: a client's clock is
   * routinely minutes off the GM's, and a wall-clock deadline would be wrong by
   * exactly that much. A duration is only wrong by the event's flight time, so a
   * client anchors it against its own clock on receipt and counts down locally.
   */
  remaining?: number;
}

export type GameState = GameStart | GameDelta | GamePrivate | GameEnd | RoundStatus;

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

  const content: Record<string, unknown> = {
    seq: delta.content.seq,
    applied: delta.content.applied,
    patch: delta.content.patch,
    system: delta.content.system,
  };
  // Omitted rather than empty when nobody revised, so ordinary turn-taking
  // games produce byte-identical deltas to before revisions existed.
  if (delta.content.superseded?.length) content.superseded = delta.content.superseded;

  return {
    kind: stateKindFor(options.mode ?? 'verified', 'delta'),
    tags,
    content: JSON.stringify(content),
  };
}

export function buildStatus(status: Omit<RoundStatus, 'type'>, relay?: string): EventTemplate {
  const content: Record<string, unknown> = { seq: status.seq, received: status.received };
  // Omitted rather than sent as null for an untimed round: absent means "no
  // deadline", which is what a client with nothing to count down needs to see.
  if (status.remaining !== undefined) content.remaining = Math.max(0, Math.round(status.remaining));

  return {
    // Always ephemeral — see stateKindFor. Deliberately no `p` tags: they mean
    // "you must act" on a delta, and repeating them at status cadence would
    // drown the turn notification a player actually subscribes for.
    kind: stateKindFor('verified', 'status'),
    tags: [['state', 'status'], rootTag(status.gameId, relay), ['seq', String(status.seq)]],
    content: JSON.stringify(content),
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

function parseReceived(raw: unknown): Record<Hex, ReceivedRevision> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {};

  const out: Record<Hex, ReceivedRevision> = {};
  for (const [pubkey, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!isHex64(pubkey)) continue;
    if (typeof value !== 'object' || value === null) continue;

    const { rev, final } = value as Record<string, unknown>;
    // Dropped rather than defaulted: an unreadable rev in a progress report is
    // worse than a missing one, since a client would show "received" for a
    // revision the GM may not hold.
    if (!Number.isSafeInteger(rev) || (rev as number) < 0) continue;
    out[pubkey] = { rev: rev as number, final: final === true };
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

      const superseded = parseApplied(raw.superseded);
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
          superseded: superseded.length ? superseded : undefined,
        },
      });
    }

    case 'status': {
      const gameId = rootEventId(event.tags);
      if (!gameId) return fail('missing_root');

      const seq = intTagValue(event.tags, 'seq');
      if (seq === undefined) return fail('bad_seq');
      if (Number.isSafeInteger(raw.seq) && raw.seq !== seq) return fail('seq_mismatch');

      // Dropped rather than clamped when it is not a plain non-negative number:
      // a garbled duration would drive a countdown that is confidently wrong,
      // where an absent one leaves the client showing "untimed" and honest.
      const remaining =
        typeof raw.remaining === 'number' && Number.isFinite(raw.remaining) && raw.remaining >= 0
          ? raw.remaining
          : undefined;

      return ok({ type: 'status', gameId, seq, received: parseReceived(raw.received), remaining });
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
