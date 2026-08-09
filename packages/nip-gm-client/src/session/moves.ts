/**
 * Composing a move across a round.
 *
 * A player in a simultaneous-round game does not decide once; they queue
 * actions, change their mind, and may still be editing when the round closes.
 * NIP-GM §Move revisions makes that safe: each publication carries the player's
 * *complete* move under an incrementing `rev`, and the GM keeps the highest one
 * it holds. This is the client half of that — it owns the round's ephemeral key,
 * the revision counter, and when publication happens.
 *
 * Three rules it exists to enforce, none of which a UI should have to remember:
 *
 * 1. **One ephemeral key per round, reused by every revision.** Not an
 *    optimization. NIP-GM §Hidden Information makes it load-bearing: because one
 *    key opens the whole round, the key the GM must reveal for the revision it
 *    applied also opens the ones it discarded, so it cannot apply a stale
 *    revision and suppress the rest. A fresh key per revision would make hidden
 *    revisions permanently unreadable and the audit unfalsifiable.
 * 2. **Every revision is a complete move.** Never a delta against the last one —
 *    relays drop and reorder, and a complete snapshot means a lost revision is
 *    repaired by the next rather than leaving a gap nothing can close.
 * 3. **Publication on a fixed cadence, when one is configured.** The contents
 *    are encrypted but the event *count* is not, so a player who publishes
 *    fifteen revisions has visibly agonized while one who publishes once has
 *    not. A cadence decouples publication from keystrokes.
 */
import {
  buildMove,
  encrypt,
  formatMoveEnvelope,
  generateEphemeralKeypair,
  playerConversationKey,
  type Clock,
  type EphemeralKeypair,
  type Hex,
  type PersistenceMode,
  type Signer,
  type Transport,
} from 'nip-gm-core';
import type { PendingMove } from '../snapshot.js';

export interface MoveComposerOptions<Move> {
  transport: Transport;
  signer: Signer;
  /** The GM's pubkey — moves are encrypted to it and `p`-tagged at it. */
  gm: Hex;
  gameId: Hex;
  mode: PersistenceMode;
  clock: Clock;
  /**
   * Seconds between revision publications.
   *
   * `0` publishes on every draft change, which is simplest and is what a
   * turn-taking game wants. Anything above 0 batches: the draft is published on
   * the tick whether or not it changed, so the number of events a player emits
   * reflects the length of the round rather than how hard they thought.
   *
   * Note the limit of what a cadence can hide: a player who never drafts
   * publishes nothing, so silence is still legible. A game that cares seeds
   * every player with a default draft the moment the round opens.
   */
  cadence: number;
  /** The module's wire encoding — `parseMove`'s inverse. */
  encode(move: Move): { type: string; data: unknown };
  /** Called after each successful publication, with the new pending state. */
  onPublished(pending: PendingMove<Move>): void;
  /** Called when a publication fails, so the session can surface it. */
  onError(error: Error): void;
}

interface OpenRound<Move> {
  seq: number;
  prev: Hex;
  /** Shared by every revision of this round — see rule 1 above. */
  ephemeral: EphemeralKeypair;
  conversationKey: Uint8Array;
  /** The next `rev` to publish. */
  next: number;
  draft: Move | null;
  final: boolean;
  timer: { cancel(): void } | null;
}

export interface MoveComposer<Move> {
  /**
   * Open a round for submission. Called by the session when a delta (or the
   * start event) puts this player in `awaiting`.
   */
  open(seq: number, prev: Hex): void;
  /** The round closed — drop the key and stop the cadence. */
  close(): void;
  /** Replace my draft. Published on the next cadence tick, or immediately at cadence 0. */
  draft(move: Move): void;
  /** Publish now and declare it my last word for the round. Resolves once it is on the wire. */
  commit(move?: Move): Promise<void>;
  /** Publish the current draft now as a non-final revision. */
  flush(): Promise<void>;
  readonly pending: PendingMove<Move> | null;
  readonly isOpen: boolean;
}

export function createMoveComposer<Move>(
  options: MoveComposerOptions<Move>,
): MoveComposer<Move> {
  let round: OpenRound<Move> | null = null;
  let pending: PendingMove<Move> | null = null;

  const stopTimer = (): void => {
    round?.timer?.cancel();
    if (round) round.timer = null;
  };

  const scheduleTick = (): void => {
    if (!round || options.cadence <= 0 || round.final) return;
    round.timer = options.clock.setTimeout(options.cadence, () => {
      if (!round || round.final) return;
      round.timer = null;
      // Republished even when unchanged: fixed cadence is the point.
      void publish(false).catch(options.onError);
      scheduleTick();
    });
  };

  async function publish(final: boolean): Promise<void> {
    const current = round;
    if (!current || current.draft === null) return;

    const rev = current.next;
    // Claim the revision number before awaiting, so two overlapping
    // publications cannot both take it and equivocate at one `rev`.
    current.next = rev + 1;
    if (final) {
      current.final = true;
      stopTimer();
    }

    const move = current.draft;
    const wire = options.encode(move);
    const ciphertext = encrypt(
      formatMoveEnvelope({
        seq: current.seq,
        prev: current.prev,
        rev,
        final,
        type: wire.type,
        data: wire.data,
      }),
      current.conversationKey,
    );

    const event = await options.signer.signEvent({
      ...buildMove(options.gameId, options.gm, ciphertext, {
        ephemeral: current.ephemeral.pubkey,
        mode: options.mode,
      }),
      pubkey: await options.signer.getPublicKey(),
      created_at: options.clock.now(),
    });

    await options.transport.publish(event);

    // The round may have closed while this was in flight; a late publication is
    // harmless on the wire but must not resurrect a stale pending move.
    if (round !== current) return;

    pending = { id: event.id, seq: current.seq, move, submittedAt: event.created_at, rev, final };
    options.onPublished(pending);
  }

  return {
    open(seq: number, prev: Hex): void {
      stopTimer();
      const ephemeral = generateEphemeralKeypair();
      round = {
        seq,
        prev,
        ephemeral,
        conversationKey: playerConversationKey(ephemeral, options.gm),
        next: 0,
        draft: null,
        final: false,
        timer: null,
      };
      pending = null;
    },

    close(): void {
      stopTimer();
      round = null;
      pending = null;
    },

    draft(move: Move): void {
      if (!round || round.final) return;
      round.draft = move;
      if (options.cadence <= 0) {
        void publish(false).catch(options.onError);
      } else if (!round.timer) {
        scheduleTick();
      }
    },

    async commit(move?: Move): Promise<void> {
      if (!round) return;
      if (move !== undefined) round.draft = move;
      if (round.final) return;
      await publish(true);
    },

    async flush(): Promise<void> {
      await publish(false);
    },

    get pending(): PendingMove<Move> | null {
      return pending;
    },

    get isOpen(): boolean {
      return round !== null;
    },
  };
}
