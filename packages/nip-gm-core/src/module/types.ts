/**
 * The game module contract — the one interface a game author implements.
 *
 * NIP-GM §Protocol vs. module responsibilities: the protocol fixes event kinds,
 * tag grammar, the `seq`/`prev` envelope, lobby semantics, lifecycle,
 * commit-reveal and verification. The module supplies move vocabulary, config
 * schema, legality, patch semantics, and resolution order.
 */
import type { Hex } from '../types.js';
import type { InitContext, TurnContext } from './context.js';

/**
 * How simultaneous moves within one round are ordered before being applied.
 *
 * NIP-GM §Deltas requires that order-sensitive modules define a canonical order
 * "derivable from the events themselves" so auditors can reproduce it. This is
 * that declaration.
 *
 * Prefer the three declarative variants: each is computable from the event log
 * plus the revealed seed, so a **generic auditor can verify ordering without
 * having the module's code**. `custom` forfeits that property — auditing then
 * requires executing your module — so keep it as an escape hatch.
 *
 * - `seat`     — order of `p` tags in the start event. Stable and obvious, but
 *                note it hands seat 0 a permanent edge in any contested
 *                resolution, every single round.
 * - `event-id` — ascending move event id. No standing bias, though a player who
 *                grinds nonces can bias their own position within a round.
 * - `shuffled` — a fresh permutation per round from `rng.at(seq, 'order')`.
 *                Unbiased and ungrindable by either side, since the GM is
 *                committed to the seed before play. The safest default for
 *                games where simultaneous moves contend for a resource.
 * - `custom`   — `compare` MUST be a pure function of the fields present on the
 *                records (no closure over game state, no clock, no RNG), or
 *                replay diverges from live play.
 */
export type ResolutionOrder<Move = unknown> =
  | { kind: 'seat' }
  | { kind: 'event-id' }
  | { kind: 'shuffled' }
  | { kind: 'custom'; compare(a: ResolvedMove<Move>, b: ResolvedMove<Move>): number };

/** A player move after decryption, as it enters the engine. */
export interface ResolvedMove<Move = unknown> {
  /** Event id of the move message — the commitment, and a tiebreak key. */
  id: Hex;
  player: Hex;
  /** Index of `player` in seat order; -1 if not seated. */
  seat: number;
  move: Move;
}

/**
 * A GM-authored input that is not a player move: a turn timeout, a disconnect
 * forfeit, a hot-join. NIP-GM §Game Modules requires these be materialized as
 * signed inputs so wall-clock decisions become replayable.
 */
export interface SystemInput {
  type: 'timeout' | 'forfeit' | 'join' | 'abort' | (string & {});
  player?: Hex;
  data?: unknown;
}

/** One round of input: the unit the engine applies atomically. */
export interface RoundInput<Move = unknown> {
  seq: number;
  /** Event id of the public state event this round was played against. */
  prev: Hex;
  /** Already sorted by the module's declared {@link ResolutionOrder}. */
  moves: ResolvedMove<Move>[];
  system: SystemInput | null;
  /** Unix seconds; supplied by the input record, never the ambient clock. */
  now: number;
}

export type ValidationResult =
  | { ok: true }
  /** `reason` travels to the player in the GM's response and is auditable. */
  | { ok: false; reason: string };

export interface GameResult {
  winners: Hex[];
  scores?: Record<Hex, number>;
  [k: string]: unknown;
}

export interface ApplyResult<State, Patch> {
  state: State;
  /** Published in the delta so clients can update without re-running the module. */
  patch: Patch;
  /** Who must act next — becomes the `p` tags on the delta. */
  awaiting: Hex[];
  /** Per-player secrets, published as `private` state events encrypted to each. */
  privateState?: Map<Hex, unknown>;
  /** Present iff this round ends the game. */
  end?: GameResult;
}

/**
 * A module of unknown parameterisation — for registries and daemon config,
 * where modules of different shapes are held together. Prefer the parameterised
 * `GameModule` anywhere the concrete types are known.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyGameModule = GameModule<any, any, any, any>;

export interface GameModule<Config = unknown, State = unknown, Move = unknown, Patch = unknown> {
  /** Reverse-domain game module id, e.g. `com.example.holdem`. */
  readonly id: string;
  /** Semver of the ruleset. Two implementations sharing `(id, version)` must be move-for-move compatible. */
  readonly version: string;
  /** Optional SHA-256 of a canonical rules spec (NIP-GM §Game Modules). */
  readonly rulesHash?: string;

  readonly resolutionOrder: ResolutionOrder<Move>;

  /** Player-count bounds the GM enforces before starting. */
  readonly minPlayers: number;
  readonly maxPlayers: number;

  init(ctx: InitContext<Config>): State;

  /**
   * Who the *first* round awaits. Defaults to every seat.
   *
   * Every later round's actors come from the previous round's `awaiting`, but
   * round 1 has no previous round, and the start event's `p` tags are seat
   * order — a roster, not a summons. A simultaneous game wants the default; a
   * turn-taking game returns `[seats[0]]`.
   *
   * Deliberately a function of seat order alone, with no access to state: it is
   * never published in an event, so every client and auditor must be able to
   * derive it from the signed start event without knowing anything secret.
   */
  awaitingAtStart?(seats: readonly Hex[]): Hex[];

  /** Legality of a single move, checked before it enters a round. */
  validate(state: State, move: ResolvedMove<Move>, ctx: TurnContext): ValidationResult;

  /** Apply one ordered round. Must be pure: same inputs, same output, always. */
  apply(state: State, input: RoundInput<Move>, ctx: TurnContext): ApplyResult<State, Patch>;

  /**
   * Fold a published patch into a client's view of the game.
   *
   * **Required for live play.** A client cannot simply replay the module
   * instead: replay needs the seed, and the seed is not revealed until the game
   * ends. Between start and end, patches are the only path from one public
   * state to the next.
   *
   * The value being folded is what {@link GameModule.redact} produces, not the
   * GM's `State`. In a hidden-information game the GM holds things no client may
   * see — Orders schedules storms three rounds before they land — so a client
   * maintaining the full `State` would have to be either wrong or told secrets.
   * It is typed `unknown` for that reason and cast inside the module, exactly as
   * `deserialize` already is.
   *
   * The corollary for a module author: **a patch must carry everything a viewer
   * needs to advance their view.** If applying a patch leaves the view guessing
   * — Orders would, if `Resolution` did not carry post-move `energy` — the
   * patch is under-specified, and no amount of client cleverness fixes it.
   */
  applyPatch?(view: unknown, patch: Patch): unknown;

  /**
   * Parse untrusted move JSON off the wire. Return undefined to reject.
   *
   * `raw` is the `{ type, data }` pair from the move envelope — the protocol
   * owns `seq` and `prev`, the module owns these two. The same shape appears in
   * a round-closing delta's `applied[].move`, so a verifier feeds this exactly
   * what a GM does.
   *
   * Be strict: this is the boundary between bytes someone published and a value
   * your rules may assume things about. Rejecting unknown fields rather than
   * ignoring them is what keeps two implementations of `(id, version)` from
   * quietly diverging.
   */
  parseMove(raw: unknown): Move | undefined;

  /**
   * The inverse of {@link GameModule.parseMove}: a move as it goes on the wire.
   *
   * **Required for a client to play.** Without it every client reinvents the
   * encoding, and the moment one drifts from `parseMove` its moves are rejected
   * by a GM that is behaving correctly. Keeping both halves in the module is
   * what makes `parseMove(encodeMove(m))` a property a port can test.
   */
  encodeMove?(move: Move): { type: string; data: unknown };

  /** Parse/validate module-defined lobby config. Throw to reject. */
  parseConfig(raw: unknown): Config;

  /** Snapshot serialization for the game head (32602) and crash recovery. */
  serialize(state: State): unknown;
  deserialize(raw: unknown): State;

  /**
   * Optional: strip a state down to what a given viewer may see. `viewer` is
   * undefined for spectators. Only a defence-in-depth convenience — real
   * secrecy comes from encryption, not from redaction.
   */
  redact?(state: State, viewer: Hex | undefined): unknown;
}
