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
  /**
   * Players this lobby will not re-seat. **GM-side only**, like the code.
   *
   * Kicking that only spliced the roster would be theatre: the lobby event is
   * public, `join` is idempotent and open to anyone, and a client that has been
   * removed can simply ask again — most will, automatically, because a roster
   * they are missing from looks to them like a join that failed. So removal has
   * to be remembered, and remembered somewhere the relay cannot see, since a
   * published list of people who were thrown out is a punishment nobody asked
   * the protocol to hand out.
   */
  denied?: Hex[];
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
  /**
   * A number that never repeats, for the lobby identifier.
   *
   * Defaults to a per-manager counter, which is what a GM with no memory can
   * offer. It is not enough on its own: the identifier is an addressable event's
   * `d` tag, so a value reused after a restart does not collide harmlessly — the
   * new lobby *replaces* the old one on the relay and a live game's lobby event
   * disappears. A durable GM passes something monotonic across restarts.
   */
  nextSequence?(): Promise<number>;
  /**
   * Called after every change to a lobby, before it is republished.
   *
   * The seat for durability: it carries the seed, salt and join code, none of
   * which are on any relay, and it runs *before* the publish so that nothing is
   * announced that could not be honoured after a crash.
   */
  onChange?(lobby: ManagedLobby, cause?: Hex): Promise<void>;
  /**
   * Called with the signed start event, before it is sent.
   *
   * Where the game becomes real. Everything about it — the first snapshot, the
   * start event itself, the lobby's move to `active` — has to be one durable act
   * committed here, because the moment after this returns the event is on a
   * relay and cannot be taken back. See the second rule in `store.ts`.
   */
  onBeginGame?(lobby: ManagedLobby, start: NostrEvent): Promise<void>;
  /** Called once a prepared event has reached the relay. */
  onSent?(eventId: Hex): Promise<void>;
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
  /**
   * Remove a player, and by default refuse to seat them again.
   *
   * An operator action, not a protocol message: there is no `kick` a player can
   * send, and no NIP-GM event for one. It exists because a GM running inside
   * somebody's client has a person sitting behind it who can see who walked in,
   * which a daemon does not. Nothing is sent to the person removed — the
   * republished lobby is the notification, the same way every other membership
   * change is.
   *
   * `ban: false` removes without remembering, for the case where somebody
   * should be able to come back.
   */
  kick(identifier: string, pubkey: Hex, options?: { ban?: boolean }): Promise<void>;
  /**
   * Change, set or clear the join code.
   *
   * No republish: the code has never been part of the lobby event, so nothing
   * a relay holds changes. It gates the *next* join and leaves everyone already
   * seated exactly where they are — rotating a code is how a host stops the
   * link they posted somewhere from working, not how they clear the room.
   */
  setCode(identifier: string, code: string | undefined): Promise<void>;
  /**
   * Reinstate lobbies from a previous process.
   *
   * Nothing is republished: an addressable event is still on the relay saying
   * exactly what these say, and a rewrite that changes nothing is noise. What
   * this does do is re-check the start conditions, because a lobby whose last
   * player readied up moments before the crash is otherwise waiting on a message
   * that will never come — everyone in it already said everything they had to.
   */
  restore(
    lobbies: readonly ManagedLobby[],
    moduleFor: (id: string) => GameModule<unknown, unknown, unknown, unknown> | undefined,
  ): Promise<void>;
}

export function createLobbyManager(options: LobbyManagerOptions): LobbyManager {
  const { publish, gmPubkey, clock } = options;
  const lobbies = new Map<string, ManagedLobby>();

  // Per-manager rather than per-module, so that two GMs in one process (which
  // only tests do) cannot hand each other the same identifier.
  let counter = 0;
  const nextSequence = options.nextSequence ?? (() => Promise.resolve(counter++));

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

    // In memory only, and deliberately not persisted: a crash here must leave the
    // lobby exactly as open as it was, so that the restored GM re-runs this and
    // signs a *fresh* start event — against the same durable seed, so the
    // commitment it publishes is the one it can still reveal.
    managed.lobby = { ...managed.lobby, status: 'starting' };

    const start = await publish.prepare(
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

    // Durable, then sent. The other order publishes a game whose seed a restart
    // might not be able to find, and a game whose seed is gone cannot be ended.
    await options.onBeginGame?.(managed, start);
    await publish.send(start);
    await options.onSent?.(start.id);

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
      const identifier = `${module.id}-${clock.now()}-${await nextSequence()}`;
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
      // Before the lobby event exists, let alone the start event that publishes
      // this commitment: the seed has to be findable by whoever has to reveal it.
      await options.onChange?.(managed, request.id);
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
          // Before the idempotency check, deliberately: someone removed from
          // the roster is no longer in `players`, so every re-join reads as a
          // first one.
          if (managed.denied?.includes(event.pubkey)) {
            await respond(event, { status: 'rejected', reason: 'kicked' }, mode);
            return;
          }
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
      if (managed.lobby.status === 'closed') lobbies.delete(managed.lobby.lobbyId);
      await options.onChange?.(managed, event.id);
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

    async kick(identifier, pubkey, kickOptions): Promise<void> {
      const managed = lobbies.get(identifier);
      if (!managed) return;

      const players = managed.lobby.players.filter((p) => p.pubkey !== pubkey);
      const removed = players.length !== managed.lobby.players.length;
      const ban = kickOptions?.ban ?? true;
      // Remembered even when they were not seated, so a host can shut out
      // somebody who keeps knocking rather than only somebody already in.
      const denied =
        ban && !managed.denied?.includes(pubkey) ? [...(managed.denied ?? []), pubkey] : managed.denied;
      if (!removed && denied === managed.denied) return;

      managed.lobby = { ...managed.lobby, players };
      managed.denied = denied;
      // The same succession and close-if-empty rules a `leave` gets. Kicking
      // the leader has to hand the lead on, or the lobby is one nobody can
      // start; kicking the last player closes it, or it lingers in the list
      // advertising a room with nobody in it.
      settleDeparture(managed);
      if (managed.lobby.status === 'closed') lobbies.delete(managed.lobby.lobbyId);
      await options.onChange?.(managed);
      await republish(managed);
    },

    async setCode(identifier, code): Promise<void> {
      const managed = lobbies.get(identifier);
      if (!managed) return;
      managed.code = code;
      // `onChange` but no `republish`: this is durable state that was never on
      // a relay, so there is nothing published to correct.
      await options.onChange?.(managed);
    },

    get all(): readonly ManagedLobby[] {
      return [...lobbies.values()];
    },

    async restore(restored, moduleFor): Promise<void> {
      for (const managed of restored) lobbies.set(managed.lobby.lobbyId, managed);

      for (const managed of restored) {
        const module = moduleFor(managed.module);
        // A lobby for a module this GM no longer hosts is left in the map rather
        // than dropped: it can never start, but its seed is still the one behind
        // a commitment somebody may hold, and silently forgetting it is how a
        // config change becomes an unauditable game.
        if (!module) continue;
        // `false` for leader intent: a leader's "start now" is an instruction,
        // not a standing condition, and re-inferring one from a restored roster
        // would start a game its leader never asked twice for.
        await maybeStart(managed, module, false);
      }
    },
  };
}
