/**
 * The shape a UI consumes. Sessions publish this through a store.
 */
import type { GameResult, Hex } from 'nip-gm-core';

export interface PendingMove<Move = unknown> {
  /** Event id of the submitted move message — its commitment. */
  id: Hex;
  seq: number;
  move: Move;
  submittedAt: number;
}

export interface ProtocolError {
  code: string;
  message: string;
  /** Present when the GM rejected a specific move. */
  moveId?: Hex;
}

export type GameStatus = 'loading' | 'lobby' | 'active' | 'ended' | 'aborted';

export interface GameSnapshot<State = unknown, Move = unknown> {
  status: GameStatus;
  gameId: Hex;
  /** Sequence number of the latest applied delta. */
  seq: number;
  /** Event id of the latest public state event — what the next move pins via `prev`. */
  prev: Hex;

  /** Public state, as patched from deltas (or replayed, in live-verify mode). */
  state: State;
  /** My decrypted private state, if the module sends any. */
  privateState: unknown | null;

  /** Seat order — `p` tag order from the start event. */
  seats: Hex[];
  /** Raw `p` tags on the latest delta: everyone the round is still waiting on. */
  awaiting: Hex[];

  /**
   * Whether *I* still owe a move.
   *
   * Not simply `awaiting.includes(me)`. In a simultaneous round the GM keeps
   * every participant in the round's `p` tags until the round closes, so the
   * naive check stays true after I have already submitted and would leave the
   * UI nagging. This folds in both my own pubkey and the optimistic pending
   * move, neither of which a component has cheaply to hand.
   */
  needsMyMove: boolean;

  /** My in-flight move, cleared when the round-closing delta lands. */
  pending: PendingMove<Move> | null;
  error: ProtocolError | null;
  /** Set once the game has ended. */
  result: GameResult | null;
}

export function needsMyMove(
  awaiting: readonly Hex[],
  me: Hex | undefined,
  pending: PendingMove | null,
): boolean {
  if (!me) return false;
  if (pending) return false;
  return awaiting.includes(me);
}
