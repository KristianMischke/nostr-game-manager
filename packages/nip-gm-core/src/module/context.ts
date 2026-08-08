/**
 * Execution context handed to a game module.
 *
 * NIP-GM §Game Modules: "a game module MUST be a deterministic function of
 * (config, seed, ordered inputs)". Rather than trusting modules to honour that,
 * everything non-deterministic is injected here — a module that reaches for
 * `Math.random()` or `Date.now()` instead is a bug the determinism harness in
 * `nip-gm-testing` will catch by running it twice and diffing.
 */
import type { Hex } from '../types.js';

/** A deterministic byte stream derived from the committed game seed. */
export interface RngStream {
  bytes(n: number): Uint8Array;
  /** Uniform in `[0, maxExclusive)`, rejection-sampled so it is unbiased. */
  int(maxExclusive: number): number;
  /** Fisher-Yates using this stream. Returns a new array. */
  shuffle<T>(items: readonly T[]): T[];
}

/**
 * Addressed randomness.
 *
 * A stream is identified by `(seq, label)` and derived as
 * `HKDF(seed || game_id || seq || label)`. Two consequences worth understanding:
 *
 * 1. Every value is fully determined the moment the GM commits to the seed, but
 *    unknowable to anyone until the reveal. That is what lets a GM decide now
 *    that a random element appears N turns from now — and even announce it
 *    early in a public delta — while remaining verifiable at game end.
 *
 * 2. Because the address is explicit, a dishonest GM cannot grind: it does not
 *    get to sample repeatedly and keep a favourable draw, since auditors
 *    recompute the stream at exactly the `(seq, label)` the module asked for.
 */
export interface Rng {
  at(seq: number, label: string): RngStream;
}

export interface InitContext<Config> {
  /** Hex event id of the start event. Also mixed into every RNG derivation. */
  gameId: Hex;
  /** Module-defined settings from `LobbyConfig.config`. */
  config: Config;
  /**
   * Seat order — the order of `p` tags in the start event, which is signed by
   * the GM and is therefore itself part of the auditable record.
   */
  seats: Hex[];
  rng: Rng;
}

export interface TurnContext {
  gameId: Hex;
  seats: Hex[];
  rng: Rng;
  /** The sequence number being applied. */
  seq: number;
  /**
   * Unix seconds carried on the input record, never read from the ambient
   * clock — that is what keeps replay deterministic.
   */
  now: number;
}
