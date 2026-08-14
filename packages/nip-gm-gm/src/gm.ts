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
  buildAnnouncement,
  buildResponse,
  inboxFilter,
  parseCreateRequest,
  parseMessage,
  systemClock,
  verifyEvent,
  type AnyGameModule,
  type Clock,
  type Hex,
  type KeySigner,
  type NostrEvent,
  type Subscription,
  type Transport,
} from 'nip-gm-core';
import {
  createLobbyManager,
  defaultLobbyDefaults,
  type LobbyDefaults,
  type LobbyManager,
} from './lobby-manager.js';
import { mayCreate, type GMPolicy } from './policy.js';
import { createRunner, type GameRunner } from './runner.js';

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
}

export interface GM {
  start(): Promise<void>;
  stop(): Promise<void>;
  readonly pubkey: Hex;
  /** Live games by id — for tests and for an operator's status endpoint. */
  readonly games: ReadonlyMap<Hex, GameRunner>;
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

  const publish = async (template: {
    kind: number;
    tags: string[][];
    content: string;
  }): Promise<NostrEvent> => {
    const event = await signer.signEvent({
      ...template,
      pubkey: pubkey as Hex,
      created_at: clock.now(),
    });
    await transport.publish(event);
    return event;
  };

  const buildLobbyManager = (gmPubkey: Hex): LobbyManager =>
    createLobbyManager({
      transport,
      signer,
      gmPubkey,
      clock,
      defaults,
      async onStart(managed, start) {
        const module = modules.get(managed.module);
        if (!module) return;

        const runner = createRunner({
          module,
          transport,
          signer,
          clock,
          gmPubkey,
          start,
          // Seat order, verbatim from the lobby roster.
          seats: managed.lobby.players.map((p) => p.pubkey),
          config: module.parseConfig(managed.lobby.config.config),
          commitment: managed.commitment,
          lobby: managed.lobby.config,
          onEnd: (gameId) => runners.delete(gameId),
        });

        runners.set(start.id, runner);
        await runner.open();
      },
    });

  async function handle(event: NostrEvent): Promise<void> {
    if (!verifyEvent(event)) return;
    if (event.pubkey === pubkey) return; // Our own responses come back to us.

    const parsed = parseMessage(event);
    if (!parsed.ok) return;
    const message = parsed.value;
    if (message.recipient !== pubkey || !lobbies) return;

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

        const create = parseCreateRequest(message.content);
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

    async start(): Promise<void> {
      if (pubkey) return;
      pubkey = await signer.getPublicKey();
      lobbies = buildLobbyManager(pubkey);

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

      subscriptions.push(
        transport.subscribe([inboxFilter(pubkey)], {
          onEvent: (event) => enqueue(() => handle(event)),
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
