/**
 * The daemon: announcements, inbox, routing, and a runner per live game.
 *
 * Everything a player can say to a GM arrives on one kind (2600/21600) tagged
 * with the GM's pubkey, so the daemon needs exactly one subscription and routes
 * by `action`. This file is that router plus the lifecycle around it; the rules
 * live in `runner.ts` and `lobby-manager.ts`.
 *
 * ## Messages are handled one at a time, in arrival order
 *
 * Not an implementation detail — a correctness requirement. Admitting a move
 * means reading the round's current highest `rev` for that player, deciding, and
 * writing it back; two of those interleaved across an `await` would let one
 * revision clobber another's bookkeeping and let the GM publish a round it
 * cannot justify. The queue below makes each message's read-decide-write atomic,
 * and it costs nothing: a turn-based GM is never throughput-bound.
 */
import {
  KIND,
  announcementAddress,
  buildAnnouncement,
  buildDiscoveryOffer,
  buildResponse,
  discoveryFilter,
  gameMessagesFilter,
  inboxFilter,
  parseCreateRequest,
  parseDiscovery,
  parseMessage,
  parseState,
  systemClock,
  verifyEvent,
  type AnyGameModule,
  type Clock,
  type GameMessage,
  type Hex,
  type KeySigner,
  type NostrEvent,
  type LobbyConfig,
  type SeedCommitment,
  type Subscription,
  type Transport,
} from 'nip-gm-core';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import {
  createLobbyManager,
  defaultLobbyDefaults,
  type LobbyDefaults,
  type LobbyManager,
  type ManagedLobby,
} from './lobby-manager.js';
import { mayCreate, type GMPolicy } from './policy.js';
import { createPublisher, type Publisher } from './publisher.js';
import { readSecretBody, type Decrypt } from './secret-body.js';
import { createRunner, type GameRunner, type RunnerResume } from './runner.js';
import type { GMStore, StoredGame, StoredLobby } from './store.js';

/**
 * What a GM with no `maxConcurrentGames` reports as its capacity.
 *
 * The offer's `capacity` is a count, and the wire has no way to say "unbounded".
 * Clients compare it against zero — full or not — so any comfortably large
 * number says the true thing; this one is picked to look like what it is rather
 * than like a real tally.
 */
const UNBOUNDED_CAPACITY = 999;

export interface GMOptions {
  modules: AnyGameModule[];
  /**
   * Must be a KeySigner, not a plain Signer: the GM reveals raw NIP-44
   * conversation keys in round-closing deltas, so it needs a local key. A
   * NIP-46 remote signer cannot host a game, and the type says so rather than
   * letting it be discovered at integration time.
   */
  signer: KeySigner;
  transport: Transport;
  relays?: string[];
  policy: GMPolicy;
  /** Injected so tests run instantly and wall-clock never leaks into replay. */
  clock?: Clock;
  lobbyDefaults?: Partial<LobbyDefaults>;
  /** See {@link RunnerOptions.statusInterval}. Seconds; 0 disables the heartbeat. */
  statusInterval?: number;
  /** See {@link RunnerOptions.resumeGrace}. Seconds; only affects a resumed round. */
  resumeGrace?: number;
  /**
   * Where the daemon writes itself down. Absent, it is exactly as it was: fast,
   * simple, and unable to survive its own process.
   *
   * With one, `start()` becomes a resume — see the boot sequence in `start()`
   * below, whose *order* is the load-bearing part.
   *
   * Opened by `start()` and **not** closed by `stop()`: the caller owns the
   * handle. A deployment that puts a rollover lease in the same file needs it
   * open after the daemon has stopped, to hand the baton over.
   */
  store?: GMStore;
  /**
   * Ignore inbox messages older than this (unix seconds). Defaults to startup.
   *
   * The inbox rides kind 2600, which is a *regular* kind — relays store it. A
   * subscription with no `since` therefore replays every message ever addressed
   * to this GM the moment it connects, and `handle()` acts on all of them: each
   * historical `create` mints a fresh lobby with a fresh identifier and a fresh
   * published lobby event, every restart, forever. What looks like a busy GM is
   * a GM re-answering last month's post.
   *
   * Defaulting to startup is the conservative reading of "a daemon serves the
   * players who are here now". It does mean a message sent while the process was
   * down is not seen, which is the right trade until a GM can resume the games
   * those messages belong to — a GM that adopts an old `move` but has no runner
   * for its game would drop it anyway.
   *
   * Set it explicitly to widen the window (a GM that restores its games wants
   * `roundOpenedAt`, not `now`), or to 0 to take everything the relay offers.
   */
  inboxSince?: number;
}

export interface GM {
  start(): Promise<void>;
  stop(): Promise<void>;
  readonly pubkey: Hex;
  /** Live games by id — for tests and for an operator's status endpoint. */
  readonly games: ReadonlyMap<Hex, GameRunner>;
  /**
   * The lobby manager, for the operator actions no player can send.
   *
   * Exposed because a GM embedded in a client has a person behind it — one who
   * can see who joined and may want to remove them, or change a join code they
   * have shared too widely. A daemon has no use for it and no UI to drive it
   * from. Nothing here is a protocol message: the GM is the sole writer of
   * lobby membership, so these are direct edits followed by the same republish
   * every other membership change gets.
   */
  readonly lobbies: LobbyManager;
  /** Resolves once every message received so far has been fully handled. */
  drain(): Promise<void>;
}

export function createGM(options: GMOptions): GM {
  const { transport, signer, policy } = options;
  const clock = options.clock ?? systemClock;
  const relays = options.relays ?? [];
  const defaults: LobbyDefaults = { ...defaultLobbyDefaults, relays, ...options.lobbyDefaults };

  const modules = new Map<string, AnyGameModule>(options.modules.map((m) => [m.id, m]));
  const runners = new Map<Hex, GameRunner>();
  const subscriptions: Subscription[] = [];

  let pubkey: Hex | undefined;
  let lobbies: LobbyManager | undefined;

  // See the note at the top of this file: strictly serial, by design.
  let queue: Promise<void> = Promise.resolve();
  const enqueue = (work: () => Promise<void>): void => {
    queue = queue.then(work).catch((error: unknown) => {
      // One malformed message must not kill the daemon or stall every game
      // queued behind it. It is dropped, loudly.
      console.error('[nip-gm] failed to handle message:', error);
    });
  };

  const store = options.store;

  /**
   * Built in `start()`, not here, because its watermarks come out of the store
   * and the store is not open until then. Still exactly one publisher for the
   * whole daemon: the monotonic `created_at` guard is per-coordinate state, and
   * two publishers writing the same lobby would each think they were first.
   */
  let publish!: Publisher;

  const decrypt: Decrypt = (peer, ciphertext) => signer.nip44Decrypt(peer, ciphertext);

  /**
   * A managed lobby in the form the store keeps, and back again.
   *
   * The seed and salt cross as hex rather than as `Uint8Array`: a store is
   * expected to be a database, and a byte array that survived only as a live
   * object reference is a resume that works in a test and fails in production.
   */
  const toStoredLobby = (managed: ManagedLobby): StoredLobby => ({
    identifier: managed.lobby.lobbyId,
    module: managed.module,
    openedAt: managed.openedAt,
    lobby: managed.lobby,
    seed: bytesToHex(managed.commitment.seed),
    salt: bytesToHex(managed.commitment.salt),
    commit: managed.commitment.commit,
    ...(managed.code === undefined ? {} : { code: managed.code }),
    ...(managed.denied === undefined ? {} : { denied: managed.denied }),
    ...(managed.lobby.gameId === undefined ? {} : { gameId: managed.lobby.gameId }),
  });

  const fromStoredLobby = (stored: StoredLobby, gmPubkey: Hex): ManagedLobby => ({
    lobby: stored.lobby,
    address: { kind: KIND.LOBBY, pubkey: gmPubkey, identifier: stored.identifier },
    commitment: {
      seed: hexToBytes(stored.seed),
      salt: hexToBytes(stored.salt),
      commit: stored.commit,
    },
    openedAt: stored.openedAt,
    module: stored.module,
    ...(stored.code === undefined ? {} : { code: stored.code }),
    ...(stored.denied === undefined ? {} : { denied: stored.denied }),
  });

  /** The runner's durable safe points, forwarded to the store. See `store.ts`. */
  const persistence = store && {
    roundOpened: (round: Parameters<GMStore['openRound']>[0]) => store.openRound(round),
    revisionAccepted: (revision: Parameters<GMStore['acceptRevision']>[0]) =>
      store.acceptRevision(revision),
    roundCommitted: (commit: Parameters<GMStore['commitRound']>[0]) => store.commitRound(commit),
    sent: (eventId: Hex) => store.markSent(eventId),
  };

  /**
   * One place where a runner is built, for both a new game and a resumed one.
   *
   * Deliberately not two: a resume that assembled its options separately would
   * be free to differ from the original in a way nothing caught until a round
   * closed against the wrong config.
   */
  function buildRunner(
    gmPubkey: Hex,
    module: AnyGameModule,
    start: NostrEvent,
    seats: Hex[],
    rawConfig: unknown,
    commitment: SeedCommitment,
    lobby: LobbyConfig,
    resume?: RunnerResume,
  ): GameRunner {
    return createRunner({
      module,
      publish,
      signer,
      clock,
      gmPubkey,
      start,
      seats,
      config: module.parseConfig(rawConfig),
      commitment,
      lobby,
      statusInterval: options.statusInterval,
      ...(options.resumeGrace === undefined ? {} : { resumeGrace: options.resumeGrace }),
      onEnd: (gameId) => runners.delete(gameId),
      ...(persistence ? { persist: persistence } : {}),
      ...(resume ? { resume } : {}),
    });
  }

  const buildLobbyManager = (gmPubkey: Hex): LobbyManager =>
    createLobbyManager({
      publish,
      gmPubkey,
      clock,
      defaults,
      decrypt,
      ...(store ? { nextSequence: () => store.nextLobbySequence() } : {}),
      ...(store
        ? {
            async onChange(managed): Promise<void> {
              // A closed lobby is gone rather than kept as a tombstone: the
              // relay holds the closed lobby event, which is the record, and a
              // GM that reloaded closed lobbies would republish a list of rooms
              // nobody can enter. Its seed goes with it, which is safe only
              // because a lobby closes solely before a game starts.
              if (managed.lobby.status === 'closed') {
                await store.dropLobby(managed.lobby.lobbyId);
                return;
              }
              await store.putLobby(toStoredLobby(managed));
            },
            async onBeginGame(managed, start): Promise<void> {
              await store.beginGame(
                {
                  gameId: start.id,
                  lobbyId: managed.lobby.lobbyId,
                  start,
                  lobbyConfig: managed.lobby.config,
                  seed: bytesToHex(managed.commitment.seed),
                  salt: bytesToHex(managed.commitment.salt),
                  // Seq 0: the game exists and has dealt nothing. A resume from
                  // here re-runs `module.init` off the same seed and lands on
                  // the same board.
                },
                { event: start, purpose: 'start', gameId: start.id, seq: 0 },
                toStoredLobby(managed),
              );
            },
            onSent: (eventId: Hex) => store.markSent(eventId),
          }
        : {}),
      async onStart(managed, start) {
        const module = modules.get(managed.module);
        if (!module) return;

        const runner = buildRunner(
          gmPubkey,
          module,
          start,
          // Seat order, verbatim from the lobby roster.
          managed.lobby.players.map((p) => p.pubkey),
          managed.lobby.config.config,
          managed.commitment,
          managed.lobby.config,
        );

        runners.set(start.id, runner);
        await runner.open();
      },
    });

  /**
   * Answer a discovery request, which is how a client learns this GM is up.
   *
   * An announcement (kind 32600) is addressable and outlives the process that
   * wrote it: it is published once at startup and sits on the relay whether or
   * not the daemon is still running, so a directory built from announcements
   * alone lists yesterday's GMs beside today's with nothing to tell them apart.
   * The offer is the part only a live GM can produce — NIP-GM §Discovery calls
   * it a liveness/capacity signal, and both kinds are ephemeral, so nothing here
   * leaves a trace on the relay.
   *
   * The request's `version` tag is not matched against the module's. Version
   * negotiation belongs to the announcement, which the spec makes the source of
   * truth for compatibility; refusing to answer an incompatible client would
   * only tell it "offline" when the truth is "here, but not for you".
   */
  async function answerDiscovery(event: NostrEvent): Promise<void> {
    if (!pubkey || event.pubkey === pubkey || !verifyEvent(event)) return;

    const parsed = parseDiscovery(event);
    if (!parsed.ok || parsed.value.type !== 'request') return;

    const module = modules.get(parsed.value.game);
    if (!module) return;

    // Answered per requester, not in general: `mayCreate` also decides
    // allowlists, so a player this GM would refuse hears "up, and full" rather
    // than being counted as one of its open seats.
    const decision = mayCreate(policy, event.pubkey, runners.size);
    const capacity = !decision.ok
      ? 0
      : policy.maxConcurrentGames === undefined
        ? UNBOUNDED_CAPACITY
        : Math.max(0, policy.maxConcurrentGames - runners.size);

    await publish(
      buildDiscoveryOffer({
        requestId: event.id,
        player: event.pubkey,
        announcement: announcementAddress(pubkey, module.id),
        capacity,
      }),
    );
  }

  /**
   * Send what the last process signed and did not manage to send.
   *
   * The signed bytes, not a rebuild: an event id is a hash of its own content,
   * so re-sending is the relay seeing the same event again, while re-deriving
   * would take a fresh `created_at`, mint a second id, and leave two deltas at
   * one `seq`. That is not a duplicate — it is a fork in the log, signed by this
   * GM, and it is what `auditGame` reports as a broken chain.
   *
   * Asking the relay first, rather than publishing and hoping, because relays
   * disagree about duplicates: strfry answers `OK true "duplicate: have this
   * event"` and NDK reads that as success, but a relay answering `OK false`
   * would make this throw and take the daemon down on startup. The query is
   * free in the normal case, where there is nothing pending at all.
   */
  async function flushOutbox(active: GMStore): Promise<void> {
    const pending = await active.pending();
    if (pending.length === 0) return;

    for (const { event } of pending) {
      // Ephemeral events are stored nowhere, so there is nothing to ask about
      // and nothing to be duplicated — a re-send is a broadcast to whoever is
      // listening now, which after a restart is what was wanted anyway.
      const ephemeral = event.kind >= 20000 && event.kind < 30000;
      const held = ephemeral ? [] : await transport.query([{ ids: [event.id] }]);
      if (held.length === 0) await transport.publish(event);
      await active.markSent(event.id);
    }
  }

  /**
   * Rebuild one game in progress.
   *
   * Everything comes from the start event rather than from the lobby: the seat
   * order and the raw config are covered by the GM's own signature there, and a
   * resume that took them from a lobby document edited since would deal a
   * different game from the one the start event committed to.
   */
  async function resumeGame(active: GMStore, gmPubkey: Hex, game: StoredGame): Promise<void> {
    const parsed = parseState(game.start);
    if (!parsed.ok || parsed.value.type !== 'start') {
      console.error(`[nip-gm] cannot resume ${game.gameId}: start event does not parse`);
      return;
    }
    const module = modules.get(parsed.value.game);
    if (!module) {
      // Not an error worth throwing over — a GM may legitimately be restarted
      // with a module removed — but it is silent data loss if unsaid.
      console.error(`[nip-gm] cannot resume ${game.gameId}: module ${parsed.value.game} not hosted`);
      return;
    }

    const stored = await active.loadRound(game.gameId);
    const runner = buildRunner(
      gmPubkey,
      module,
      game.start,
      parsed.value.seats,
      parsed.value.content.config,
      {
        seed: hexToBytes(game.seed),
        salt: hexToBytes(game.salt),
        commit: parsed.value.content.seedCommit ?? '',
      },
      game.lobbyConfig,
      {
        ...(game.snapshot ? { snapshot: game.snapshot } : {}),
        ...(stored
          ? { round: { record: stored.round, accepted: stored.revisions.map((r) => r.event) } }
          : {}),
      },
    );

    runners.set(game.gameId, runner);
    await runner.resume();

    // The moves that arrived while nobody was listening.
    //
    // This is what turns "a move made during a deploy is lost" into "a move made
    // during a deploy lands late". It is possible only in `verified` mode, where
    // moves ride the regular kind and the relay kept them; in `casual` they were
    // ephemeral and are genuinely gone, so the round timeout is the only
    // recourse and players resend.
    //
    // Scoped to the open round rather than the whole game: anything older
    // belongs to a round that has already closed, and `checkEnvelope` would
    // refuse it anyway — but asking for it would mean pulling the entire move
    // history of every live game on every restart.
    if (!stored || game.lobbyConfig.mode !== 'verified') return;

    const already = new Set(stored.revisions.map((r) => r.event.id));
    const missed = await transport.query([
      { ...gameMessagesFilter(game.gameId), since: stored.round.openedAt },
    ]);
    for (const event of missed) {
      if (already.has(event.id) || event.pubkey === gmPubkey) continue;
      await runner.handleMove(event);
      // The inbox subscription opened below reaches back over the same window
      // and will offer these again. An *admitted* move is already covered — the
      // revision was written with `cause: event.id`, so `wasHandled` catches the
      // second offer. This line is for the ones that were refused, which leave
      // no durable trace and would otherwise be re-judged and re-rejected on
      // every restart for as long as the round stays open.
      await active.markHandled(event.id, event.created_at);
    }
  }

  async function handle(event: NostrEvent): Promise<void> {
    if (!verifyEvent(event)) return;
    if (event.pubkey === pubkey) return; // Our own responses come back to us.

    const parsed = parseMessage(event);
    if (!parsed.ok) return;
    const message = parsed.value;
    if (message.recipient !== pubkey || !lobbies) return;

    // Checked here rather than at the subscription, because only a message this
    // GM would actually act on is worth remembering — and because `since` is a
    // coarse floor that deliberately reaches back over the downtime, so the
    // moves recovered from it arrive alongside ones already applied.
    if (store && (await store.wasHandled(event.id))) return;

    try {
      await route(message, event);
    } finally {
      // Marked whatever happened, including on the paths that decided this
      // message was not for us. Re-deciding that after a restart is work with a
      // known answer, and the row is small.
      //
      // A second transaction, deliberately: it is an optimisation, not the
      // guarantee. The guarantee is `cause`, written in the *same* transaction
      // as the effect it caused, so a crash between the effect and this line
      // leaves a message that will be reconsidered and a durable write that
      // will not be repeated.
      await store?.markHandled(event.id, event.created_at);
    }
  }

  /** The router proper. Split from `handle` so the bookkeeping around it is in one place. */
  async function route(message: GameMessage, event: NostrEvent): Promise<void> {
    if (!lobbies) return;

    switch (message.action) {
      case 'create': {
        // The announcement's `d` tag is the game module id.
        const module = modules.get(message.announcement.identifier);
        if (!module) return;

        const decision = mayCreate(policy, event.pubkey, runners.size);
        if (!decision.ok) {
          // Reported rather than ignored: a client that never hears back cannot
          // tell "refused" from "GM offline", and will retry forever.
          await publish(
            buildResponse(event.id, event.pubkey, {
              status: 'rejected',
              reason: decision.reason,
            }),
          );
          return;
        }

        // NIP-44'd to us, because it may carry a join code. `readSecretBody`
        // also accepts a plaintext body — see the note in that file.
        const create = parseCreateRequest(
          await readSecretBody(decrypt, event.pubkey, message.content),
        );
        if (!create.ok) {
          // Reported, not silently defaulted. The body carries the lobby's
          // start condition and visibility, so quietly falling back would hand
          // the creator a lobby that behaves differently from the one they
          // asked for — and they would only find out when it failed to start.
          await publish(
            buildResponse(event.id, event.pubkey, {
              status: 'rejected',
              reason: `bad_create_request:${create.error}`,
            }),
          );
          return;
        }

        await lobbies.create(module, event.pubkey, create.value, event);
        return;
      }

      case 'join':
      case 'leave':
      case 'ready': {
        const managed = lobbies.get(message.lobby.identifier);
        const module = managed && modules.get(managed.module);
        if (!module) return;
        await lobbies.handle(message, event, module);
        return;
      }

      case 'move': {
        await runners.get(message.gameId)?.handleMove(event);
        return;
      }

      // `presence` is advisory; `response` is our own traffic coming back.
      default:
        return;
    }
  }

  return {
    get pubkey(): Hex {
      if (!pubkey) throw new Error('GM has not been started');
      return pubkey;
    },

    get games(): ReadonlyMap<Hex, GameRunner> {
      return runners;
    },

    get lobbies(): LobbyManager {
      // Guarded like `pubkey`: the manager is built by `start()`, and reaching
      // for it before then is a caller with its ordering wrong, not a caller
      // that wants an empty one.
      if (!lobbies) throw new Error('GM has not been started');
      return lobbies;
    },

    /**
     * Come up, and if there is a store, come *back* up.
     *
     * The order below is the whole of the resume design and none of it is
     * incidental:
     *
     *  1. Open the store first, because everything after it needs what it holds
     *     and because a store belonging to another GM has to fail here rather
     *     than four rounds into somebody's game.
     *  2. Build the publisher, seeded with the watermarks, before anything is
     *     published. The guard those carry runs *ahead* of the wall clock during
     *     a burst, so a GM that restarts inside that window and stamps from
     *     `clock.now()` publishes a lobby the relay silently drops.
     *  3. Flush the outbox before anything else goes out, so a delta signed but
     *     not sent lands before the round after it.
     *  4. Restore lobbies, then games, then the moves that arrived while down.
     *  5. Announce and subscribe last: the inbox is the door, and it opens once
     *     the daemon can actually answer what comes through it.
     */
    async start(): Promise<void> {
      if (pubkey) return;
      pubkey = await signer.getPublicKey();

      const persisted = await store?.open(pubkey);
      publish = createPublisher({
        transport,
        signer,
        clock,
        pubkey: () => pubkey as Hex,
        ...(persisted ? { watermarks: persisted.watermarks } : {}),
        ...(store ? { onStamp: (coordinate, at) => store.stamp(coordinate, at) } : {}),
      });

      lobbies = buildLobbyManager(pubkey);

      if (store && persisted) {
        await flushOutbox(store);
        await lobbies.restore(
          persisted.lobbies.map((stored) => fromStoredLobby(stored, pubkey as Hex)),
          (id) => modules.get(id),
        );
        for (const game of persisted.games) await resumeGame(store, pubkey, game);
      }

      // One announcement per module, addressable on `d` = module id, so clients
      // can browse a directory even when this GM is not answering discovery.
      for (const module of modules.values()) {
        await publish(
          buildAnnouncement({
            game: module.id,
            version: module.version,
            rulesHash: module.rulesHash,
            relays,
            modes: [defaults.mode],
            config: {
              name: module.id,
              capabilities: ['simultaneous', 'hidden-moves', 'commit-reveal'],
              maxConcurrentGames: policy.maxConcurrentGames,
            },
          }),
        );
      }

      // See `GMOptions.inboxSince`. `?? clock.now()` rather than `?? undefined`:
      // an unbounded inbox is not a neutral default, it is a replay of the
      // GM's entire history on every start. A store widens the window back to
      // the oldest open round, because the moves made while the daemon was down
      // are older than the daemon is — and `handle()` drops anything already
      // acted on, so the extra reach costs nothing but the reading.
      const since = options.inboxSince ?? persisted?.inboxSince ?? clock.now();

      subscriptions.push(
        transport.subscribe([inboxFilter(pubkey, since)], {
          onEvent: (event) => enqueue(() => handle(event)),
        }),
      );

      // Queued like everything else, so an offer's capacity is read after the
      // messages that arrived before the request, not in the middle of one.
      subscriptions.push(
        transport.subscribe([discoveryFilter()], {
          onEvent: (event) => enqueue(() => answerDiscovery(event)),
        }),
      );
    },

    async drain(): Promise<void> {
      // Twice: work handled by the first await may itself enqueue more, which is
      // the normal case — a `final` revision closes a round, which publishes a
      // delta, which opens the next.
      await queue;
      await queue;
    },

    async stop(): Promise<void> {
      for (const sub of subscriptions) sub.close();
      subscriptions.length = 0;
      for (const runner of runners.values()) runner.stop();
      runners.clear();
      await queue;
    },
  };
}
