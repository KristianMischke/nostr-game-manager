/**
 * Lobby lifecycle: create, join, leave, ready, start.
 *
 * The lobby is one addressable event the GM republishes on every membership
 * change, so clients never replay joins — they read the current event. That
 * makes the GM the sole writer of membership, which is what lets the start
 * event's `p` tags be trusted as the roster.
 *
 * **Player order is seat order.** Players are appended in join order and never
 * sorted, here or anywhere downstream: the order of `p` tags in the start event
 * defines seat order, that ordering is covered by the GM's signature, and it is
 * a module input. Sorting the roster for tidiness would silently change every
 * deal and every canonical resolution in the game.
 */
import {
  buildLobby,
  buildResponse,
  buildStart,
  canStart,
  createSeedCommitment,
  formatAddress,
  KIND,
  type AddressPointer,
  type Clock,
  type GameModule,
  type Hex,
  type Lobby,
  type LobbyConfig,
  type LobbyMessage,
  type NostrEvent,
  type PersistenceMode,
  type SeedCommitment,
  type Signer,
  type Transport,
} from 'nip-gm-core';

export interface LobbyDefaults {
  mode: PersistenceMode;
  /** Seconds; 0 means a round never times out, which suits async play. */
  turnTimeout: number;
  /** Replace the head snapshot every N deltas; 0 disables periodic snapshots. */
  snapshotInterval: number;
  spectatorDelay: number;
  relays: string[];
}

export const defaultLobbyDefaults: LobbyDefaults = {
  mode: 'verified',
  turnTimeout: 120,
  snapshotInterval: 10,
  spectatorDelay: 0,
  relays: [],
};

export interface ManagedLobby {
  lobby: Lobby;
  address: AddressPointer;
  /** Sampled at creation, published as a commitment at start, revealed at end. */
  commitment: SeedCommitment;
  openedAt: number;
  module: string;
}

export interface LobbyManagerOptions {
  transport: Transport;
  signer: Signer;
  gmPubkey: Hex;
  clock: Clock;
  defaults: LobbyDefaults;
  /** Called once a lobby's start conditions are met and the start event is published. */
  onStart(lobby: ManagedLobby, start: NostrEvent): Promise<void>;
}

export interface LobbyManager {
  create(
    module: GameModule<unknown, unknown, unknown, unknown>,
    requester: Hex,
    config: unknown,
    request: NostrEvent,
  ): Promise<ManagedLobby>;
  handle(
    message: LobbyMessage,
    event: NostrEvent,
    module: GameModule<unknown, unknown, unknown, unknown>,
  ): Promise<void>;
  get(identifier: string): ManagedLobby | undefined;
  readonly all: readonly ManagedLobby[];
}

let counter = 0;

export function createLobbyManager(options: LobbyManagerOptions): LobbyManager {
  const { transport, signer, gmPubkey, clock } = options;
  const lobbies = new Map<string, ManagedLobby>();

  const publish = async (template: {
    kind: number;
    tags: string[][];
    content: string;
  }): Promise<NostrEvent> => {
    const event = await signer.signEvent({
      ...template,
      pubkey: gmPubkey,
      created_at: clock.now(),
    });
    await transport.publish(event);
    return event;
  };

  const republish = async (managed: ManagedLobby): Promise<void> => {
    await publish(buildLobby(managed.lobby));
  };

  const respond = async (
    request: NostrEvent,
    body: Parameters<typeof buildResponse>[2],
    mode: PersistenceMode,
  ): Promise<void> => {
    await publish(buildResponse(request.id, request.pubkey, body, { mode }));
  };

  /**
   * Publish the start event and hand the game to a runner.
   *
   * The roster is taken from the lobby's `p` tags in document order — see the
   * note at the top of this file.
   */
  const startGame = async (
    managed: ManagedLobby,
    module: GameModule<unknown, unknown, unknown, unknown>,
  ): Promise<void> => {
    const seats = managed.lobby.players.map((p) => p.pubkey);

    let config: unknown;
    try {
      config = module.parseConfig(managed.lobby.config.config);
    } catch {
      // A lobby whose config the module rejects can never start; close it rather
      // than leaving players waiting on a game that will not come.
      managed.lobby = { ...managed.lobby, status: 'closed' };
      await republish(managed);
      return;
    }

    managed.lobby = { ...managed.lobby, status: 'starting' };

    const start = await publish(
      buildStart(
        {
          lobby: managed.address,
          seats,
          game: module.id,
          version: module.version,
          content: {
            rulesHash: module.rulesHash,
            config,
            // Committed before any play, so no outcome can be chosen after
            // seeing the moves.
            seedCommit: managed.commitment.commit,
          },
        },
        // Lifecycle events stay on the regular kind even in casual mode.
        managed.lobby.config.mode,
      ),
    );

    managed.lobby = { ...managed.lobby, status: 'active', gameId: start.id };
    await republish(managed);
    await options.onStart(managed, start);
  };

  const maybeStart = async (
    managed: ManagedLobby,
    module: GameModule<unknown, unknown, unknown, unknown>,
    leaderIntent: boolean,
  ): Promise<void> => {
    if (managed.lobby.status !== 'open') return;

    const ready =
      managed.lobby.start.kind === 'leader'
        ? leaderIntent && managed.lobby.players.length >= managed.lobby.config.minPlayers
        : canStart(managed.lobby, clock.now(), managed.openedAt);

    if (ready) await startGame(managed, module);
  };

  return {
    async create(module, requester, config, request): Promise<ManagedLobby> {
      const identifier = `${module.id}-${clock.now()}-${counter++}`;
      const address: AddressPointer = {
        kind: KIND.LOBBY,
        pubkey: gmPubkey,
        identifier,
      };

      const lobbyConfig: LobbyConfig = {
        name: module.id,
        mode: options.defaults.mode,
        minPlayers: module.minPlayers,
        maxPlayers: module.maxPlayers,
        turnTimeout: options.defaults.turnTimeout,
        snapshotInterval: options.defaults.snapshotInterval,
        spectatorDelay: options.defaults.spectatorDelay,
        config,
      };

      const managed: ManagedLobby = {
        address,
        module: module.id,
        openedAt: clock.now(),
        commitment: createSeedCommitment(),
        lobby: {
          lobbyId: identifier,
          game: module.id,
          version: module.version,
          visibility: 'public',
          join: 'before',
          start: { kind: 'ready' },
          status: 'open',
          // The creator is seated first, so creating a game seats you in it.
          players: [{ pubkey: requester, state: 'joined' }],
          relays: options.defaults.relays,
          config: lobbyConfig,
        },
      };

      lobbies.set(identifier, managed);
      await republish(managed);
      await respond(
        request,
        { status: 'accepted', lobby: formatAddress(address) },
        lobbyConfig.mode,
      );
      return managed;
    },

    async handle(message, event, module): Promise<void> {
      const managed = lobbies.get(message.lobby.identifier);
      if (!managed || message.lobby.pubkey !== gmPubkey) return;

      const mode = managed.lobby.config.mode;
      const players = [...managed.lobby.players];
      const index = players.findIndex((p) => p.pubkey === event.pubkey);

      switch (message.action) {
        case 'join': {
          if (index !== -1) break; // Idempotent: a re-join is not an error.
          if (managed.lobby.status !== 'open') {
            await respond(event, { status: 'rejected', reason: 'lobby_closed' }, mode);
            return;
          }
          if (players.length >= managed.lobby.config.maxPlayers) {
            await respond(event, { status: 'rejected', reason: 'lobby_full' }, mode);
            return;
          }
          // Appended, never inserted or sorted: join order becomes seat order.
          players.push({ pubkey: event.pubkey, state: 'joined' });
          break;
        }

        case 'leave': {
          if (index === -1) return;
          players.splice(index, 1);
          break;
        }

        case 'ready': {
          if (index === -1) {
            await respond(event, { status: 'rejected', reason: 'not_in_lobby' }, mode);
            return;
          }
          players[index] = { ...players[index], state: 'ready' };
          break;
        }
      }

      managed.lobby = { ...managed.lobby, players };
      await republish(managed);
      await respond(event, { status: 'accepted', lobby: formatAddress(managed.address) }, mode);

      const leaderIntent =
        message.action === 'ready' &&
        message.intent === 'start' &&
        managed.lobby.leader === event.pubkey;
      await maybeStart(managed, module, leaderIntent);
    },

    get(identifier: string): ManagedLobby | undefined {
      return lobbies.get(identifier);
    },

    get all(): readonly ManagedLobby[] {
      return [...lobbies.values()];
    },
  };
}
