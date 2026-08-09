/**
 * Getting into a game: create, join, ready, start.
 *
 * The lobby is a single addressable event the GM republishes on every membership
 * change (NIP-GM §Lobby), so a client watching one address always sees current
 * membership and never has to replay joins. That is the whole design — this
 * session is a thin store over that one event plus the four messages a player
 * can send at it.
 *
 * Player order in the lobby's `p` tags becomes **seat order** in the start
 * event, so it is preserved verbatim here and must never be sorted.
 */
import {
  buildCreate,
  buildLobbyAction,
  formatAddress,
  KIND,
  lobbyFilter,
  parseLobby,
  parseMessage,
  parseResponseBody,
  myResponsesFilter,
  systemClock,
  verifyEvent,
  type AddressPointer,
  type Clock,
  type Hex,
  type Lobby,
  type NostrEvent,
  type PersistenceMode,
  type Signer,
  type Subscription,
  type Transport,
} from 'nip-gm-core';
import { createStore, type ReadableStore } from '../store.js';
import type { ProtocolError } from '../snapshot.js';

export interface LobbySnapshot {
  /** Null until the GM has published (or republished) the lobby. */
  lobby: Lobby | null;
  address: AddressPointer | null;
  /** Set once the lobby reports a started game — hand this to `createGameSession`. */
  gameId: Hex | null;
  error: ProtocolError | null;
}

export interface LobbySessionOptions {
  transport: Transport;
  signer: Signer;
  gm: Hex;
  mode?: PersistenceMode;
  clock?: Clock;
}

export interface LobbySession extends ReadableStore<LobbySnapshot> {
  /**
   * Ask the GM to open a lobby for a game module, and watch whatever it opens.
   *
   * Resolves when the GM's response arrives, not when the request is published:
   * lobby creation is the GM's decision (NIP-GM §Game Messages — GM policy) and
   * a client that assumed success would show a lobby that does not exist.
   */
  create(game: string, config?: unknown): Promise<AddressPointer>;
  /** Watch an existing lobby by address. */
  watch(address: AddressPointer): Promise<void>;
  join(): Promise<void>;
  ready(options?: { start?: boolean }): Promise<void>;
  leave(): Promise<void>;
  close(): void;
}

export function createLobbySession(options: LobbySessionOptions): LobbySession {
  const { transport, signer, gm } = options;
  const mode = options.mode ?? 'verified';
  const clock = options.clock ?? systemClock;

  const store = createStore<LobbySnapshot>({
    lobby: null,
    address: null,
    gameId: null,
    error: null,
  });
  const subscriptions: Subscription[] = [];
  let watching: AddressPointer | null = null;
  let me: Hex | undefined;

  /** Pending create requests, keyed by the message id the GM answers. */
  const awaitingResponse = new Map<
    Hex,
    { resolve(address: AddressPointer): void; reject(error: Error): void }
  >();

  const sign = async (template: {
    kind: number;
    tags: string[][];
    content: string;
  }): Promise<NostrEvent> => {
    me ??= await signer.getPublicKey();
    return signer.signEvent({ ...template, pubkey: me, created_at: clock.now() });
  };

  const publish = async (template: {
    kind: number;
    tags: string[][];
    content: string;
  }): Promise<NostrEvent> => {
    const event = await sign(template);
    await transport.publish(event);
    return event;
  };

  const onLobby = (event: NostrEvent): void => {
    if (event.pubkey !== gm || !verifyEvent(event)) return;
    const parsed = parseLobby(event);
    if (!parsed.ok) {
      store.set({ ...store.getSnapshot(), error: { code: 'bad_lobby', message: parsed.error } });
      return;
    }
    store.set({
      ...store.getSnapshot(),
      lobby: parsed.value,
      gameId: parsed.value.gameId ?? null,
    });
  };

  const onResponse = (event: NostrEvent): void => {
    if (event.pubkey !== gm) return;
    const parsed = parseMessage(event);
    if (!parsed.ok || parsed.value.action !== 'response') return;

    const waiter = awaitingResponse.get(parsed.value.target);
    const body = parseResponseBody(parsed.value.content);

    if (!body.ok) {
      waiter?.reject(new Error(`GM response did not parse: ${body.error}`));
      awaitingResponse.delete(parsed.value.target);
      return;
    }

    if (body.value.status === 'rejected') {
      store.set({
        ...store.getSnapshot(),
        error: { code: 'rejected', message: body.value.reason, moveId: parsed.value.target },
      });
      waiter?.reject(new Error(body.value.reason));
      awaitingResponse.delete(parsed.value.target);
      return;
    }

    if (body.value.status === 'accepted' && waiter && body.value.lobby) {
      const [kind, pubkey, identifier] = body.value.lobby.split(':');
      waiter.resolve({ kind: Number(kind), pubkey, identifier });
      awaitingResponse.delete(parsed.value.target);
    }
  };

  const requireAddress = (): AddressPointer => {
    if (!watching) throw new Error('no lobby is being watched; call create() or watch() first');
    return watching;
  };

  const ensureResponseSub = async (): Promise<void> => {
    if (subscriptions.length > 0) return;
    me ??= await signer.getPublicKey();
    subscriptions.push(transport.subscribe([myResponsesFilter(me, gm)], { onEvent: onResponse }));
  };

  const watch = async (address: AddressPointer): Promise<void> => {
    await ensureResponseSub();
    watching = address;
    store.set({ ...store.getSnapshot(), address });

    for (const event of await transport.query([lobbyFilter(address)])) onLobby(event);
    subscriptions.push(transport.subscribe([lobbyFilter(address)], { onEvent: onLobby }));
  };

  const create = async (game: string, config?: unknown): Promise<AddressPointer> => {
    await ensureResponseSub();
    const announcement: AddressPointer = { kind: KIND.GM_ANNOUNCEMENT, pubkey: gm, identifier: game };

    // Registered *before* publishing, not in a `.then` afterwards. The GM may
    // answer the instant the event lands — synchronously, against an in-process
    // relay — and a waiter installed after the fact would miss it and hang.
    const event = await sign(
      buildCreate(announcement, gm, JSON.stringify({ config: config ?? {} }), mode),
    );
    const settled = new Promise<AddressPointer>((resolve, reject) => {
      awaitingResponse.set(event.id, { resolve, reject });
    });
    await transport.publish(event);

    const address = await settled;
    await watch(address);
    return address;
  };

  return {
    getSnapshot: store.getSnapshot,
    subscribe: store.subscribe,
    create,
    watch,

    async join(): Promise<void> {
      await publish(buildLobbyAction('join', requireAddress(), gm, '', { mode }));
    },

    async ready(opts: { start?: boolean } = {}): Promise<void> {
      // `["intent", "start"]` is how a lobby leader says "go" — meaningless from
      // anyone else, and ignored by the GM (NIP-GM §Behaviors — Start condition).
      await publish(
        buildLobbyAction('ready', requireAddress(), gm, '', {
          mode,
          intent: opts.start ? 'start' : undefined,
        }),
      );
    },

    async leave(): Promise<void> {
      await publish(buildLobbyAction('leave', requireAddress(), gm, '', { mode }));
    },

    close(): void {
      for (const sub of subscriptions) sub.close();
      subscriptions.length = 0;
      awaitingResponse.clear();
    },
  };
}

export { formatAddress };
