/**
 * The game execution engine — one code path, three callers.
 *
 * The GM drives it forward as rounds close; an auditor replays a finished log
 * through it; a paranoid client runs it alongside the GM to check live. Keeping
 * that single implementation is the structural point of NIP-GM's determinism
 * requirement: if the GM and the auditor ran different code, a disagreement
 * would prove nothing.
 *
 * Nothing here reads a clock or a random source. Time arrives on the round
 * record and randomness through the seeded `Rng`, so a replay years later
 * produces byte-identical output.
 */
import { createRng } from '../crypto/rng.js';
import type { Rng, TurnContext } from '../module/context.js';
import type {
  ApplyResult,
  GameModule,
  GameResult,
  ResolvedMove,
  RoundInput,
  SystemInput,
  ValidationResult,
} from '../module/types.js';
import type { Hex } from '../types.js';
import { orderRound } from './ordering.js';

export interface EngineOptions<Config> {
  /** Event id of the start event. Mixed into every RNG derivation. */
  gameId: Hex;
  config: Config;
  /** Seat order — `p` tag order from the start event. Never sorted. */
  seats: Hex[];
  /** The GM's committed seed (already combined with player contributions, if any). */
  seed: Uint8Array;
}

/** One round's outcome, including the ordering the GM must publish. */
export interface RoundOutcome<State, Move, Patch> extends ApplyResult<State, Patch> {
  seq: number;
  /** The round's moves in canonical resolution order. */
  ordered: ResolvedMove<Move>[];
}

export class GameEngine<Config, State, Move, Patch> {
  readonly module: GameModule<Config, State, Move, Patch>;
  readonly gameId: Hex;
  readonly seats: Hex[];
  readonly rng: Rng;

  private current: State;
  private currentSeq = 0;
  private currentAwaiting: Hex[] = [];
  private ended: GameResult | undefined;

  constructor(
    module: GameModule<Config, State, Move, Patch>,
    options: EngineOptions<Config>,
  ) {
    this.module = module;
    this.gameId = options.gameId;
    this.seats = [...options.seats];
    this.rng = createRng(options.seed, options.gameId);

    this.current = module.init({
      gameId: options.gameId,
      config: options.config,
      seats: this.seats,
      rng: this.rng,
    });

    // Round 1 has no preceding delta to say who acts, so the module declares it.
    // Every later round takes `awaiting` from the round before.
    this.currentAwaiting = module.awaitingAtStart?.(this.seats) ?? [...this.seats];
  }

  get state(): State {
    return this.current;
  }

  /** Sequence number of the last applied round; 0 before any round. */
  get seq(): number {
    return this.currentSeq;
  }

  /** Who the next round is waiting on. */
  get awaiting(): Hex[] {
    return [...this.currentAwaiting];
  }

  get result(): GameResult | undefined {
    return this.ended;
  }

  get isOver(): boolean {
    return this.ended !== undefined;
  }

  private context(seq: number, now: number): TurnContext {
    return { gameId: this.gameId, seats: this.seats, rng: this.rng, seq, now };
  }

  /** Seat index for a pubkey, or -1. Seat order comes from the start event. */
  seatOf(pubkey: Hex): number {
    return this.seats.indexOf(pubkey);
  }

  /** Module-level legality of one move against the current state. */
  validate(move: ResolvedMove<Move>, now: number): ValidationResult {
    return this.module.validate(this.current, move, this.context(this.currentSeq + 1, now));
  }

  /** Sort a round's moves into the module's declared canonical order. */
  order(moves: readonly ResolvedMove<Move>[], seq: number): ResolvedMove<Move>[] {
    return orderRound(this.module.resolutionOrder, moves, {
      seq,
      rng: this.rng,
      seats: this.seats,
    });
  }

  /**
   * Apply one round and advance.
   *
   * Ordering happens here rather than in the caller so that a GM cannot forget
   * it, and so the ordering an auditor recomputes is by construction the one the
   * engine used.
   */
  applyRound(
    moves: readonly ResolvedMove<Move>[],
    system: SystemInput | null,
    now: number,
  ): RoundOutcome<State, Move, Patch> {
    if (this.ended) throw new Error('game has already ended');

    const seq = this.currentSeq + 1;
    const ordered = this.order(moves, seq);
    const input: RoundInput<Move> = { seq, prev: this.gameId, moves: ordered, system, now };
    const result = this.module.apply(this.current, input, this.context(seq, now));

    this.current = result.state;
    this.currentSeq = seq;
    this.currentAwaiting = result.awaiting;
    this.ended = result.end;

    return { ...result, seq, ordered };
  }

  /** Serialize for a head snapshot (kind 32602) or crash recovery. */
  serialize(): unknown {
    return this.module.serialize(this.current);
  }
}

/* ------------------------------------------------------------- replay ---- */

/** A round as it enters replay: moves are unordered, the engine sorts them. */
export interface LoggedRound<Move> {
  moves: ResolvedMove<Move>[];
  system?: SystemInput | null;
  /** Unix seconds, from the delta that closed the round. */
  now: number;
}

export interface GameLog<Config, Move> extends EngineOptions<Config> {
  rounds: LoggedRound<Move>[];
}

export interface ReplayResult<State, Move, Patch> {
  state: State;
  seq: number;
  result?: GameResult;
  rounds: RoundOutcome<State, Move, Patch>[];
}

/**
 * Fold a whole log into a final state.
 *
 * Stops early if the module ends the game, so a log with trailing rounds after
 * an `end` is reported rather than silently applied.
 */
export function replay<Config, State, Move, Patch>(
  module: GameModule<Config, State, Move, Patch>,
  log: GameLog<Config, Move>,
): ReplayResult<State, Move, Patch> {
  const engine = new GameEngine(module, log);
  const rounds: RoundOutcome<State, Move, Patch>[] = [];

  for (const round of log.rounds) {
    if (engine.isOver) break;
    rounds.push(engine.applyRound(round.moves, round.system ?? null, round.now));
  }

  return { state: engine.state, seq: engine.seq, result: engine.result, rounds };
}
