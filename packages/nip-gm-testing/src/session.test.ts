/**
 * A whole game, over a relay, with nothing mocked.
 *
 * This is milestone 5's reason to exist: a real GM daemon and real client
 * sessions, talking over the `Transport` port, playing a simultaneous-round game
 * with hidden queued moves — lobby, start, per-round commit-reveal, revisions,
 * timeouts, snapshots, end reveal — with no relay, no network and no clock.
 *
 * The strongest assertion here is the last one in each game: the event log the
 * daemon produced is fed to `auditGame`, which knows nothing about the daemon
 * and re-derives everything from signatures, revealed keys and the module. A GM
 * that is merely self-consistent fails that. It is the same check a third party
 * would run months later against events pulled off a public relay.
 */
import { describe, expect, it } from 'vitest';
import {
  auditGame,
  buildCreate,
  buildStatus,
  gameMessagesFilter,
  KIND,
  parseHead,
  parseState,
  type NostrEvent,
} from 'nip-gm-core';
import { createGM } from 'nip-gm-gm';
import { createGameSession, createLobbySession } from 'nip-gm-client';
import { createManualClock } from './clock.js';
import { createMemoryRelay, type MemoryRelay } from './memory-transport.js';
import { signerFromSeed, type MemorySigner } from './memory-signer.js';
import { ordersModule, type OrdersMove, type OrdersView } from './example/orders.js';

const CONFIG = { boardSize: 12, maxRounds: 3 };

interface Table {
  relay: MemoryRelay;
  clock: ReturnType<typeof createManualClock>;
  gm: ReturnType<typeof createGM>;
  gmSigner: MemorySigner;
  players: MemorySigner[];
}

async function seat(
  playerCount: number,
  options: { turnTimeout?: number; snapshotInterval?: number } = {},
): Promise<Table> {
  const relay = createMemoryRelay();
  const clock = createManualClock();
  const gmSigner = signerFromSeed(1);
  const players = Array.from({ length: playerCount }, (_, i) => signerFromSeed(i + 2));

  const gm = createGM({
    modules: [ordersModule],
    signer: gmSigner,
    transport: relay,
    clock,
    policy: { allowCreate: 'anyone' },
    lobbyDefaults: {
      turnTimeout: options.turnTimeout ?? 0,
      snapshotInterval: options.snapshotInterval ?? 0,
    },
  });
  await gm.start();

  return { relay, clock, gm, gmSigner, players };
}

/** Run the lobby dance and return the game id the GM started. */
async function startGame(table: Table, config: unknown = CONFIG): Promise<string> {
  const { relay, clock, gm, gmSigner, players } = table;

  const lobbies = players.map((signer) =>
    createLobbySession({ transport: relay, signer, gm: gmSigner.pubkey, clock }),
  );

  const address = await lobbies[0].create(ordersModule.id, config);
  await gm.drain();

  for (const lobby of lobbies.slice(1)) {
    await lobby.watch(address);
    await lobby.join();
    await gm.drain();
  }

  // Start condition is `ready`: the game begins when everyone is.
  for (const lobby of lobbies) {
    await lobby.ready();
    await gm.drain();
  }

  const gameId = lobbies[0].getSnapshot().gameId;
  for (const lobby of lobbies) lobby.close();
  expect(gameId).toBeTruthy();
  return gameId as string;
}

/**
 * Play out whatever rounds remain so the game reaches its end event.
 *
 * Auditing an unfinished game is not meaningful when a seed was committed: the
 * seed is revealed only at the end, so a verifier has nothing to derive the
 * module's randomness from and every recomputed patch diverges. That is the
 * audit correctly refusing to bless a partial log, not a failure — but it means
 * a test that wants a verdict has to finish the game first.
 */
async function playToEnd(
  table: Table,
  sessions: { getSnapshot(): { status: string }; commit(m: OrdersMove): Promise<void> }[],
): Promise<void> {
  for (let guard = 0; guard < 20; guard++) {
    if (sessions[0].getSnapshot().status !== 'active') return;
    for (const session of sessions) {
      await session.commit({ type: 'hold' });
      await table.gm.drain();
    }
  }
  throw new Error('game did not end');
}

/**
 * Let everything the clock kicked off finish.
 *
 * `gm.drain()` covers the daemon's message queue, but a clock callback (a turn
 * timeout, a status heartbeat) publishes outside that queue, and publishing
 * signs — a promise chain the relay's synchronous delivery still sits behind.
 * One macrotask turn is enough to drain it.
 */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Publish a `status` as the GM, bypassing the runner.
 *
 * The runner's own statuses are always self-consistent, which is exactly what a
 * test of how a client *reconciles* them cannot use. Signed by the real GM key,
 * so the session admits it on the same terms as any other.
 */
async function publishStatus(
  table: Table,
  gameId: string,
  seq: number,
  remaining: number,
): Promise<void> {
  const template = buildStatus({ gameId, seq, received: {}, remaining });
  await table.relay.publish(
    await table.gmSigner.signEvent({
      ...template,
      pubkey: table.gmSigner.pubkey,
      created_at: table.clock.now(),
    }),
  );
}

function auditOf(table: Table, gameId: string) {
  const start = table.relay.stored([{ ids: [gameId] }])[0];
  return auditGame(ordersModule, {
    gmPubkey: table.gmSigner.pubkey,
    start,
    states: table.relay.stored([{ kinds: [KIND.STATE], '#e': [gameId] }]),
    moves: table.relay.stored([gameMessagesFilter(gameId)]),
    responses: table.relay.stored([{ kinds: [KIND.MESSAGE], '#p': [table.gmSigner.pubkey] }]),
  });
}

describe('a full game over the in-memory relay', () => {
  it('runs lobby → start → simultaneous rounds → end, and audits clean', async () => {
    const table = await seat(2);
    const gameId = await startGame(table);

    const sessions = table.players.map((signer) =>
      createGameSession<OrdersView, OrdersMove>({
        transport: table.relay,
        module: ordersModule,
        gm: table.gmSigner.pubkey,
        gameId,
        signer,
        clock: table.clock,
      }),
    );
    for (const session of sessions) await session.start();

    // Every session bootstrapped from the seq-0 head the runner published.
    for (const session of sessions) {
      const snapshot = session.getSnapshot();
      expect(snapshot.status).toBe('active');
      expect(snapshot.seats).toHaveLength(2);
      expect(snapshot.needsMyMove).toBe(true);
      expect(Object.keys(snapshot.state.units)).toHaveLength(2);
    }

    for (let round = 0; round < CONFIG.maxRounds; round++) {
      if (sessions[0].getSnapshot().status !== 'active') break;
      await sessions[0].commit({ type: 'hold' });
      await table.gm.drain();
      await sessions[1].commit({ type: 'advance', distance: 1 });
      await table.gm.drain();
    }

    // `final` on every revision closes each round without any timeout firing.
    expect(table.clock.pending).toBe(0);

    for (const session of sessions) {
      const snapshot = session.getSnapshot();
      expect(snapshot.status).toBe('ended');
      expect(snapshot.result).not.toBeNull();
      expect(snapshot.needsMyMove).toBe(false);
      expect(snapshot.state.round).toBe(CONFIG.maxRounds);
      session.close();
    }

    const report = auditOf(table, gameId);
    expect(report.findings.filter((f) => f.severity === 'error')).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.rounds).toBe(CONFIG.maxRounds);
  });

  it('gives both clients the same view of the game', async () => {
    // Two independent clients folding the same patches must agree, or the patch
    // is a function of something other than the delta.
    const table = await seat(2);
    const gameId = await startGame(table);

    const sessions = table.players.map((signer) =>
      createGameSession<OrdersView, OrdersMove>({
        transport: table.relay,
        module: ordersModule,
        gm: table.gmSigner.pubkey,
        gameId,
        signer,
        clock: table.clock,
      }),
    );
    for (const session of sessions) await session.start();

    await sessions[0].commit({ type: 'advance', distance: 2 });
    await table.gm.drain();
    await sessions[1].commit({ type: 'hold' });
    await table.gm.drain();

    expect(sessions[0].getSnapshot().state).toEqual(sessions[1].getSnapshot().state);
    expect(sessions[0].getSnapshot().seq).toBe(1);
    for (const session of sessions) session.close();
  });

  it('never puts an unlanded storm in a client’s view', async () => {
    // Orders schedules a storm three rounds before it lands. If the head or a
    // patch leaked it, every player would dodge it and the module's only hidden
    // mechanic would be gone.
    const table = await seat(2);
    const gameId = await startGame(table);

    const session = createGameSession<OrdersView, OrdersMove>({
      transport: table.relay,
      module: ordersModule,
      gm: table.gmSigner.pubkey,
      gameId,
      signer: table.players[0],
      clock: table.clock,
    });
    await session.start();

    await session.commit({ type: 'hold' });
    await table.gm.drain();
    const other = createGameSession<OrdersView, OrdersMove>({
      transport: table.relay,
      module: ordersModule,
      gm: table.gmSigner.pubkey,
      gameId,
      signer: table.players[1],
      clock: table.clock,
    });
    await other.start();
    await other.commit({ type: 'hold' });
    await table.gm.drain();

    const view = session.getSnapshot();
    expect(view.seq).toBe(1);
    // The GM has scheduled a storm for round 4 by now; the client must not know it.
    expect(view.state.storms.every((s) => s.at <= view.state.round)).toBe(true);
    session.close();
    other.close();
  });
});

describe('revisions over the wire', () => {
  it('keeps the highest revision and publishes the rest as superseded', async () => {
    const table = await seat(2);
    const gameId = await startGame(table);

    const sessions = table.players.map((signer) =>
      createGameSession<OrdersView, OrdersMove>({
        transport: table.relay,
        module: ordersModule,
        gm: table.gmSigner.pubkey,
        gameId,
        signer,
        clock: table.clock,
      }),
    );
    for (const session of sessions) await session.start();

    // Alice changes her mind twice before committing.
    sessions[0].draft({ type: 'advance', distance: 1 });
    await table.gm.drain();
    sessions[0].draft({ type: 'advance', distance: 2 });
    await table.gm.drain();
    await sessions[0].commit({ type: 'advance', distance: 3 });
    await table.gm.drain();

    // The GM acknowledged each revision as it landed.
    expect(sessions[0].getSnapshot().pending?.rev).toBe(2);
    expect(sessions[0].getSnapshot().sync).toBe('received');
    expect(sessions[0].getSnapshot().ackedRev).toBe(2);

    await sessions[1].commit({ type: 'hold' });
    await table.gm.drain();

    const delta = table.relay
      .stored([{ kinds: [KIND.STATE], '#e': [gameId] }])
      .map((e) => parseState(e))
      .flatMap((p) => (p.ok && p.value.type === 'delta' && p.value.seq === 1 ? [p.value] : []))[0];

    expect(delta.content.applied).toHaveLength(2);
    // The two drafts Alice replaced, published with their keys so the GM's
    // choice of winner is checkable rather than merely asserted.
    expect(delta.content.superseded).toHaveLength(2);
    expect(delta.content.superseded?.every((s) => typeof s.key === 'string')).toBe(true);

    // A game containing revisions must still audit clean end to end: the keys
    // published for the discarded revisions are what let the verifier re-run
    // `selectRevisions` and confirm the GM applied the highest one.
    await playToEnd(table, sessions);
    for (const session of sessions) session.close();
    expect(auditOf(table, gameId).ok).toBe(true);
  });

  it('clears the pending move when the GM rejects it, so the player owes one again', async () => {
    const table = await seat(2);
    const gameId = await startGame(table);

    const sessions = table.players.map((signer) =>
      createGameSession<OrdersView, OrdersMove>({
        transport: table.relay,
        module: ordersModule,
        gm: table.gmSigner.pubkey,
        gameId,
        signer,
        clock: table.clock,
      }),
    );
    for (const session of sessions) await session.start();

    // Round 1 spends 3 of 5 energy each, leaving 2.
    for (const session of sessions) {
      await session.commit({ type: 'advance', distance: 3 });
      await table.gm.drain();
    }

    // Round 2: 2 energy will not buy a 3-tile advance.
    await sessions[0].commit({ type: 'advance', distance: 3 });
    await table.gm.drain();

    const snapshot = sessions[0].getSnapshot();
    expect(snapshot.error?.code).toBe('move_rejected');
    expect(snapshot.error?.message).toBe('not_enough_energy');
    // The refused move is not a submitted move. Leaving it pending would keep
    // `needsMyMove` false for the rest of the round and park the UI on
    // "waiting for opponents" until the turn timed out.
    expect(snapshot.pending).toBeNull();
    expect(snapshot.needsMyMove).toBe(true);

    // And the player can actually retry.
    await sessions[0].commit({ type: 'hold' });
    await table.gm.drain();
    expect(sessions[0].getSnapshot().pending).not.toBeNull();

    for (const session of sessions) session.close();
  });

  it('rejects a revision that does not beat what the GM already holds', async () => {
    const table = await seat(2);
    const gameId = await startGame(table);
    const session = createGameSession<OrdersView, OrdersMove>({
      transport: table.relay,
      module: ordersModule,
      gm: table.gmSigner.pubkey,
      gameId,
      signer: table.players[0],
      clock: table.clock,
    });
    await session.start();

    await session.commit({ type: 'hold' });
    await table.gm.drain();

    // A second `commit` after `final` is a no-op on the client; replay the
    // already-published event instead, which is what a retrying relay does.
    const mine = table.relay.stored([gameMessagesFilter(gameId)]).filter(
      (e) => e.pubkey === table.players[0].pubkey,
    );
    expect(mine).toHaveLength(1);
    await table.relay.publish(mine[0]);
    await table.gm.drain();

    // Still exactly one move on the wire, and the GM answered the duplicate.
    const rejections = table.relay
      .stored([{ kinds: [KIND.MESSAGE], '#p': [table.players[0].pubkey] }])
      .filter((e) => e.content.includes('rejected'));
    expect(rejections.length).toBeGreaterThan(0);
    expect(rejections.some((e) => e.content.includes('duplicate'))).toBe(true);
    session.close();
  });
});

describe('timeouts', () => {
  it('closes a round on the turn timeout with a signed system input', async () => {
    const table = await seat(2, { turnTimeout: 60 });
    const gameId = await startGame(table);

    const session = createGameSession<OrdersView, OrdersMove>({
      transport: table.relay,
      module: ordersModule,
      gm: table.gmSigner.pubkey,
      gameId,
      signer: table.players[0],
      clock: table.clock,
    });
    await session.start();

    await session.commit({ type: 'hold' });
    await table.gm.drain();
    expect(session.getSnapshot().seq).toBe(0); // Still waiting on the other player.

    table.clock.advance(61);
    await table.gm.drain();

    expect(session.getSnapshot().seq).toBe(1);

    const delta = table.relay
      .stored([{ kinds: [KIND.STATE], '#e': [gameId] }])
      .map((e) => parseState(e))
      .flatMap((p) => (p.ok && p.value.type === 'delta' ? [p.value] : []))[0];
    // Materialized as a replay input rather than a decision taken offstage.
    expect(delta.content.system).toEqual({ type: 'timeout' });

    // Let the remaining rounds time out too, so the game ends and the seed is
    // revealed — the audit then has to reproduce the timeouts as inputs.
    while (session.getSnapshot().status === 'active') {
      table.clock.advance(61);
      await table.gm.drain();
    }

    session.close();
    expect(auditOf(table, gameId).ok).toBe(true);
  });

  it('reports the turn clock on status, and the client anchors it to its own clock', async () => {
    const table = await seat(2, { turnTimeout: 60 });
    const gameId = await startGame(table);
    // Round 1 opened during startGame; the manual clock has not moved since.
    const openedAt = table.clock.now();

    // This session joins after the round opened, so it missed the opening
    // status — the event is ephemeral, and there is nothing on the relay to
    // catch up from. Nobody has moved either, so a status-on-move GM would
    // leave this client with no clock for the entire round.
    const session = createGameSession<OrdersView, OrdersMove>({
      transport: table.relay,
      module: ordersModule,
      gm: table.gmSigner.pubkey,
      gameId,
      signer: table.players[0],
      clock: table.clock,
    });
    await session.start();
    expect(session.getSnapshot().deadline).toBeNull();

    // The heartbeat is what rescues it.
    table.clock.advance(10);
    await settle();
    expect(session.getSnapshot().deadline).toBe(openedAt + 60);

    // Every republication re-anchors the same instant rather than accumulating
    // error, which is the whole point of publishing a duration.
    table.clock.advance(30);
    await settle();
    const snapshot = session.getSnapshot();
    expect(snapshot.deadline).toBe(openedAt + 60);
    expect(snapshot.deadline! - table.clock.now()).toBe(20);

    // The GM published a duration, not a wall-clock instant.
    const statuses = table.relay.log
      .map((e) => parseState(e))
      .flatMap((p) => (p.ok && p.value.type === 'status' ? [p.value] : []));
    expect(statuses.length).toBeGreaterThan(1);
    expect(statuses.at(-1)?.remaining).toBe(20);

    // Closing the round retires the old countdown and starts the next one.
    table.clock.advance(30);
    await table.gm.drain();
    await settle();
    expect(session.getSnapshot().seq).toBe(1);
    expect(session.getSnapshot().deadline).toBe(table.clock.now() + 60);

    session.close();
  });

  it('holds the countdown steady through a second of clock rounding', async () => {
    const table = await seat(2, { turnTimeout: 60 });
    const gameId = await startGame(table);

    const session = createGameSession<OrdersView, OrdersMove>({
      transport: table.relay,
      module: ordersModule,
      gm: table.gmSigner.pubkey,
      gameId,
      signer: table.players[0],
      clock: table.clock,
    });
    await session.start();
    table.clock.advance(10);
    await settle();

    const held = session.getSnapshot().deadline;
    expect(held).not.toBeNull();

    // Two second-granular clocks anchoring the same instant can land a second
    // apart, and a countdown that took every anchor literally would stutter.
    await publishStatus(table, gameId, 1, held! - table.clock.now() - 1);
    expect(session.getSnapshot().deadline).toBe(held);

    // A real change is a real change, though — a GM that shortens the round has
    // to be believed.
    await publishStatus(table, gameId, 1, 5);
    expect(session.getSnapshot().deadline).toBe(table.clock.now() + 5);

    session.close();
  });

  it('leaves the deadline null in an untimed game, and publishes no countdown', async () => {
    const table = await seat(2);
    const gameId = await startGame(table);

    const session = createGameSession<OrdersView, OrdersMove>({
      transport: table.relay,
      module: ordersModule,
      gm: table.gmSigner.pubkey,
      gameId,
      signer: table.players[0],
      clock: table.clock,
    });
    await session.start();

    await session.commit({ type: 'hold' });
    await table.gm.drain();

    const statuses = table.relay.log
      .map((e) => parseState(e))
      .flatMap((p) => (p.ok && p.value.type === 'status' ? [p.value] : []));
    expect(statuses.length).toBeGreaterThan(0);
    expect(statuses.every((s) => s.remaining === undefined)).toBe(true);
    expect(session.getSnapshot().deadline).toBeNull();
    // Nothing to fire and nothing to republish: an untimed round schedules no
    // timers at all.
    expect(table.clock.pending).toBe(0);

    session.close();
  });
});

describe('spectators and head snapshots', () => {
  it('lets a spectator with no signer follow the game', async () => {
    const table = await seat(2, { snapshotInterval: 1 });
    const gameId = await startGame(table);

    const players = table.players.map((signer) =>
      createGameSession<OrdersView, OrdersMove>({
        transport: table.relay,
        module: ordersModule,
        gm: table.gmSigner.pubkey,
        gameId,
        signer,
        clock: table.clock,
      }),
    );
    for (const session of players) await session.start();

    await players[0].commit({ type: 'hold' });
    await table.gm.drain();
    await players[1].commit({ type: 'hold' });
    await table.gm.drain();

    // Joins after round 1 has already closed, and reconstructs from the head.
    const spectator = createGameSession<OrdersView, OrdersMove>({
      transport: table.relay,
      module: ordersModule,
      gm: table.gmSigner.pubkey,
      gameId,
      clock: table.clock,
    });
    await spectator.start();

    expect(spectator.getSnapshot().seq).toBe(1);
    expect(spectator.getSnapshot().needsMyMove).toBe(false);
    expect(spectator.getSnapshot().state).toEqual(players[0].getSnapshot().state);

    for (const session of players) session.close();
    spectator.close();
  });

  it('lets a player who joins mid-game from the head still move', async () => {
    // The head gives a view but says nothing about who the open round awaits or
    // which event a move must pin as `prev`. A client that took only the head
    // would be stuck until the *next* delta — which never comes, because it is
    // one of the players the round is waiting on.
    const table = await seat(2, { snapshotInterval: 1 });
    const gameId = await startGame(table);

    const open = (signer: MemorySigner) =>
      createGameSession<OrdersView, OrdersMove>({
        transport: table.relay,
        module: ordersModule,
        gm: table.gmSigner.pubkey,
        gameId,
        signer,
        clock: table.clock,
      });

    const first = table.players.map(open);
    for (const session of first) await session.start();
    for (const session of first) {
      await session.commit({ type: 'hold' });
      await table.gm.drain();
    }
    for (const session of first) session.close();

    // Round 1 has closed; round 2 is open and awaits both players.
    const rejoined = open(table.players[0]);
    await rejoined.start();
    expect(rejoined.getSnapshot().seq).toBe(1);
    expect(rejoined.getSnapshot().needsMyMove).toBe(true);

    await rejoined.commit({ type: 'hold' });
    await table.gm.drain();
    expect(rejoined.getSnapshot().pending).not.toBeNull();
    expect(rejoined.getSnapshot().sync).toBe('received');
    rejoined.close();
  });

  it('publishes a redacted head, not the GM’s full state', async () => {
    const table = await seat(2, { snapshotInterval: 1 });
    const gameId = await startGame(table);

    const sessions = table.players.map((signer) =>
      createGameSession<OrdersView, OrdersMove>({
        transport: table.relay,
        module: ordersModule,
        gm: table.gmSigner.pubkey,
        gameId,
        signer,
        clock: table.clock,
      }),
    );
    for (const session of sessions) await session.start();
    await sessions[0].commit({ type: 'hold' });
    await table.gm.drain();
    await sessions[1].commit({ type: 'hold' });
    await table.gm.drain();

    const head = table.relay.stored([{ kinds: [KIND.GAME_HEAD], '#d': [gameId] }])[0];
    const parsed = parseHead(head);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const state = parsed.value.state as OrdersView;
    // The GM's own state has a storm scheduled for round 4 at this point.
    expect(state.storms.every((s) => s.at <= state.round)).toBe(true);

    for (const session of sessions) session.close();
  });

  it('bootstraps a session from the head verbatim, without deserializing it', async () => {
    const table = await seat(2);
    const gameId = await startGame(table);

    const session = createGameSession<OrdersView, OrdersMove>({
      transport: table.relay,
      module: ordersModule,
      gm: table.gmSigner.pubkey,
      gameId,
      clock: table.clock,
    });
    await session.start();

    const head = parseHead(table.relay.stored([{ kinds: [KIND.GAME_HEAD], '#d': [gameId] }])[0]);
    expect(head.ok).toBe(true);
    if (!head.ok) return;

    // The head carries `redact` output, and `redact` output is not `serialize`
    // output — so it must NOT be run through `deserialize` on the way in. It is
    // also the value `applyPatch` folds onto, which the module contract is
    // explicit about. This passes trivially for a module whose State is already
    // a plain object; it is the guard for one whose State is a class, where
    // deserializing here silently produces a view no patch can be folded into.
    expect(session.getSnapshot().state).toEqual(head.value.state);

    session.close();
  });
});

describe('GM policy', () => {
  it('refuses to open a lobby when policy says no, and says so', async () => {
    const relay = createMemoryRelay();
    const clock = createManualClock();
    const gmSigner = signerFromSeed(1);
    const player = signerFromSeed(2);

    const gm = createGM({
      modules: [ordersModule],
      signer: gmSigner,
      transport: relay,
      clock,
      policy: { allowCreate: 'nobody' },
    });
    await gm.start();

    const lobby = createLobbySession({
      transport: relay,
      signer: player,
      gm: gmSigner.pubkey,
      clock,
    });

    // Rejected rather than ignored: a client that hears nothing cannot tell
    // "refused" from "offline" and retries forever.
    await expect(lobby.create(ordersModule.id, CONFIG)).rejects.toThrow('lobby_creation_disabled');
    lobby.close();
  });

  it('rejects a malformed create body instead of substituting defaults', async () => {
    const table = await seat(1);
    const player = table.players[0];

    // Hand-built rather than sent through `lobbySession.create`, because the
    // client's formatter would sanitize the bad value away. This is what a
    // buggy or hostile client actually puts on the wire.
    const request = await player.signEvent({
      ...buildCreate(
        { kind: KIND.GM_ANNOUNCEMENT, pubkey: table.gmSigner.pubkey, identifier: ordersModule.id },
        table.gmSigner.pubkey,
        JSON.stringify({ start: 'leedur', config: CONFIG }),
      ),
      pubkey: player.pubkey,
      created_at: table.clock.now(),
    });
    await table.relay.publish(request);
    await table.gm.drain();

    const responses = table.relay.stored([{ kinds: [KIND.MESSAGE], '#p': [player.pubkey] }]);
    const body = JSON.parse(responses.at(-1)!.content) as { status: string; reason?: string };

    expect(body.status).toBe('rejected');
    expect(body.reason).toBe('bad_create_request:bad_start');
    // And no lobby was opened under a substituted default.
    expect(table.relay.stored([{ kinds: [KIND.LOBBY] }])).toHaveLength(0);
  });
});

describe('start conditions', () => {
  it('starts a `leader` lobby only when the leader says so', async () => {
    const table = await seat(2);
    const [creator, other] = table.players.map((signer) =>
      createLobbySession({
        transport: table.relay,
        signer,
        gm: table.gmSigner.pubkey,
        clock: table.clock,
      }),
    );

    const address = await creator.create(ordersModule.id, CONFIG, { start: { kind: 'leader' } });
    await table.gm.drain();

    // The creator leads: they are the only participant when the lobby opens.
    expect(creator.getSnapshot().lobby?.start).toEqual({ kind: 'leader' });
    expect(creator.getSnapshot().lobby?.leader).toBe(table.players[0].pubkey);

    await other.watch(address);
    await other.join();
    await table.gm.drain();

    // Everyone being ready is NOT enough here — that is the whole difference
    // from a `ready` lobby, where this would already have started the game.
    await creator.ready();
    await table.gm.drain();
    await other.ready();
    await table.gm.drain();
    expect(creator.getSnapshot().gameId).toBeNull();

    // A non-leader's start intent is meaningless and must be ignored.
    await other.ready({ start: true });
    await table.gm.drain();
    expect(creator.getSnapshot().gameId).toBeNull();

    await creator.ready({ start: true });
    await table.gm.drain();
    expect(creator.getSnapshot().gameId).toBeTruthy();

    creator.close();
    other.close();
  });

  it('publishes the raw lobby config in the start event, not parseConfig output', async () => {
    const table = await seat(2);
    // `extra` is dropped by ordersModule.parseConfig, so its presence in the
    // start event is proof the raw value was published.
    const raw = { ...CONFIG, extra: 'kept' };
    const gameId = await startGame(table, raw);

    const start = parseState(table.relay.stored([{ ids: [gameId] }])[0]);
    expect(start.ok).toBe(true);
    if (!start.ok || start.value.type !== 'start') return;

    // Auditors and joining clients both run `parseConfig` on this field, so it
    // must be parser input. Publishing parsed output would also quietly require
    // every module's Config to survive a JSON round trip — a Config holding
    // Maps stringifies to `{}`, and every auditor would then rebuild a
    // different game than the one that was played.
    expect(start.value.content.config).toEqual(raw);
  });

  it('still defaults to `ready` when the client asks for nothing', async () => {
    const table = await seat(1);
    const lobby = createLobbySession({
      transport: table.relay,
      signer: table.players[0],
      gm: table.gmSigner.pubkey,
      clock: table.clock,
    });

    await lobby.create(ordersModule.id, CONFIG);
    await table.gm.drain();

    expect(lobby.getSnapshot().lobby?.start).toEqual({ kind: 'ready' });
    expect(lobby.getSnapshot().lobby?.visibility).toBe('public');
    expect(lobby.getSnapshot().lobby?.leader).toBeUndefined();

    lobby.close();
  });
});

describe('same-second republication', () => {
  /**
   * The clock never advances in these tests, which is not a simplification —
   * it is the realistic case. A lobby fills up in milliseconds, and `created_at`
   * has one-second resolution, so every rewrite of the lobby event carries the
   * same timestamp as the version already on the relay. NIP-01 resolves that tie
   * by id, not by arrival, so the GM cannot assume its newer version wins.
   *
   * This bites nothing until a real relay is involved: it is invisible to any
   * transport that overwrites on write, and it produces no error anywhere. The
   * lobby simply stops updating, and players wait forever for a game that from
   * their side never filled up.
   */
  it('advances created_at so every lobby rewrite survives the replacement race', async () => {
    const table = await seat(3);
    const [creator, second, third] = table.players.map((signer) =>
      createLobbySession({
        transport: table.relay,
        signer,
        gm: table.gmSigner.pubkey,
        clock: table.clock,
      }),
    );

    const address = await creator.create(ordersModule.id, CONFIG);
    await table.gm.drain();

    for (const lobby of [second, third]) {
      await lobby.watch(address);
      await lobby.join();
      await table.gm.drain();
    }

    // Six rewrites (create, two joins, three readies) inside one clock second.
    expect(table.clock.now()).toBe(table.clock.now());
    expect(creator.getSnapshot().lobby?.players).toHaveLength(3);

    // And a client arriving now — reading storage rather than the live stream —
    // must see the same roster. This is the half a live-only delivery would fake.
    const latecomer = createLobbySession({
      transport: table.relay,
      signer: signerFromSeed(99),
      gm: table.gmSigner.pubkey,
      clock: table.clock,
    });
    await latecomer.watch(address);
    expect(latecomer.getSnapshot().lobby?.players).toHaveLength(3);

    for (const lobby of [creator, second, third]) {
      await lobby.ready();
      await table.gm.drain();
    }

    // The last rewrite of all — the one carrying `gameId` — is the one a naive
    // stamp is most likely to lose, because by then the coordinate has been
    // written five times already.
    expect(creator.getSnapshot().gameId).toBeTruthy();
    expect(latecomer.getSnapshot().gameId).toBe(creator.getSnapshot().gameId);

    for (const lobby of [creator, second, third, latecomer]) lobby.close();
  });

  it('leaves regular events on the true clock time', async () => {
    // The guard applies to current-state documents, never to log entries. A
    // move, a delta or a response is a regular event: it accumulates, it never
    // races anything, and its timestamp is evidence. Inflating those to keep a
    // counter monotonic would corrupt the record an auditor reads.
    const table = await seat(2);
    const gameId = await startGame(table);
    const now = table.clock.now();

    const regular = table.relay.log.filter(
      (e) => e.pubkey === table.gmSigner.pubkey && e.kind === KIND.MESSAGE,
    );
    expect(regular.length).toBeGreaterThan(0);
    for (const event of regular) expect(event.created_at).toBe(now);

    // Whereas the lobby, rewritten repeatedly at that same coordinate, has been
    // pushed ahead of the wall clock — the deliberate cost of the guard.
    const lobby = table.relay.stored([{ kinds: [KIND.LOBBY] }])[0];
    expect(lobby.created_at).toBeGreaterThan(now);
  });
});

describe('the relay itself', () => {
  it('never stores an ephemeral event but still delivers it live', async () => {
    const relay = createMemoryRelay();
    const signer = signerFromSeed(9);
    const seen: NostrEvent[] = [];
    relay.subscribe([{ kinds: [KIND.STATE_EPHEMERAL] }], { onEvent: (e) => seen.push(e) });

    const event = await signer.signEvent({
      kind: KIND.STATE_EPHEMERAL,
      tags: [['state', 'status']],
      content: '{}',
      pubkey: signer.pubkey,
      created_at: 1,
    });
    await relay.publish(event);

    expect(seen).toHaveLength(1);
    expect(relay.stored([{ kinds: [KIND.STATE_EPHEMERAL] }])).toHaveLength(0);
    expect(await relay.query([{ kinds: [KIND.STATE_EPHEMERAL] }])).toHaveLength(0);
  });

  it('replaces an addressable event in place rather than accumulating', async () => {
    const relay = createMemoryRelay();
    const signer = signerFromSeed(9);

    for (const [i, created_at] of [10, 20].entries()) {
      await relay.publish(
        await signer.signEvent({
          kind: KIND.LOBBY,
          tags: [['d', 'room']],
          content: JSON.stringify({ n: i }),
          pubkey: signer.pubkey,
          created_at,
        }),
      );
    }

    const stored = relay.stored([{ kinds: [KIND.LOBBY], '#d': ['room'] }]);
    expect(stored).toHaveLength(1);
    expect(stored[0].created_at).toBe(20);
    // The whole log is still there for anyone auditing what was published.
    expect(relay.log).toHaveLength(2);
  });

  it('does not deliver a replacement it refused to store', async () => {
    // `created_at` is in whole seconds, so a GM rewriting a lobby on every join
    // routinely publishes two versions within the same second. NIP-01 says the
    // relay keeps the lower id on a tie — it does not keep the newer arrival —
    // and an event the relay refuses to store is an event it does not forward.
    //
    // Delivering it live anyway would be the worst kind of wrong: every client
    // connected at that moment would see the update, so the publisher would look
    // correct, and only a client joining later would read the stale version and
    // have no idea why.
    const relay = createMemoryRelay();
    const signer = signerFromSeed(9);
    const seen: NostrEvent[] = [];
    relay.subscribe([{ kinds: [KIND.LOBBY] }], { onEvent: (e) => seen.push(e) });

    const at = (n: number, created_at: number): Promise<NostrEvent> =>
      signer.signEvent({
        kind: KIND.LOBBY,
        tags: [['d', 'room']],
        content: JSON.stringify({ n }),
        pubkey: signer.pubkey,
        created_at,
      });

    // Two candidates one second apart, published newest first. The second
    // publish loses the replacement race however the ids happen to sort.
    const newer = await at(1, 20);
    const older = await at(0, 10);
    await relay.publish(newer);
    await relay.publish(older);

    expect(seen.map((e) => e.id)).toStrictEqual([newer.id]);
    expect(relay.stored([{ kinds: [KIND.LOBBY] }])).toHaveLength(1);
    expect(relay.stored([{ kinds: [KIND.LOBBY] }])[0].id).toBe(newer.id);
    // Still published, and still visible to anyone auditing the wire — it just
    // never became the current version and never reached a subscriber.
    expect(relay.log).toHaveLength(2);
  });

  it('refuses an event whose content was altered under a valid signature', async () => {
    const relay = createMemoryRelay();
    const signer = signerFromSeed(9);
    const event = await signer.signEvent({
      kind: KIND.MESSAGE,
      tags: [],
      content: 'honest',
      pubkey: signer.pubkey,
      created_at: 1,
    });

    // The signature covers only the 32-byte id, so a relay that checked it
    // without recomputing the id would accept this.
    await expect(relay.publish({ ...event, content: 'tampered' })).rejects.toThrow(
      'bad id or signature',
    );
  });
});
