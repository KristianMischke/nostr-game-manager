/**
 * Canonical ordering of simultaneous moves within a round.
 *
 * NIP-GM §Deltas: "Modules whose resolution is order-sensitive MUST define a
 * canonical order derivable from the events themselves so auditors can
 * reproduce it; the GM's published order MUST match."
 *
 * Every ordering here is *total* and independent of the order moves arrived in.
 * That matters more than it looks: the GM sees moves in relay-delivery order
 * while an auditor sees them in whatever order a query returned, and the two
 * must still agree. Ties therefore always fall through to ascending event id,
 * which is unique per move.
 */
import type { Rng } from '../module/context.js';
import type { ResolutionOrder, ResolvedMove } from '../module/types.js';
import type { Hex } from '../types.js';

export interface OrderingContext {
  seq: number;
  rng: Rng;
  seats: Hex[];
}

/** Ascending hex event id. Total, since ids are unique. */
function byId<M>(a: ResolvedMove<M>, b: ResolvedMove<M>): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Sort a round's moves into the module's declared canonical order.
 *
 * The input array is not mutated.
 */
export function orderRound<Move>(
  order: ResolutionOrder<Move>,
  moves: readonly ResolvedMove<Move>[],
  ctx: OrderingContext,
): ResolvedMove<Move>[] {
  // Canonical base order first. `shuffled` in particular must permute a
  // deterministic starting sequence, or the same seed would yield different
  // results for the GM and an auditor purely from arrival order.
  const base = [...moves].sort(byId);

  switch (order.kind) {
    case 'event-id':
      return base;

    case 'seat':
      return base.sort((a, b) => {
        // Unseated players (seat -1) resolve last rather than first.
        const sa = a.seat < 0 ? Number.MAX_SAFE_INTEGER : a.seat;
        const sb = b.seat < 0 ? Number.MAX_SAFE_INTEGER : b.seat;
        return sa - sb || byId(a, b);
      });

    case 'shuffled':
      return ctx.rng.at(ctx.seq, 'order').shuffle(base);

    case 'custom':
      return base.sort((a, b) => order.compare(a, b) || byId(a, b));
  }
}

/**
 * Check that a GM's published ordering matches what the module declares.
 *
 * Used by the verifier against each round-closing delta's `applied` array, and
 * usable by a client running in live-verify mode.
 */
export function isCanonicalOrder<Move>(
  order: ResolutionOrder<Move>,
  published: readonly ResolvedMove<Move>[],
  ctx: OrderingContext,
): boolean {
  const expected = orderRound(order, published, ctx);
  return expected.length === published.length && expected.every((m, i) => m.id === published[i].id);
}
