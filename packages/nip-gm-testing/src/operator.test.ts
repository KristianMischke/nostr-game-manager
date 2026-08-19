/**
 * The two things a GM's operator can do that no player can ask for.
 *
 * `kick` and `setCode` are not protocol messages — there is no NIP-GM event for
 * either, and no player action that reaches them. They exist because a GM
 * embedded in a client has a person behind it who can see who walked into their
 * lobby, which a daemon does not. The GM is already the sole writer of lobby
 * membership, so both are direct edits followed by the same republish every
 * other membership change gets.
 *
 * What is worth testing is not that the roster shrank — that part is a filter —
 * but the four ways a naive version gets it wrong: a kicked player walking
 * straight back in, a lobby left with a leader who is not in it, an empty lobby
 * still advertising itself, and a rotated code that locked out the people
 * already sitting down.
 */
import { describe, expect, it } from 'vitest';
import { KIND, parseLobby, type Lobby, type NostrEvent } from 'nip-gm-core';
import { createGM } from 'nip-gm-gm';
import { createLobbySession } from 'nip-gm-client';
import { createManualClock } from './clock.js';
import { createMemoryRelay, type MemoryRelay } from './memory-transport.js';
import { createMemoryStore } from './memory-store.js';
import { signerFromSeed, type MemorySigner } from './memory-signer.js';
import { ordersModule } from './example/orders.js';

const CONFIG = { boardSize: 12, maxRounds: 3 };

interface Table {
  relay: MemoryRelay;
  clock: ReturnType<typeof createManualClock>;
  gm: ReturnType<typeof createGM>;
  gmSigner: MemorySigner;
  players: MemorySigner[];
  store: ReturnType<typeof createMemoryStore>;
}

async function seat(playerCount: number): Promise<Table> {
  const relay = createMemoryRelay();
  const clock = createManualClock();
  const gmSigner = signerFromSeed(1);
  const store = createMemoryStore();
  const players = Array.from({ length: playerCount }, (_, i) => signerFromSeed(i + 2));

  const gm = createGM({
    modules: [ordersModule],
    signer: gmSigner,
    transport: relay,
    clock,
    store,
    policy: { allowCreate: 'anyone' },
    lobbyDefaults: { turnTimeout: 0, snapshotInterval: 0 },
  });
  await gm.start();

  return { relay, clock, gm, gmSigner, players, store };
}

function sessionFor(table: Table, player: MemorySigner) {
  return createLobbySession({
    transport: table.relay,
    signer: player,
    gm: table.gmSigner.pubkey,
    clock: table.clock,
  });
}

/** The lobby as the relay currently holds it — what every other client sees. */
function published(relay: MemoryRelay, identifier: string): Lobby | undefined {
  const events = relay.stored([{ kinds: [KIND.LOBBY] }]) as NostrEvent[];
  // Insertion order rather than `created_at`: the relay hands these back in the
  // order they were published, and on a manual clock several rewrites share a
  // second, so sorting by timestamp picks an arbitrary one of them.
  const newest = events
    .filter((event) => event.tags.some((tag) => tag[0] === 'd' && tag[1] === identifier))
    .pop();
  if (!newest) return undefined;
  const parsed = parseLobby(newest);
  return parsed.ok ? parsed.value : undefined;
}

/**
 * Move the clock on before a client repeats itself.
 *
 * A second `join` from the same player, with the same tags and the same
 * `created_at`, serializes to the same bytes and therefore the same event id —
 * and the GM's store, correctly, treats an id it has already handled as a
 * message it has already answered. On a real clock a retry seconds later is a
 * different event; on a manual one it is only different if the test says so.
 */
function retryLater(table: Table): void {
  table.clock.advance(1);
}

describe('kick', () => {
  it('removes the player and refuses to seat them again', async () => {
    const table = await seat(3);
    const [host, guest, other] = table.players;

    const hostLobby = sessionFor(table, host);
    const address = await hostLobby.create(ordersModule.id, CONFIG);
    await table.gm.drain();

    const guestLobby = sessionFor(table, guest);
    await guestLobby.watch(address);
    await guestLobby.join();
    await table.gm.drain();

    const otherLobby = sessionFor(table, other);
    await otherLobby.watch(address);
    await otherLobby.join();
    await table.gm.drain();

    expect(published(table.relay, address.identifier)?.players).toHaveLength(3);

    await table.gm.lobbies.kick(address.identifier, guest.pubkey);

    const roster = published(table.relay, address.identifier)?.players ?? [];
    expect(roster.map((p) => p.pubkey)).toEqual([host.pubkey, other.pubkey]);

    // The part that matters. `join` is idempotent and open to anyone, and a
    // client that finds itself missing from the roster will retry — most
    // automatically. Without the denial this is just a slow removal.
    retryLater(table);
    await guestLobby.join();
    await table.gm.drain();
    expect(guestLobby.getSnapshot().error?.message).toBe('kicked');
    expect(published(table.relay, address.identifier)?.players).toHaveLength(2);

    hostLobby.close();
    guestLobby.close();
    otherLobby.close();
  });

  it('lets them back in when the removal was not a ban', async () => {
    const table = await seat(2);
    const [host, guest] = table.players;

    const hostLobby = sessionFor(table, host);
    const address = await hostLobby.create(ordersModule.id, CONFIG);
    await table.gm.drain();

    const guestLobby = sessionFor(table, guest);
    await guestLobby.watch(address);
    await guestLobby.join();
    await table.gm.drain();

    await table.gm.lobbies.kick(address.identifier, guest.pubkey, { ban: false });
    expect(published(table.relay, address.identifier)?.players).toHaveLength(1);

    retryLater(table);
    await guestLobby.join();
    await table.gm.drain();
    expect(published(table.relay, address.identifier)?.players).toHaveLength(2);

    hostLobby.close();
    guestLobby.close();
  });

  it('hands the lead on when the leader is the one removed', async () => {
    const table = await seat(2);
    const [host, guest] = table.players;

    const hostLobby = sessionFor(table, host);
    const address = await hostLobby.create(ordersModule.id, CONFIG, { start: { kind: 'leader' } });
    await table.gm.drain();

    const guestLobby = sessionFor(table, guest);
    await guestLobby.watch(address);
    await guestLobby.join();
    await table.gm.drain();

    expect(published(table.relay, address.identifier)?.leader).toBe(host.pubkey);

    // Otherwise the lobby survives with a leader who is not in it, and only the
    // leader's intent starts the game — a room nobody can ever start.
    await table.gm.lobbies.kick(address.identifier, host.pubkey);
    expect(published(table.relay, address.identifier)?.leader).toBe(guest.pubkey);

    hostLobby.close();
    guestLobby.close();
  });

  it('closes an open lobby whose last player is removed', async () => {
    const table = await seat(1);
    const [host] = table.players;

    const hostLobby = sessionFor(table, host);
    const address = await hostLobby.create(ordersModule.id, CONFIG);
    await table.gm.drain();

    await table.gm.lobbies.kick(address.identifier, host.pubkey);

    expect(published(table.relay, address.identifier)?.status).toBe('closed');
    expect(table.gm.lobbies.get(address.identifier)).toBeUndefined();

    hostLobby.close();
  });

  it('is remembered across a restart', async () => {
    const table = await seat(2);
    const [host, guest] = table.players;

    const hostLobby = sessionFor(table, host);
    const address = await hostLobby.create(ordersModule.id, CONFIG);
    await table.gm.drain();

    const guestLobby = sessionFor(table, guest);
    await guestLobby.watch(address);
    await guestLobby.join();
    await table.gm.drain();

    await table.gm.lobbies.kick(address.identifier, guest.pubkey);
    await table.gm.stop();

    // A kick a restart forgot would quietly re-open the door, and the person
    // who was removed is exactly the one still retrying.
    const resumed = createGM({
      modules: [ordersModule],
      signer: table.gmSigner,
      transport: table.relay,
      clock: table.clock,
      store: table.store,
      policy: { allowCreate: 'anyone' },
      lobbyDefaults: { turnTimeout: 0, snapshotInterval: 0 },
    });
    await resumed.start();

    retryLater(table);
    await guestLobby.join();
    await resumed.drain();
    expect(guestLobby.getSnapshot().error?.message).toBe('kicked');
    expect(published(table.relay, address.identifier)?.players).toHaveLength(1);

    await resumed.stop();
    hostLobby.close();
    guestLobby.close();
  });
});

describe('setCode', () => {
  it('gates the next join without disturbing the people already seated', async () => {
    const table = await seat(3);
    const [host, guest, latecomer] = table.players;

    const hostLobby = sessionFor(table, host);
    const address = await hostLobby.create(ordersModule.id, CONFIG, { code: 'first' });
    await table.gm.drain();

    const guestLobby = sessionFor(table, guest);
    await guestLobby.watch(address);
    await guestLobby.join({ code: 'first' });
    await table.gm.drain();
    expect(published(table.relay, address.identifier)?.players).toHaveLength(2);

    await table.gm.lobbies.setCode(address.identifier, 'second');

    // Rotating a code is how a host stops a link they posted somewhere from
    // working. It is not how they clear the room, and a version that evicted
    // everyone would be a much worse button than it looks.
    expect(published(table.relay, address.identifier)?.players).toHaveLength(2);

    const lateLobby = sessionFor(table, latecomer);
    await lateLobby.watch(address);
    await lateLobby.join({ code: 'first' });
    await table.gm.drain();
    expect(lateLobby.getSnapshot().error?.message).toBe('bad_code');

    await lateLobby.join({ code: 'second' });
    await table.gm.drain();
    expect(published(table.relay, address.identifier)?.players).toHaveLength(3);

    hostLobby.close();
    guestLobby.close();
    lateLobby.close();
  });

  it('never puts the code on a relay', async () => {
    const table = await seat(1);
    const [host] = table.players;

    const hostLobby = sessionFor(table, host);
    const address = await hostLobby.create(ordersModule.id, CONFIG, { code: 'first' });
    await table.gm.drain();
    await table.gm.lobbies.setCode(address.identifier, 'second');

    // The whole point of a join code is that it is not in the lobby event, and
    // a rotation that republished would be the one write that leaked it.
    const everything = JSON.stringify(table.relay.stored([{ kinds: [KIND.LOBBY] }]));
    expect(everything).not.toContain('second');

    hostLobby.close();
  });
});
