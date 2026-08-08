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
  /**
   * Revision counter within `(player, seq)`, starting at 0 (NIP-GM §Move
   * revisions). Highest wins. Each revision carries the player's *complete*
   * move, never a delta against an earlier one — relays drop and reorder
   * events, and a complete snapshot means a lost revision is repaired by the
   * next rather than leaving an unresolvable gap.
   */
  rev: number;
  /**
   * Set when the player will publish no further revision this round, letting
   * the GM close early instead of waiting out `turn_timeout`. Purely an
   * optimization: a round where nobody sets it still closes on timeout with
   * whatever revision each player reached.
   */
  final: boolean;
  type: string;
  data: Data;
}

export function formatMoveEnvelope(envelope: MoveEnvelope): string {
  // `final` is omitted when false: it is the overwhelmingly common case in a
  // revision stream, and every byte here is encrypted and republished on a
  // cadence.
  const out: Record<string, unknown> = {
    seq: envelope.seq,
    prev: envelope.prev,
    rev: envelope.rev,
    type: envelope.type,
    data: envelope.data,
  };
  if (envelope.final) out.final = true;
  return JSON.stringify(out);
}

export function parseMoveEnvelope(content: string): ParseResult<MoveEnvelope> {
  // Shared with the other codecs so that arrays and null are rejected as
  // `not_an_object` rather than falling through to a misleading field error.
  const parsed = parseJsonObject(content);
  if (!parsed.ok) return parsed;

  const { seq, prev, rev, final, type, data } = parsed.value;
  if (!Number.isSafeInteger(seq) || (seq as number) < 0) return fail('bad_seq');
  if (!isHex64(prev)) return fail('bad_prev');
  if (typeof type !== 'string' || type.length === 0) return fail('bad_type');

  // Absent `rev` is revision 0 — a single-shot move, which is what a
  // turn-taking game publishes and what every client sent before revisions
  // existed. Present-but-malformed is rejected rather than coerced: silently
  // reading a bad `rev` as 0 would make a corrupted revision outrank a good one.
  if (rev !== undefined && (!Number.isSafeInteger(rev) || (rev as number) < 0)) {
    return fail('bad_rev');
  }
  if (final !== undefined && typeof final !== 'boolean') return fail('bad_final');

  return ok({
    seq: seq as number,
    prev,
    rev: rev === undefined ? 0 : (rev as number),
    final: final === true,
    type,
    data,
  });
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
  /**
   * This player already has an accepted move at this exact `rev`. Two signed
   * events at one `rev` is equivocation; {@link selectRevisions} decides which
   * one stands, deterministically, so the GM and an auditor agree.
   */
  | 'duplicate'
  /** A later revision from this player is already in hand (NIP-GM §Move revisions). */
  | 'superseded'
  /** This player was not asked to act in this round. */
  | 'not_awaited';

export type EnvelopeCheck = { ok: true } | { ok: false; reason: EnvelopeRejection };

export interface RoundMembership {
  /** Pubkeys the round is waiting on — the `p` tags of the delta that opened it. */
  awaiting: readonly Hex[];
  /**
   * Highest `rev` currently held for each player who has submitted. A player
   * absent from the map has not submitted at all; a player present at rev 2 has
   * a move in hand that only rev 3 or higher can displace.
   */
  submitted: ReadonlyMap<Hex, number>;
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

  const held = membership.submitted.get(player);
  if (held !== undefined) {
    if (envelope.rev < held) return { ok: false, reason: 'superseded' };
    if (envelope.rev === held) return { ok: false, reason: 'duplicate' };
  }
  return { ok: true };
}

/* ---------------------------------------------------------- revisions ---- */

/**
 * One candidate revision, as seen on the wire.
 *
 * `id` is the move event's id, which is what breaks equivocation ties and what
 * the round-closing delta cites.
 */
export interface RevisionCandidate<Data = unknown> {
  id: Hex;
  player: Hex;
  envelope: MoveEnvelope<Data>;
}

/**
 * Reduce every revision a round received to the one move per player that stands.
 *
 * NIP-GM §Move revisions: highest `rev` wins, ties broken by lowest event id.
 * Both halves matter — the first is the feature, the second is what makes a
 * misbehaving client's equivocation resolve the same way for the GM and for an
 * auditor who fetches the same events in a different order.
 *
 * Pure and total, so the GM closing a round and a verifier re-deriving that
 * close run identical code rather than two implementations that agree until
 * they don't.
 */
export function selectRevisions<Data>(
  candidates: readonly RevisionCandidate<Data>[],
): Map<Hex, RevisionCandidate<Data>> {
  const winners = new Map<Hex, RevisionCandidate<Data>>();

  for (const candidate of candidates) {
    const held = winners.get(candidate.player);
    if (held === undefined || beats(candidate, held)) winners.set(candidate.player, candidate);
  }
  return winners;
}

function beats(candidate: RevisionCandidate, held: RevisionCandidate): boolean {
  if (candidate.envelope.rev !== held.envelope.rev) {
    return candidate.envelope.rev > held.envelope.rev;
  }
  return candidate.id < held.id;
}

/**
 * The revisions {@link selectRevisions} discarded, which a round-closing delta
 * must reveal keys for so that its choice of winner is checkable.
 */
export function supersededRevisions<Data>(
  candidates: readonly RevisionCandidate<Data>[],
  winners: ReadonlyMap<Hex, RevisionCandidate<Data>>,
): RevisionCandidate<Data>[] {
  return candidates.filter((c) => winners.get(c.player)?.id !== c.id);
}

/**
 * Whether every awaited player has published a revision marked `final`.
 *
 * The GM's early-close condition. Players with no revision at all are not
 * final, so a silent player always holds the round open until `turn_timeout` —
 * which is the behaviour that makes `final` an optimization rather than a
 * requirement.
 */
export function allFinal<Data>(
  winners: ReadonlyMap<Hex, RevisionCandidate<Data>>,
  awaiting: readonly Hex[],
): boolean {
  return awaiting.every((player) => winners.get(player)?.envelope.final === true);
}
