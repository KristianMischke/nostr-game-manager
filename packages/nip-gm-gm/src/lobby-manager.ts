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
  parseJoinRequest,
  KIND,
  type AddressPointer,
  type Clock,
  type CreateRequest,
  type GameModule,
  type Hex,
  type Lobby,
  type LobbyConfig,
  type LobbyMessage,
  type NostrEvent,
  type PersistenceMode,
  type SeedCommitment,
} from 'nip-gm-core';
import type { Publisher } from './publisher.js';
import { readSecretBody, type Decrypt } from './secret-body.js';

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
  /**
   * The join code, when the creator set one. **GM-side only.**
   *
   * Deliberately here and not on `lobby`: everything in `lobby` is published,
   * and NIP-GM §Behaviors is explicit that the code never appears in the lobby
   * event. It arrives NIP-44'd inside the create body, is held in memory, and is
   * compared against what each joiner sends — it is never written anywhere a
   * relay can see. That also means it does not survive a restart, which is the
   * same trade the rest of this map makes.
   */
  code?: string;
}

export interface LobbyManagerOptions {
  /**
   * Signs and publishes, stamping addressable events with a strictly increasing
   * `created_at`. That guard is load-bearing here: the lobby is rewritten on
   * every join and ready, several times within one second, and a relay drops a
   * rewrite whose `created_at` has not advanced. See `publisher.ts`.
   */
  publish: Publisher;
  gmPubkey: Hex;
  clock: Clock;
  defaults: LobbyDefaults;
  /**
   * Opens a NIP-44 body addressed to this GM — the join code's envelope.
   *
   * Injected rather than taken as a signer so this file keeps needing nothing
   * but a publisher and a clock, and so a test can gate a lobby without keys.
   */
  decrypt: Decrypt;
  /** Called once a lobby's start conditions are met and the start event is published. */
  onStart(lobby: ManagedLobby, start: NostrEvent): Promise<void>;
}

export interface LobbyManager {
  create(
    module: GameModule<unknown, unknown, unknown, unknown>,
    requester: Hex,
    /**
     * The creator's parsed create body. Its `visibility` / `join` / `start`
     * fields are honoured here; a GM wanting to constrain them should reject
     * the request rather than silently substitute, so the creator never gets a
     * lobby that behaves differently from the one they asked for.
     */
    create: CreateRequest,
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
  const { publish, gmPubkey, clock } = options;
  const lobbies = new Map<string, ManagedLobby>();

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

    // Parsed for validation only — the *raw* config is what gets published
    // below. A lobby whose config the module rejects can never start; close it
    // rather than leaving players waiting on a game that will not come.
    try {
      module.parseConfig(managed.lobby.config.config);
    } catch {
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
            // The raw lobby config, NOT `parseConfig`'s output. Every auditor
            // and every joining client runs `parseConfig` on this field, so it
            // has to be parser *input*. Publishing the parsed value would also
            // silently require a module's Config to survive a JSON round trip,
            // which nothing states and which a Config holding Maps or class
            // instances does not — it stringifies to `{}` and every auditor
            // then rebuilds a different game than the one that was played.
            config: managed.lobby.config.config,
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

  /**
   * What is left of a lobby after someone leaves.
   *
   * Two things splicing the roster does not do on its own.
   *
   * The leader is a pubkey held *outside* the player list, so a leader who
   * leaves leaves it pointing at somebody who is not here. Nothing rejects that
   * lobby — `parseLobby` only checks the tag is present — so clients keep
   * listing it as joinable while `maybeStart` matches every start intent
   * against a pubkey that will never send one. The lobby stays open forever and
   * can never begin. Seat order picks the successor, for the same reason it
   * decides everything else here.
   *
   * And a lobby everybody has left is not a lobby. Nothing else would ever
   * close it: there is no reaper, and an addressable event lives on the relay
   * until it is replaced, so an abandoned lobby would sit there advertising a
   * game with nobody in it.
   */
  const settleDeparture = (managed: ManagedLobby): void => {
    const { players, leader, status } = managed.lobby;

    if (players.length === 0) {
      // Only an open lobby closes here. Once a game is running its lobby event
      // is the record of where that game came from, and a player walking out is
      // a forfeit for the runner to materialize — not a reason to rewrite
      // history.
      if (status === 'open') managed.lobby = { ...managed.lobby, status: 'closed' };
      return;
    }

    if (leader && !players.some((p) => p.pubkey === leader)) {
      managed.lobby = { ...managed.lobby, leader: players[0].pubkey };
    }
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
    async create(module, requester, create, request): Promise<ManagedLobby> {
      const { config } = create;
      const start = create.start ?? { kind: 'ready' };
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
        // Honoured whatever the visibility. A code on a public lobby is a
        // listed room that still asks at the door — unusual, but the creator
        // asked for it, and refusing would be the GM quietly handing back a
        // lobby that behaves differently from the one requested.
        code: create.code,
        lobby: {
          lobbyId: identifier,
          game: module.id,
          version: module.version,
          visibility: create.visibility ?? 'public',
          join: create.join ?? 'before',
          start,
          // The creator leads by definition: they are the only participant that
          // exists when the lobby opens. A `leader` lobby with no leader can
          // never start, and `parseLobby` rejects one outright.
          leader: start.kind === 'leader' ? requester : undefined,
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

          if (managed.code !== undefined) {
            const body = parseJoinRequest(
              await readSecretBody(options.decrypt, event.pubkey, message.content),
            );
            // A body that will not parse is refused as a wrong code rather than
            // ignored: the joiner is waiting on an answer either way, and there
            // is no reading of an unparseable join that should seat someone.
            if (!body.ok || body.value.code === undefined) {
              // Two reasons, not one. A client cannot tell a gated lobby from an
              // open one before it knocks — the code is not in the lobby event —
              // so "you need a code" is the prompt to ask the player for one,
              // while "that code is wrong" is the prompt to say they got it
              // wrong. Collapsing them would make the first attempt at every
              // private lobby look like a failure.
              await respond(event, { status: 'rejected', reason: 'code_required' }, mode);
              return;
            }
            if (body.value.code !== managed.code) {
              await respond(event, { status: 'rejected', reason: 'bad_code' }, mode);
              return;
            }
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
      if (message.action === 'leave') settleDeparture(managed);
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
