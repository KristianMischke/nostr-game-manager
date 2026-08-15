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
  /** Which revision this event carried (NIP-GM §Move revisions). */
  rev: number;
  /** Whether it was published as the player's last word for the round. */
  final: boolean;
}

/**
 * How far my current move has got, for a move composed across a round.
 *
 * - `local` — edited but not yet published; the cadence timer has not fired.
 * - `sent` — published to relays, but the GM has not acknowledged this revision.
 * - `received` — a `status` event from the GM reports this `rev` or higher.
 *
 * `sent` is the state that matters to a player: their move is on a relay but
 * nothing yet proves the GM has it, and if the round closed now they might lose
 * the work. Only `received` rules that out.
 */
export type MoveSyncState = 'local' | 'sent' | 'received';

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

  /** My in-flight move — the highest revision I have published this round. */
  pending: PendingMove<Move> | null;

  /** How far my current move has got toward the GM. */
  sync: MoveSyncState;
  /**
   * The highest revision the GM has acknowledged from me, from its `status`
   * events. `-1` when it has acknowledged nothing this round.
   */
  ackedRev: number;
  /**
   * Per-player acknowledgement, straight from the latest `status` event — the
   * "4 of 6 locked in" indicator. Empty when the GM publishes no status.
   */
  received: Record<Hex, { rev: number; final: boolean }>;
  /**
   * When the open round times out, on **this client's clock** (unix seconds).
   *
   * Null for an untimed round, and until the first `status` of a round arrives.
   * The GM reports a duration, not an instant (NIP-GM §Round status); the
   * session adds it to the local clock on receipt so a UI can count down
   * without caring how far the two machines' clocks are apart. Each status
   * re-anchors it, so the value converges rather than drifting with a browser
   * timer.
   *
   * It is an estimate, out by the event's flight time, and it is not the
   * authority on anything: the GM closes its own rounds. Nothing but a
   * countdown should be driven from it.
   */
  deadline: number | null;

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
  // A non-final revision is a move still being composed, so I do still owe one.
  // Treating any pending revision as "done" is the bug this guards: with
  // revisions the player publishes many times per round, and the first
  // publication would otherwise silently switch the UI off.
  if (pending?.final) return false;
  return awaiting.includes(me);
}

/**
 * Where my move stands relative to the GM's acknowledgements.
 *
 * `ackedRev` is the highest revision the GM reported for me in a `status`
 * event; a GM that publishes no status leaves every published revision at
 * `sent`, which is the honest answer rather than an optimistic one.
 */
export function moveSyncState(pending: PendingMove | null, ackedRev: number): MoveSyncState {
  if (!pending) return 'local';
  return ackedRev >= pending.rev ? 'received' : 'sent';
}
