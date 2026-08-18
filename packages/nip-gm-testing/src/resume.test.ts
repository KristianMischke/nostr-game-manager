/**
 * Killing a GM mid-game and starting another one over its notes.
 *
 * The claim under test is narrow and total: a daemon that stops at any instant
 * and comes back leaves a log indistinguishable from one that never stopped.
 * `auditGame` is what decides that, and it is worth being clear about why it is
 * the right judge here. It knows nothing about daemons, restarts or stores. It
 * takes the events off the relay, checks the revealed seed against the
 * commitment published before the crash, decrypts every cited move with the keys
 * the deltas reveal, and re-runs the module. A resumed engine that drifted by a
 * single RNG draw fails it. A resumed GM that lost its seed cannot even produce
 * the reveal. A GM that published two deltas at one `seq` breaks the chain.
 *
 * ## `stop()` is a faithful crash
 *
 * Nothing is written to the store on the way down — `stop()` closes
 * subscriptions, cancels timers and clears its maps, and that is all. So the
 * store a graceful stop leaves behind is byte for byte the store a `SIGKILL`
 * would have left, and the tests below can use the tidy one. That property is
 * asserted directly in "writes nothing on the way down", because if it ever
 * stops being true every other test here quietly becomes weaker than it looks.
 */
import { describe, expect, it } from 'vitest';
import {
  auditGame,
  KIND,
  parseLobby,
  parseState,
  type Filter,
  type NostrEvent,
  type SubscribeHandlers,
  type Transport,
} from 'nip-gm-core';
import { createGM } from 'nip-gm-gm';
import { createGameSession, createLobbySession } from 'nip-gm-client';
import { createManualClock, type ManualClock } from './clock.js';
import { createMemoryRelay, type MemoryRelay } from './memory-transport.js';
import { createMemoryStore, type MemoryStore } from './memory-store.js';
import { signerFromSeed, type MemorySigner } from './memory-signer.js';
import { ordersModule, type OrdersMove, type OrdersView } from './example/orders.js';

const CONFIG = { boardSize: 12, maxRounds: 6 };

interface Table {
  relay: MemoryRelay;
  transport: Transport;
  clock: ManualClock;
  store: MemoryStore;
  gm: ReturnType<typeof createGM>;
  gmSigner: MemorySigner;
  players: MemorySigner[];
}

interface Options {
  turnTimeout?: number;
  snapshotInterval?: number;
  /** Wraps the relay, so a test can make one publish fail. */
  transport?: Transport;
}

function build(table: Omit<Table, 'gm'>, options: Options = {}): ReturnType<typeof createGM> {
  return createGM({
    modules: [ordersModule],
    signer: table.gmSigner,
    transport: table.transport,
    clock: table.clock,
    store: table.store,
    policy: { allowCreate: 'anyone' },
    lobbyDefaults: {
      turnTimeout: options.turnTimeout ?? 0,
      snapshotInterval: options.snapshotInterval ?? 0,
    },
  });
}

async function seat(playerCount: number, options: Options = {}): Promise<Table> {
  const relay = createMemoryRelay();
  const base = {
    relay,
    transport: options.transport ?? relay,
    clock: createManualClock(),
    store: createMemoryStore(),
    gmSigner: signerFromSeed(1),
    players: Array.from({ length: playerCount }, (_, i) => signerFromSeed(i + 2)),
  };
  const gm = build(base, options);
  await gm.start();
  return { ...base, gm };
}

/**
 * Stop the daemon and start another one over the same store, relay and clock.
 *
 * The clock advances by a second first, so the restart is outside the window
 * `inboxSince` treats as "now" — otherwise the historical create comes back and
 * this measures the wrong thing entirely.
 */
async function restart(table: Table, options: Options = {}): Promise<Table> {
  await table.gm.stop();
  table.clock.advance(1);
  const gm = build(table, options);
  await gm.start();
  await gm.drain();
  return { ...table, gm };
}

async function startGame(table: Table, code?: string): Promise<string> {
  const { transport, clock, gm, gmSigner, players } = table;

  const lobbies = players.map((signer) =>
    createLobbySession({ transport, signer, gm: gmSigner.pubkey, clock }),
  );

  const address = await lobbies[0].create(ordersModule.id, CONFIG, code ? { code } : undefined);
  await gm.drain();

  for (const lobby of lobbies.slice(1)) {
    await lobby.watch(address);
    await lobby.join(code ? { code } : undefined);
    await gm.drain();
  }
  for (const lobby of lobbies) {
    await lobby.ready();
    await gm.drain();
  }

  const gameId = lobbies[0].getSnapshot().gameId;
  for (const lobby of lobbies) lobby.close();
  expect(gameId).toBeTruthy();
  return gameId as string;
}

function sessions(table: Table, gameId: string) {
  return table.players.map((signer) =>
    createGameSession<OrdersView, OrdersMove>({
      transport: table.transport,
      module: ordersModule,
      gm: table.gmSigner.pubkey,
      gameId,
      signer,
      clock: table.clock,
    }),
  );
}

/** Every delta the relay holds for a game, in `seq` order. */
function deltaSeqs(relay: MemoryRelay, gameId: string): number[] {
  return relay
    .stored([{ kinds: [KIND.STATE], '#e': [gameId] }])
    .map((e) => parseState(e))
    .flatMap((p) => (p.ok && p.value.type === 'delta' ? [p.value.seq] : []))
    .sort((a, b) => a - b);
}

async function audit(table: Table, gameId: string) {
  const states = table.relay.stored([{ kinds: [KIND.STATE], '#e': [gameId] }]);
  const moves = table.relay.stored([{ kinds: [KIND.MESSAGE], '#e': [gameId] }]);
  const start = states.find((e) => e.id === gameId) ?? table.relay.stored([{ ids: [gameId] }])[0];

  return auditGame(ordersModule, {
    gmPubkey: table.gmSigner.pubkey,
    start,
    states: states.filter((e) => e.id !== gameId),
    moves,
  });
}

describe('resuming a game after the daemon stops', () => {
  it('writes nothing on the way down, so a clean stop and a crash leave the same store', async () => {
    const table = await seat(2);
    await startGame(table);

    const before = JSON.stringify(await table.store.open(table.gmSigner.pubkey));
    await table.gm.stop();
    const after = JSON.stringify(await table.store.open(table.gmSigner.pubkey));

    // If this ever fails, every other test in this file is testing a graceful
    // shutdown path rather than a crash, and says so without meaning to.
    expect(after).toBe(before);
  });

  it('picks the game up mid-round and plays it to an audit that passes', async () => {
    let table = await seat(2);
    const gameId = await startGame(table);
    const clients = sessions(table, gameId);
    for (const s of clients) await s.start();

    // Two clean rounds, then one player commits and the other does not.
    for (let round = 0; round < 2; round++) {
      for (const s of clients) await s.commit({ type: 'hold' });
      await table.gm.drain();
    }
    expect(clients[0].getSnapshot().seq).toBe(2);

    await clients[0].commit({ type: 'advance', distance: 2 });
    await table.gm.drain();
    expect(clients[0].getSnapshot().seq).toBe(2); // Round 3 is still open.

    table = await restart(table);
    expect(table.gm.games.size).toBe(1);

    // The clients were never closed and know nothing about the restart. The
    // second player's move lands in the round the first process opened, against
    // the same `prev`, and closes it.
    await clients[1].commit({ type: 'hold' });
    await table.gm.drain();
    expect(clients[0].getSnapshot().seq).toBe(3);

    for (let guard = 0; guard < 20 && clients[0].getSnapshot().status === 'active'; guard++) {
      for (const s of clients) await s.commit({ type: 'hold' });
      await table.gm.drain();
    }
    expect(clients[0].getSnapshot().status).not.toBe('active');

    const report = await audit(table, gameId);
    expect(report.findings.filter((f) => f.severity === 'error')).toEqual([]);
    expect(report.ok).toBe(true);

    for (const s of clients) s.close();
  });

  it('never publishes two deltas at one seq', async () => {
    let table = await seat(2);
    const gameId = await startGame(table);
    const clients = sessions(table, gameId);
    for (const s of clients) await s.start();

    for (let round = 0; round < 2; round++) {
      for (const s of clients) await s.commit({ type: 'hold' });
      await table.gm.drain();
    }
    await clients[0].commit({ type: 'hold' });
    await table.gm.drain();

    table = await restart(table);

    await clients[1].commit({ type: 'hold' });
    await table.gm.drain();

    // The assertion the whole design exists for. A resumed GM that rebuilt the
    // round from scratch would sign a *second* delta at seq 3 with a fresh
    // `created_at` and therefore a fresh id, and the relay would hold both.
    const seqs = deltaSeqs(table.relay, gameId);
    expect(seqs).toEqual([...new Set(seqs)]);
    expect(seqs).toEqual([1, 2, 3]);

    for (const s of clients) s.close();
  });

  it('keeps the revisions already admitted to the open round', async () => {
    let table = await seat(3);
    const gameId = await startGame(table);
    const clients = sessions(table, gameId);
    for (const s of clients) await s.start();

    await clients[0].commit({ type: 'advance', distance: 3 });
    await clients[1].commit({ type: 'advance', distance: 1 });
    await table.gm.drain();

    table = await restart(table);

    await clients[2].commit({ type: 'hold' });
    await table.gm.drain();

    // Three moves in the round, two of which were admitted by a process that no
    // longer exists. They are cited by the delta because the new process read
    // the raw events back and put them through the same admission path.
    const delta = table.relay
      .stored([{ kinds: [KIND.STATE], '#e': [gameId] }])
      .map((e) => parseState(e))
      .flatMap((p) => (p.ok && p.value.type === 'delta' ? [p.value] : []))
      .find((d) => d.seq === 1);

    expect(delta?.content.applied).toHaveLength(3);
    expect(clients[0].getSnapshot().seq).toBe(1);

    for (const s of clients) s.close();
  });

  it('collects the moves that arrived while nothing was listening', async () => {
    let table = await seat(2);
    const gameId = await startGame(table);
    const clients = sessions(table, gameId);
    for (const s of clients) await s.start();

    // The daemon is down. The player does not know that — a relay accepts the
    // move and stores it, because in `verified` mode a move is a regular kind.
    await table.gm.stop();
    await clients[0].commit({ type: 'advance', distance: 2 });

    table.clock.advance(1);
    const gm = build(table);
    await gm.start();
    await gm.drain();
    table = { ...table, gm };

    // Picked up by the per-game re-query, not by luck: this is the difference
    // between "a move made during a deploy is lost" and "a move made during a
    // deploy lands late".
    await clients[1].commit({ type: 'hold' });
    await table.gm.drain();
    expect(clients[0].getSnapshot().seq).toBe(1);

    const delta = table.relay
      .stored([{ kinds: [KIND.STATE], '#e': [gameId] }])
      .map((e) => parseState(e))
      .flatMap((p) => (p.ok && p.value.type === 'delta' ? [p.value] : []))
      .find((d) => d.seq === 1);
    expect(delta?.content.applied).toHaveLength(2);

    // And the player hears nothing about it: the recovered move was recorded
    // against its own event id, so the inbox subscription's second delivery of
    // it is dropped rather than judged stale and refused.
    expect(clients[0].getSnapshot().error).toBeNull();

    for (const s of clients) s.close();
  });

  it('still knows the join code, which is on no relay at all', async () => {
    const table = await seat(1);
    const code = 'hunter2';

    const opener = createLobbySession({
      transport: table.transport,
      signer: table.players[0],
      gm: table.gmSigner.pubkey,
      clock: table.clock,
    });
    const address = await opener.create(ordersModule.id, CONFIG, { code });
    await table.gm.drain();
    opener.close();

    const restarted = await restart(table);

    const wrong = createLobbySession({
      transport: restarted.transport,
      signer: signerFromSeed(50),
      gm: restarted.gmSigner.pubkey,
      clock: restarted.clock,
    });
    await wrong.watch(address);
    await wrong.join({ code: 'opensesame' });
    await restarted.gm.drain();
    expect(wrong.getSnapshot().error?.message).toBe('bad_code');
    wrong.close();

    const right = createLobbySession({
      transport: restarted.transport,
      signer: signerFromSeed(51),
      gm: restarted.gmSigner.pubkey,
      clock: restarted.clock,
    });
    await right.watch(address);
    await right.join({ code });
    await restarted.gm.drain();
    expect(right.getSnapshot().lobby?.players).toHaveLength(2);
    right.close();
  });
});

describe('the created_at watermark', () => {
  it('survives the restart, so the first lobby rewrite afterwards is not dropped', async () => {
    const table = await seat(1);
    const host = createLobbySession({
      transport: table.transport,
      signer: table.players[0],
      gm: table.gmSigner.pubkey,
      clock: table.clock,
    });
    const address = await host.create(ordersModule.id, CONFIG);
    await table.gm.drain();

    // Four joins inside one clock second. `created_at` has one-second
    // resolution and NIP-01 keeps the *greater* one, so the publisher has to
    // stamp each rewrite a second ahead of the last — which leaves the stored
    // event several seconds in front of the wall clock.
    const guests = [2, 3, 4, 5].map((n) => signerFromSeed(20 + n));
    for (const signer of guests) {
      const guest = createLobbySession({
        transport: table.transport,
        signer,
        gm: table.gmSigner.pubkey,
        clock: table.clock,
      });
      await guest.watch(address);
      await guest.join();
      await table.gm.drain();
      guest.close();
    }

    const drifted = table.relay.stored([{ kinds: [KIND.LOBBY] }])[0].created_at;
    expect(drifted).toBeGreaterThan(table.clock.now());

    // One second of real time passes and the daemon restarts — landing inside
    // the window its own drift created.
    const restarted = await restart(table);

    const last = signerFromSeed(99);
    const late = createLobbySession({
      transport: restarted.transport,
      signer: last,
      gm: restarted.gmSigner.pubkey,
      clock: restarted.clock,
    });
    await late.watch(address);
    await late.join();
    await restarted.gm.drain();

    // Without the restored watermark the new process stamps from `clock.now()`,
    // which is *behind* what the relay already holds, and the relay drops the
    // rewrite without a word: the GM believes it seated a sixth player and every
    // client goes on reading a lobby with five.
    const stored = restarted.relay.stored([{ kinds: [KIND.LOBBY] }])[0];
    expect(stored.created_at).toBeGreaterThan(drifted);

    const lobby = parseLobby(stored);
    expect(lobby.ok).toBe(true);
    expect(lobby.ok && lobby.value.players).toHaveLength(6);

    late.close();
    host.close();
  });
});

describe('resuming after a publish that did not land', () => {
  it('sends the event it signed, not one it built again', async () => {
    const relay = createMemoryRelay();
    let failNextDelta = true;

    // A relay that swallows exactly one delta, on the floor between "signed"
    // and "stored" — the window the outbox exists to cover.
    const flaky: Transport = {
      async publish(event: NostrEvent): Promise<void> {
        const parsed = parseState(event);
        if (failNextDelta && parsed.ok && parsed.value.type === 'delta') {
          failNextDelta = false;
          throw new Error('relay went away');
        }
        await relay.publish(event);
      },
      subscribe: (filters: Filter[], handlers: SubscribeHandlers) =>
        relay.subscribe(filters, handlers),
      query: (filters: Filter[]) => relay.query(filters),
    };

    const base = {
      relay,
      transport: flaky,
      clock: createManualClock(),
      store: createMemoryStore(),
      gmSigner: signerFromSeed(1),
      players: [signerFromSeed(2), signerFromSeed(3)],
    };
    let table: Table = { ...base, gm: build(base) };
    await table.gm.start();

    const gameId = await startGame(table);
    const clients = sessions(table, gameId);
    for (const s of clients) await s.start();

    for (const s of clients) await s.commit({ type: 'hold' });
    await table.gm.drain();

    // The round closed, the delta was signed and written down, and the publish
    // threw. Nothing reached the relay and the clients are still at seq 0.
    expect(deltaSeqs(relay, gameId)).toEqual([]);
    const unsent = table.store.unsent.filter((o) => o.purpose === 'delta');
    expect(unsent).toHaveLength(1);
    const signedId = unsent[0].event.id;

    table = await restart(table);

    // Byte-identical, so the relay sees the event that was always intended
    // rather than a second one at the same seq. A rebuilt delta would carry a
    // later `created_at` and hash to something else.
    const stored = relay.stored([{ ids: [signedId] }]);
    expect(stored).toHaveLength(1);
    expect(deltaSeqs(relay, gameId)).toEqual([1]);
    expect(table.store.unsent).toHaveLength(0);

    for (const s of clients) s.close();
  });
});
