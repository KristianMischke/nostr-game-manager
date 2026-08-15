/**
 * Following one game as a player or a spectator.
 *
 * The session owns a store; a UI subscribes to it. React never holds game state
 * — `nip-gm-react` bridges this store through `useSyncExternalStore`, and the
 * verifier and headless tests use the same session with no framework present.
 *
 * ## Why the client folds patches instead of replaying
 *
 * `replay()` is the protocol's single source of truth, and a client that could
 * run it would need to trust the GM for nothing. It cannot, while a game is
 * running: replay needs the seed, and the seed is committed at start and
 * revealed only at end — that is the whole point of the commitment. So between
 * start and end, `patch` is the only path from one public state to the next, and
 * a client's view is exactly as good as the module's `applyPatch`.
 *
 * What that costs is worth stating plainly: **a live client cannot detect a
 * dishonest GM.** It can detect an inconsistent one — a broken `seq` chain, a
 * patch its module rejects — but a GM that publishes a coherent lie is
 * indistinguishable until the seed reveal makes the whole log auditable. That is
 * not a gap in this implementation; it is the trust model NIP-GM is built on,
 * and it is why `auditGame` exists.
 */
import {
  gameFilter,
  headFilter,
  myResponsesFilter,
  parseHead,
  parseMessage,
  parseResponseBody,
  parseState,
  systemClock,
  verifyEvent,
  type Clock,
  type GameDelta,
  type GameModule,
  type GameResult,
  type Hex,
  type NostrEvent,
  type PersistenceMode,
  type Signer,
  type Subscription,
  type Transport,
} from 'nip-gm-core';
import { createStore, type ReadableStore } from '../store.js';
import {
  moveSyncState,
  needsMyMove,
  type GameSnapshot,
  type PendingMove,
  type ProtocolError,
} from '../snapshot.js';
import { createMoveComposer, type MoveComposer } from './moves.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyModuleOf<Move> = GameModule<any, any, Move, any>;

export interface GameSessionOptions<Move> {
  transport: Transport;
  module: AnyModuleOf<Move>;
  /** The GM whose announcement this client chose to trust. */
  gm: Hex;
  gameId: Hex;
  /** Omit for a spectator: a session with no signer follows but never submits. */
  signer?: Signer;
  mode?: PersistenceMode;
  clock?: Clock;
  /** Revision publication cadence in seconds; see {@link MoveComposerOptions.cadence}. */
  cadence?: number;
}

export interface GameSession<View, Move> extends ReadableStore<GameSnapshot<View, Move>> {
  /** Fetch the start event and head, then subscribe. Resolves once caught up. */
  start(): Promise<void>;
  /** Close every subscription and cancel the cadence timer. Idempotent. */
  close(): void;
  /** Replace my draft for the open round. */
  draft(move: Move): void;
  /** Publish my final revision for the round. */
  commit(move?: Move): Promise<void>;
  /** Publish the current draft now without declaring it final. */
  flush(): Promise<void>;
}

function emptySnapshot<View, Move>(gameId: Hex): GameSnapshot<View, Move> {
  return {
    status: 'loading',
    gameId,
    seq: 0,
    prev: gameId,
    state: undefined as View,
    privateState: null,
    seats: [],
    awaiting: [],
    needsMyMove: false,
    pending: null,
    sync: 'local',
    ackedRev: -1,
    received: {},
    deadline: null,
    error: null,
    result: null,
  };
}

/**
 * The deadline to hold after a fresh `status`.
 *
 * Both clocks involved tick in whole seconds — the GM's when it computes what
 * remains, this client's when it anchors that duration — so two anchors of the
 * *same* instant can land a second apart. Taking every one of them literally
 * makes a countdown that stutters back and forth by a second on each heartbeat.
 * A move of a second or less is that rounding, not news; anything larger is the
 * GM saying something changed and is taken at face value.
 */
function reanchor(held: number | null, next: number | null): number | null {
  if (next === null || held === null) return next;
  return Math.abs(next - held) <= 1 ? held : next;
}

export function createGameSession<View, Move>(
  options: GameSessionOptions<Move>,
): GameSession<View, Move> {
  const { transport, module, gm, gameId } = options;
  const mode = options.mode ?? 'verified';
  const clock = options.clock ?? systemClock;

  const store = createStore<GameSnapshot<View, Move>>(emptySnapshot(gameId));
  const subscriptions: Subscription[] = [];

  let me: Hex | undefined;
  let composer: MoveComposer<Move> | null = null;
  let closed = false;

  /** Deltas that arrived out of order, held until the chain reaches them. */
  const buffered = new Map<number, { delta: GameDelta; id: Hex }>();
  /** Set once the head (or the start event) has given us something to fold onto. */
  let bootstrapped = false;

  const patch = (next: Partial<GameSnapshot<View, Move>>): void => {
    store.set({ ...store.getSnapshot(), ...next });
  };

  const setError = (code: string, message: string, moveId?: Hex): void => {
    patch({ error: { code, message, moveId } satisfies ProtocolError });
  };

  /** Recompute the fields derived from the raw ones, so they never drift apart. */
  const refresh = (next: Partial<GameSnapshot<View, Move>>): void => {
    const merged = { ...store.getSnapshot(), ...next };
    const pending = merged.pending;
    store.set({
      ...merged,
      needsMyMove: needsMyMove(merged.awaiting, me, pending),
      sync: moveSyncState(pending, merged.ackedRev),
    });
  };

  /* --- rounds ------------------------------------------------------------ */

  const openRound = (seq: number, prev: Hex, awaiting: Hex[]): void => {
    if (!composer || !me) return;
    composer.close();
    if (awaiting.includes(me)) composer.open(seq, prev);
  };

  /* --- folding ----------------------------------------------------------- */

  const applyDelta = (delta: GameDelta, eventId: Hex): void => {
    const current = store.getSnapshot();

    if (!module.applyPatch) {
      setError(
        'no_patch_folder',
        `module ${module.id} does not implement applyPatch, so a client cannot follow a live game`,
      );
      return;
    }

    let view: View;
    try {
      view = module.applyPatch(current.state, delta.content.patch) as View;
    } catch (e) {
      // A patch the module cannot fold means the GM and this client disagree
      // about the ruleset. Stop folding rather than drift silently.
      setError('patch_rejected', `module rejected the patch at seq ${delta.seq}: ${(e as Error).message}`);
      return;
    }

    refresh({
      state: view,
      seq: delta.seq,
      prev: eventId,
      awaiting: delta.awaiting,
      // A new round means a new revision stream; last round's acks are stale.
      ackedRev: -1,
      received: {},
      // As is its countdown. The GM publishes a status as it opens the new
      // round, so the gap is one relay hop, and showing no clock for that hop
      // beats showing the previous round's.
      deadline: null,
      pending: null,
    });
    openRound(delta.seq + 1, eventId, delta.awaiting);
  };

  /** Apply everything buffered that continues the chain, in order. */
  const drain = (): void => {
    for (;;) {
      const next = buffered.get(store.getSnapshot().seq + 1);
      if (!next || !bootstrapped) return;
      buffered.delete(next.delta.seq);
      applyDelta(next.delta, next.id);
    }
  };

  const onState = (event: NostrEvent): void => {
    if (event.pubkey !== gm) return; // Only the GM authors state for this game.
    if (!verifyEvent(event)) {
      setError('bad_signature', `state event ${event.id.slice(0, 8)} has an invalid signature`);
      return;
    }

    const parsed = parseState(event);
    if (!parsed.ok) {
      setError('bad_state_event', `state event did not parse: ${parsed.error}`);
      return;
    }
    const state = parsed.value;

    switch (state.type) {
      case 'start':
        // Seat order comes from the tags, verbatim, and is never sorted.
        refresh({
          status: 'active',
          seats: state.seats,
          awaiting: store.getSnapshot().awaiting,
        });
        return;

      case 'delta': {
        const current = store.getSnapshot();

        if (state.seq === current.seq && bootstrapped) {
          // The delta whose state the head already contains. Its patch must not
          // be folded again, but it is the only thing that carries who the open
          // round awaits and which event id a move must pin as `prev` — so a
          // client that bootstrapped from a head mid-game would otherwise be
          // unable to move at all until the *next* delta landed.
          if (current.prev === event.id) return;
          refresh({ prev: event.id, awaiting: state.awaiting });
          openRound(state.seq + 1, event.id, state.awaiting);
          return;
        }

        if (state.seq < current.seq) return; // Superseded; already folded.
        buffered.set(state.seq, { delta: state, id: event.id });
        drain();
        return;
      }

      case 'status': {
        // GM-asserted and unordered with respect to everything else, so it only
        // ever touches acknowledgement fields — never state, never seq.
        if (state.seq !== store.getSnapshot().seq + 1) return;
        const mine = me ? state.received[me] : undefined;
        // Anchored to the local clock at receipt, so a client whose clock is
        // minutes off the GM's still counts down the right number of seconds.
        const anchored = state.remaining === undefined ? null : clock.now() + state.remaining;
        refresh({
          received: state.received,
          ackedRev: mine ? mine.rev : -1,
          deadline: reanchor(store.getSnapshot().deadline, anchored),
        });
        return;
      }

      case 'private': {
        if (!me || state.recipient !== me || !options.signer) return;
        void options.signer
          .nip44Decrypt(gm, state.content)
          .then((plaintext) => refresh({ privateState: JSON.parse(plaintext) as unknown }))
          .catch(() => setError('private_undecryptable', 'private state could not be decrypted'));
        return;
      }

      case 'end':
      case 'abort': {
        composer?.close();
        refresh({
          status: state.type === 'end' ? 'ended' : 'aborted',
          awaiting: [],
          pending: null,
          deadline: null,
          result: (state.content.result ?? null) as GameResult | null,
        });
        return;
      }
    }
  };

  const onResponse = (event: NostrEvent): void => {
    const parsed = parseMessage(event);
    if (!parsed.ok || parsed.value.action !== 'response') return;
    const body = parseResponseBody(parsed.value.content);
    if (!body.ok || body.value.status !== 'rejected') return;
    setError('move_rejected', body.value.reason, parsed.value.target);

    // A refused move is not a submitted move. The composer reopens the round
    // (it had marked itself `final` on publication) and drops the pending
    // revision, so `needsMyMove` goes back to true and the player is asked to
    // act instead of watching the turn clock run out on a move the GM already
    // threw away.
    composer?.reject(parsed.value.target);
    refresh({ pending: composer?.pending ?? null });
  };

  /* --- lifecycle --------------------------------------------------------- */

  return {
    getSnapshot: store.getSnapshot,
    subscribe: store.subscribe,

    async start(): Promise<void> {
      me = options.signer ? await options.signer.getPublicKey() : undefined;

      if (options.signer) {
        composer = createMoveComposer<Move>({
          transport,
          signer: options.signer,
          gm,
          gameId,
          mode,
          clock,
          cadence: options.cadence ?? 0,
          encode: (move) => {
            if (!module.encodeMove) {
              throw new Error(`module ${module.id} does not implement encodeMove`);
            }
            return module.encodeMove(move);
          },
          onPublished: (pending) => refresh({ pending: pending as PendingMove<Move> }),
          onError: (error) => setError('publish_failed', error.message),
        });
      }

      // The head is a cheap single replaceable event and gives us a view to
      // fold onto; without it a client would have to replay from start, which
      // it cannot do (no seed). See the note at the top of this file.
      const [starts, heads] = await Promise.all([
        transport.query([{ ids: [gameId] }]),
        transport.query([headFilter(gm, gameId)]),
      ]);

      for (const event of starts) onState(event);

      const head = heads[0] && parseHead(heads[0]);
      if (head && head.ok && heads[0].pubkey === gm) {
        bootstrapped = true;
        refresh({
          // Taken as-is, NOT through `deserialize`. The head carries what
          // `redact` produced (see `publishHead` in the runner), and `redact`
          // output is not `serialize` output — `deserialize` is the inverse of
          // the latter only. Feeding one to the other happens to work for a
          // module whose `State` is already a plain object, and breaks for a
          // module whose `State` is a class. It also has to be the redacted
          // view for `applyPatch` to fold onto, which the module contract is
          // explicit about.
          state: head.value.state as View,
          seq: head.value.seq,
          // At seq 0 the state was made against the start event itself.
          prev: head.value.seq === 0 ? gameId : store.getSnapshot().prev,
        });
        if (head.value.seq === 0) {
          const seats = store.getSnapshot().seats;
          const awaiting = module.awaitingAtStart?.(seats) ?? [...seats];
          refresh({ awaiting });
          openRound(1, gameId, awaiting);
        }
      }

      if (closed) return;
      subscriptions.push(transport.subscribe([gameFilter(gameId, { mode })], { onEvent: onState }));
      if (me) {
        subscriptions.push(
          transport.subscribe([myResponsesFilter(me, gm)], { onEvent: onResponse }),
        );
      }

      drain();

      if (!bootstrapped) {
        setError('no_head', 'the GM has published no head snapshot, so no view can be built');
      }
    },

    close(): void {
      closed = true;
      composer?.close();
      for (const sub of subscriptions) sub.close();
      subscriptions.length = 0;
    },

    draft(move: Move): void {
      composer?.draft(move);
    },

    async commit(move?: Move): Promise<void> {
      await composer?.commit(move);
    },

    async flush(): Promise<void> {
      await composer?.flush();
    },
  };
}
