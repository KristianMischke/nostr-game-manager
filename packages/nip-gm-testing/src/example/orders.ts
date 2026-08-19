/**
 * A reference game module: **Orders**.
 *
 * Deliberately shaped like the hard case rather than the easy one. Every round
 * is simultaneous, every player queues a hidden move, moves contend for the same
 * tiles, and the GM schedules a random event several rounds ahead. That
 * combination exercises resolution order, addressed randomness, system inputs
 * and elimination at once.
 *
 * It doubles as the worked example for `docs/porting-game-logic.md`. Read it
 * alongside §12 of that guide: nothing here reads a clock, a random source, a
 * global, or anything outside `(config, seed, ordered inputs)`. Note in
 * particular that the config is stored *on the state* — a module-level variable
 * holding it would be exactly the mutable-global trap the guide warns about, and
 * would make two concurrent games interfere.
 *
 * ## Rules
 *
 * Players sit on a ring of `boardSize` tiles. Each round every player secretly
 * queues either `advance` (1–3 tiles clockwise, costing 1 energy per tile) or
 * `hold` (stay, +2 energy). Moves resolve in canonical order; a player moving
 * onto an occupied tile bounces back and pays anyway. Three rounds after each
 * tick the committed seed determines a storm tile — anyone standing there when
 * it lands is eliminated. Last player standing wins, else most energy at
 * `maxRounds`.
 */
import type {
  ApplyResult,
  GameModule,
  Hex,
  InitContext,
  ResolvedMove,
  RoundInput,
  TurnContext,
  ValidationResult,
} from 'nip-gm-core';

const STORM_LEAD = 3;
const MAX_ADVANCE = 3;
const START_ENERGY = 5;

export interface OrdersConfig {
  boardSize: number;
  maxRounds: number;
}

export interface Unit {
  tile: number;
  energy: number;
}

export interface OrdersState {
  /** Carried on the state so the module needs no ambient configuration. */
  config: OrdersConfig;
  round: number;
  /** Keyed by pubkey; iterate via seat order when the result depends on order. */
  units: Record<Hex, Unit>;
  eliminated: Hex[];
  /** Storms already determined, keyed by the round they land on. */
  storms: { at: number; tile: number }[];
}

/**
 * What a client may see: the same shape as {@link OrdersState}, but `storms`
 * holds only storms that have already landed. Identical types, different
 * knowledge — which is the normal situation in a hidden-information game and the
 * reason `applyPatch` folds a view rather than a state.
 */
export type OrdersView = OrdersState;

export type OrdersMove = { type: 'advance'; distance: number } | { type: 'hold' };

export interface Resolution {
  player: Hex;
  action: 'advance' | 'hold' | 'bounced';
  tile: number;
  /**
   * Energy after the move resolved.
   *
   * Carried rather than left to the client to recompute: a `bounced` resolution
   * does not say how far the player tried to go, so a viewer folding patches
   * could not derive what was paid. A patch that leaves the view guessing is an
   * under-specified patch — see {@link GameModule.applyPatch}.
   */
  energy: number;
}

export interface OrdersPatch {
  round: number;
  resolved: Resolution[];
  storm: { tile: number; killed: Hex[] } | null;
  eliminated: Hex[];
}

function isAlive(state: OrdersState, pubkey: Hex): boolean {
  return state.units[pubkey] !== undefined && !state.eliminated.includes(pubkey);
}

/** Whoever currently stands on `tile`, scanned in seat order for determinism. */
function occupant(state: OrdersState, seats: readonly Hex[], tile: number): Hex | undefined {
  return seats.find((pk) => isAlive(state, pk) && state.units[pk].tile === tile);
}

function cloneState(state: OrdersState): OrdersState {
  return {
    config: state.config,
    round: state.round,
    units: Object.fromEntries(Object.entries(state.units).map(([k, v]) => [k, { ...v }])),
    eliminated: [...state.eliminated],
    storms: state.storms.map((s) => ({ ...s })),
  };
}

export const ordersModule = {
  id: 'net.example.orders',
  version: '1.0.0',

  // Seat order would hand seat 0 every contested tile, every round. A
  // seed-derived permutation is unbiased and still fully verifiable.
  resolutionOrder: { kind: 'shuffled' },

  minPlayers: 2,
  maxPlayers: 6,

  init(ctx: InitContext<OrdersConfig>): OrdersState {
    const spawns = ctx.rng
      .at(0, 'spawns')
      .shuffle(Array.from({ length: ctx.config.boardSize }, (_, i) => i));

    const units: Record<Hex, Unit> = {};
    ctx.seats.forEach((pubkey, i) => {
      units[pubkey] = { tile: spawns[i], energy: START_ENERGY };
    });

    return { config: ctx.config, round: 0, units, eliminated: [], storms: [] };
  },

  validate(state, move: ResolvedMove<OrdersMove>, _ctx: TurnContext): ValidationResult {
    if (!state.units[move.player]) return { ok: false, reason: 'not_in_game' };
    if (state.eliminated.includes(move.player)) return { ok: false, reason: 'eliminated' };

    if (move.move.type === 'advance') {
      const { distance } = move.move;
      if (distance < 1 || distance > MAX_ADVANCE) return { ok: false, reason: 'bad_distance' };
      if (state.units[move.player].energy < distance) {
        return { ok: false, reason: 'not_enough_energy' };
      }
    }

    // Note what is *not* checked: whether the destination is free. Two players
    // may legally target one tile; that contention resolves in apply().
    return { ok: true };
  },

  apply(
    state,
    input: RoundInput<OrdersMove>,
    ctx: TurnContext,
  ): ApplyResult<OrdersState, OrdersPatch> {
    const next = cloneState(state);
    const { boardSize, maxRounds } = next.config;
    const resolved: Resolution[] = [];

    // Moves arrive already in canonical order; fold, never re-sort.
    for (const { player, move } of input.moves) {
      if (!isAlive(next, player)) continue;
      const unit = next.units[player];

      if (move.type === 'hold') {
        unit.energy += 2;
        resolved.push({ player, action: 'hold', tile: unit.tile, energy: unit.energy });
        continue;
      }

      const dest = (unit.tile + move.distance) % boardSize;
      const blocker = occupant(next, ctx.seats, dest);

      if (blocker !== undefined && blocker !== player) {
        // Someone earlier in resolution order already holds the tile. Bounce,
        // and pay anyway — a move that became impossible is a rule, not an error.
        unit.energy = Math.max(0, unit.energy - move.distance);
        resolved.push({ player, action: 'bounced', tile: unit.tile, energy: unit.energy });
      } else {
        unit.energy -= move.distance;
        unit.tile = dest;
        resolved.push({ player, action: 'advance', tile: dest, energy: unit.energy });
      }
    }

    // A GM system input (timeout, forfeit) is an ordinary input here.
    if (input.system?.type === 'forfeit' && input.system.player) {
      if (!next.eliminated.includes(input.system.player)) {
        next.eliminated.push(input.system.player);
      }
    }

    // Schedule a storm STORM_LEAD rounds out, addressed by the round it lands
    // on rather than the round computing it — so a GM that dislikes the draw
    // cannot re-derive it under a different address later.
    const landing = ctx.seq + STORM_LEAD;
    if (!next.storms.some((s) => s.at === landing)) {
      next.storms.push({ at: landing, tile: ctx.rng.at(landing, 'storm').int(boardSize) });
    }

    let storm: OrdersPatch['storm'] = null;
    const due = next.storms.find((s) => s.at === ctx.seq);
    if (due) {
      const killed = ctx.seats.filter((pk) => isAlive(next, pk) && next.units[pk].tile === due.tile);
      next.eliminated.push(...killed);
      storm = { tile: due.tile, killed };
    }

    next.round = ctx.seq;

    const alive = ctx.seats.filter((pk) => isAlive(next, pk));
    const over = alive.length <= 1 || ctx.seq >= maxRounds;

    return {
      state: next,
      patch: { round: next.round, resolved, storm, eliminated: next.eliminated },
      awaiting: over ? [] : alive,
      ...(over
        ? {
            end: {
              winners: winners(next, alive),
              scores: Object.fromEntries(alive.map((pk) => [pk, next.units[pk].energy])),
            },
          }
        : {}),
    };
  },

  /**
   * The public projection: everything except storms that have not landed yet.
   *
   * Scheduling a storm three rounds ahead is the module's whole
   * hidden-information mechanic, so this is not decoration — publishing the full
   * state in a head snapshot would hand every player the storm tile in advance
   * and quietly delete the game.
   */
  redact(state: OrdersState, _viewer: Hex | undefined): OrdersView {
    return { ...state, storms: state.storms.filter((s) => s.at <= state.round) };
  },

  applyPatch(view: unknown, patch: OrdersPatch): OrdersView {
    const current = view as OrdersView;
    const units = { ...current.units };
    for (const r of patch.resolved) units[r.player] = { tile: r.tile, energy: r.energy };

    return {
      config: current.config,
      round: patch.round,
      units,
      // The full list every time, so a viewer that missed a delta and
      // resynced from the head is not left with a stale set.
      eliminated: [...patch.eliminated],
      storms: patch.storm
        ? [...current.storms, { at: patch.round, tile: patch.storm.tile }]
        : current.storms,
    };
  },

  parseMove(raw: unknown): OrdersMove | undefined {
    if (typeof raw !== 'object' || raw === null) return undefined;
    const { type, data } = raw as { type?: unknown; data?: unknown };

    if (type === 'hold') return { type: 'hold' };

    if (type === 'advance') {
      const distance = (data as { distance?: unknown } | null | undefined)?.distance;
      if (!Number.isInteger(distance)) return undefined;
      const n = distance as number;
      if (n < 1 || n > MAX_ADVANCE) return undefined;
      return { type: 'advance', distance: n };
    }

    return undefined;
  },

  encodeMove(move: OrdersMove): { type: string; data: unknown } {
    return ordersMove(move);
  },

  parseConfig(raw: unknown): OrdersConfig {
    const { boardSize, maxRounds } = (raw ?? {}) as Record<string, unknown>;
    if (!Number.isInteger(boardSize) || (boardSize as number) < 4) {
      throw new Error('boardSize must be an integer >= 4');
    }
    if (!Number.isInteger(maxRounds) || (maxRounds as number) < 1) {
      throw new Error('maxRounds must be a positive integer');
    }
    return { boardSize: boardSize as number, maxRounds: maxRounds as number };
  },

  serialize(state) {
    return state;
  },

  deserialize(raw) {
    return raw as OrdersState;
  },
} satisfies GameModule<OrdersConfig, OrdersState, OrdersMove, OrdersPatch>;

function winners(state: OrdersState, alive: readonly Hex[]): Hex[] {
  if (alive.length <= 1) return [...alive];
  const best = Math.max(...alive.map((pk) => state.units[pk].energy));
  return alive.filter((pk) => state.units[pk].energy === best);
}

/** Convenience for tests and the harness. */
export function ordersMove(move: OrdersMove): { type: string; data: unknown } {
  return move.type === 'hold'
    ? { type: 'hold', data: {} }
    : { type: 'advance', data: { distance: move.distance } };
}
