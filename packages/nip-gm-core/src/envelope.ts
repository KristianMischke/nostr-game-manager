/**
 * The move envelope and its ordering semantics.
 *
 * NIP-GM §Game Messages: "`seq` claims which turn or round the move answers;
 * `prev` pins the state it was made against — together they make stale/duplicate
 * rejection deterministic and auditable."
 *
 * Deterministic rejection is the point. An auditor re-runs these checks to
 * confirm that every move the GM refused was genuinely refusable and that no
 * legal move was quietly dropped, so the logic lives in core and is shared by
 * the GM and the verifier rather than reimplemented in each.
 */
import { parseJsonObject } from './codec/json.js';
import { isHex64 } from './codec/tags.js';
import { fail, ok, type Hex, type ParseResult } from './types.js';

/** The protocol-owned part of a move's content; `type` and `data` are module-owned. */
export interface MoveEnvelope<Data = unknown> {
  /** Which round this move answers. */
  seq: number;
  /** Event id of the public state event this move was made against. */
  prev: Hex;
  type: string;
  data: Data;
}

export function formatMoveEnvelope(envelope: MoveEnvelope): string {
  return JSON.stringify(envelope);
}

export function parseMoveEnvelope(content: string): ParseResult<MoveEnvelope> {
  // Shared with the other codecs so that arrays and null are rejected as
  // `not_an_object` rather than falling through to a misleading field error.
  const parsed = parseJsonObject(content);
  if (!parsed.ok) return parsed;

  const { seq, prev, type, data } = parsed.value;
  if (!Number.isSafeInteger(seq) || (seq as number) < 0) return fail('bad_seq');
  if (!isHex64(prev)) return fail('bad_prev');
  if (typeof type !== 'string' || type.length === 0) return fail('bad_type');

  return ok({ seq: seq as number, prev, type, data });
}

/** Where a game currently stands, from the perspective of accepting moves. */
export interface RoundHead {
  /** The round currently open for submissions. */
  seq: number;
  /** Event id of the latest public state event — the `start` event or a `delta`. */
  prev: Hex;
}

export type EnvelopeRejection =
  /** Answering a round that has already closed. */
  | 'stale_seq'
  /** Answering a round that has not opened yet. */
  | 'future_seq'
  /**
   * Right round, but pinned to a state event that is not the current head —
   * the player was working from a view that has since been superseded.
   */
  | 'stale_prev'
  /** This player already has an accepted move in this round. */
  | 'duplicate'
  /** This player was not asked to act in this round. */
  | 'not_awaited';

export type EnvelopeCheck = { ok: true } | { ok: false; reason: EnvelopeRejection };

export interface RoundMembership {
  /** Pubkeys the round is waiting on — the `p` tags of the delta that opened it. */
  awaiting: readonly Hex[];
  /** Pubkeys already holding an accepted move in this round. */
  submitted: readonly Hex[];
}

/**
 * Decide whether a move may enter the current round.
 *
 * Protocol-level only: it says nothing about whether the move is *legal*, which
 * is the game module's `validate`. Both must pass.
 *
 * Note `prev` is compared against the latest **public** state event. NIP-GM
 * §Game Messages requires that a move never pin a `private` event, precisely so
 * that this check is reproducible by verifiers who cannot decrypt private state.
 */
export function checkEnvelope(
  envelope: MoveEnvelope,
  head: RoundHead,
  player: Hex,
  membership: RoundMembership,
): EnvelopeCheck {
  if (envelope.seq < head.seq) return { ok: false, reason: 'stale_seq' };
  if (envelope.seq > head.seq) return { ok: false, reason: 'future_seq' };
  if (envelope.prev !== head.prev) return { ok: false, reason: 'stale_prev' };
  if (!membership.awaiting.includes(player)) return { ok: false, reason: 'not_awaited' };
  if (membership.submitted.includes(player)) return { ok: false, reason: 'duplicate' };
  return { ok: true };
}
