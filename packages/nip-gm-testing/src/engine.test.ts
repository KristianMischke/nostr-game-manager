/**
 * Engine, determinism harness and verifier, exercised against the Orders
 * reference module — a simultaneous-round game with hidden moves, contested
 * resolution and scheduled randomness.
 */
import { describe, expect, it } from 'vitest';
import {
  auditGame,
  canonicalJson,
  GameEngine,
  replay,
  type GameLog,
  type Hex,
  type ResolvedMove,
} from 'nip-gm-core';
import { checkDeterminism } from './determinism.js';
import { runScriptedGame, type ScriptedRound } from './harness.js';
import { signerFromSeed } from './memory-signer.js';
import { ordersModule, ordersMove, type OrdersConfig, type OrdersMove } from './example/orders.js';

const CONFIG: OrdersConfig = { boardSize: 12, maxRounds: 6 };
const SEED = new Uint8Array(32).fill(3);
const GAME = 'a'.repeat(64) as Hex;

const gm = signerFromSeed(10);
const alice = signerFromSeed(11);
const bob = signerFromSeed(12);
const carol = signerFromSeed(13);
const seats: Hex[] = [alice.pubkey, bob.pubkey, carol.pubkey];

let counter = 0;
function move(player: Hex, m: OrdersMove): ResolvedMove<OrdersMove> {
  counter++;
  return {
    id: counter.toString(16).padStart(64, '0'),
    player,
    seat: seats.indexOf(player),
    move: m,
  };
}

function sampleLog(rounds = 4): GameLog<OrdersConfig, OrdersMove> {
  counter = 0;
  return {
    gameId: GAME,
    config: CONFIG,
    seats,
    seed: SEED,
    rounds: Array.from({ length: rounds }, (_, i) => ({
      now: 1_700_000_000 + i * 60,
      moves: [
        move(alice.pubkey, { type: 'advance', distance: 2 }),
        move(bob.pubkey, { type: 'advance', distance: 2 }),
        move(carol.pubkey, { type: 'hold' }),
      ],
    })),
  };
}

describe('GameEngine', () => {
  it('initialises from config, seats and seed', () => {
    const engine = new GameEngine(ordersModule, { gameId: GAME, config: CONFIG, seats, seed: SEED });
    expect(engine.seq).toBe(0);
    expect(engine.isOver).toBe(false);
    expect(Object.keys(engine.state.units)).toHaveLength(3);
  });

  it('places every player on a distinct tile', () => {
    const engine = new GameEngine(ordersModule, { gameId: GAME, config: CONFIG, seats, seed: SEED });
    const tiles = seats.map((s) => engine.state.units[s].tile);
    expect(new Set(tiles).size).toBe(3);
  });

  it('orders moves itself, so a caller cannot forget', () => {
    const engine = new GameEngine(ordersModule, { gameId: GAME, config: CONFIG, seats, seed: SEED });
    const moves = [
      move(alice.pubkey, { type: 'hold' }),
      move(bob.pubkey, { type: 'hold' }),
      move(carol.pubkey, { type: 'hold' }),
    ];
    const forward = engine.applyRound(moves, null, 1);

    const engine2 = new GameEngine(ordersModule, { gameId: GAME, config: CONFIG, seats, seed: SEED });
    const reversed = engine2.applyRound([...moves].reverse(), null, 1);

    expect(forward.ordered.map((m) => m.id)).toEqual(reversed.ordered.map((m) => m.id));
    expect(canonicalJson(forward.state)).toBe(canonicalJson(reversed.state));
  });

  it('advances seq and reports who acts next', () => {
    const engine = new GameEngine(ordersModule, { gameId: GAME, config: CONFIG, seats, seed: SEED });
    const outcome = engine.applyRound([move(alice.pubkey, { type: 'hold' })], null, 1);
    expect(engine.seq).toBe(1);
    expect(outcome.awaiting).toEqual(seats);
  });

  it('applies a forfeit system input', () => {
    const engine = new GameEngine(ordersModule, { gameId: GAME, config: CONFIG, seats, seed: SEED });
    engine.applyRound([], { type: 'forfeit', player: bob.pubkey }, 1);
    expect(engine.state.eliminated).toContain(bob.pubkey);
    expect(engine.awaiting).not.toContain(bob.pubkey);
  });

  it('handles a round where nobody submitted', () => {
    // Every player timed out. A real round, not an error.
    const engine = new GameEngine(ordersModule, { gameId: GAME, config: CONFIG, seats, seed: SEED });
    expect(() => engine.applyRound([], null, 1)).not.toThrow();
    expect(engine.seq).toBe(1);
  });

  it('refuses to apply a round after the game ended', () => {
    const engine = new GameEngine(ordersModule, { gameId: GAME, config: CONFIG, seats, seed: SEED });
    for (let i = 0; i < CONFIG.maxRounds; i++) {
      engine.applyRound([move(alice.pubkey, { type: 'hold' })], null, i + 1);
    }
    expect(engine.isOver).toBe(true);
    expect(() => engine.applyRound([], null, 99)).toThrow(/already ended/);
  });

  it('validates module rules without mutating state', () => {
    const engine = new GameEngine(ordersModule, { gameId: GAME, config: CONFIG, seats, seed: SEED });
    const before = canonicalJson(engine.state);

    expect(engine.validate(move(alice.pubkey, { type: 'advance', distance: 2 }), 1)).toEqual({
      ok: true,
    });
    expect(engine.validate(move(alice.pubkey, { type: 'advance', distance: 9 }), 1)).toEqual({
      ok: false,
      reason: 'bad_distance',
    });
    expect(canonicalJson(engine.state)).toBe(before);
  });
});

describe('replay', () => {
  it('reproduces the same final state every time', () => {
    const a = replay(ordersModule, sampleLog());
    const b = replay(ordersModule, sampleLog());
    expect(canonicalJson(a.state)).toBe(canonicalJson(b.state));
  });

  it('is equivalent to driving the engine round by round', () => {
    // The GM steps the engine forward; an auditor calls replay(). They must
    // agree, because they are the same code path.
    const log = sampleLog();
    const folded = replay(ordersModule, log);

    const engine = new GameEngine(ordersModule, log);
    for (const round of log.rounds) engine.applyRound(round.moves, round.system ?? null, round.now);

    expect(canonicalJson(folded.state)).toBe(canonicalJson(engine.state));
  });

  it('diverges when the seed differs', () => {
    const other = { ...sampleLog(), seed: new Uint8Array(32).fill(9) };
    expect(canonicalJson(replay(ordersModule, sampleLog()).state)).not.toBe(
      canonicalJson(replay(ordersModule, other).state),
    );
  });

  it('stops at the end rather than applying trailing rounds', () => {
    const long = sampleLog(CONFIG.maxRounds + 5);
    const result = replay(ordersModule, long);
    expect(result.rounds.length).toBeLessThanOrEqual(CONFIG.maxRounds);
    expect(result.result).toBeDefined();
  });
});

describe('checkDeterminism', () => {
  it('passes a well-behaved module', () => {
    const report = checkDeterminism(ordersModule, sampleLog(), { checkOrderIndependence: true });
    expect(report.findings).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it('catches a module that reads Math.random', () => {
    const naughty = {
      ...ordersModule,
      apply(state: never, input: never, ctx: never) {
        Math.random();
        return ordersModule.apply(state, input, ctx);
      },
    };
    const report = checkDeterminism(naughty as typeof ordersModule, sampleLog());
    expect(report.ok).toBe(false);
    expect(report.findings.map((f) => f.code)).toContain('ambient_nondeterminism');
  });

  it('catches a module that reads the clock', () => {
    const naughty = {
      ...ordersModule,
      apply(state: never, input: never, ctx: never) {
        Date.now();
        return ordersModule.apply(state, input, ctx);
      },
    };
    const report = checkDeterminism(naughty as typeof ordersModule, sampleLog());
    expect(report.ok).toBe(false);
    expect(report.findings.map((f) => f.code)).toContain('ambient_nondeterminism');
  });

  it('catches a module that mutates the state it was given', () => {
    const naughty = {
      ...ordersModule,
      apply(state: { round: number }, input: never, ctx: never) {
        state.round = 999; // in-place edit of the caller's state
        return ordersModule.apply(state as never, input, ctx);
      },
    };
    const report = checkDeterminism(naughty as unknown as typeof ordersModule, sampleLog());
    expect(report.ok).toBe(false);
    expect(report.findings.map((f) => f.code)).toContain('mutates_input');
  });

  it('catches a module that re-sorts the round in place', () => {
    // Sorting `input.moves` in place both ignores the declared resolution order
    // and corrupts the caller's array — the engine published that exact
    // ordering in the delta, so an auditor would resolve a different round.
    const naughty = {
      ...ordersModule,
      apply(state: never, input: { moves: ResolvedMove<OrdersMove>[] }, ctx: never) {
        input.moves.sort((a, b) => a.seat - b.seat);
        return ordersModule.apply(state, input as never, ctx);
      },
    };
    const report = checkDeterminism(naughty as unknown as typeof ordersModule, sampleLog(), {
      checkOrderIndependence: true,
    });
    expect(report.ok).toBe(false);
    expect(report.findings.map((f) => f.code)).toContain('mutates_input');
  });
});

describe('auditGame', () => {
  const script: ScriptedRound<OrdersMove>[] = Array.from({ length: 4 }, () => ({
    moves: [
      { player: alice, move: { type: 'advance', distance: 2 } as OrdersMove, wire: ordersMove({ type: 'advance', distance: 2 }) },
      { player: bob, move: { type: 'advance', distance: 1 } as OrdersMove, wire: ordersMove({ type: 'advance', distance: 1 }) },
      { player: carol, move: { type: 'hold' } as OrdersMove, wire: ordersMove({ type: 'hold' }) },
    ],
  }));

  const play = () =>
    runScriptedGame(ordersModule, { gm, players: [alice, bob, carol], config: CONFIG, rounds: script });

  it('accepts an honest game', async () => {
    const t = await play();
    const report = auditGame(ordersModule, {
      gmPubkey: t.gmPubkey,
      start: t.start,
      states: t.states,
      moves: t.moves,
    });
    expect(report.findings.filter((f) => f.severity === 'error')).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.rounds).toBe(4);
  });

  it('reproduces the GM’s final state exactly', async () => {
    const t = await play();
    const report = auditGame(ordersModule, {
      gmPubkey: t.gmPubkey,
      start: t.start,
      states: t.states,
      moves: t.moves,
    });
    expect(canonicalJson(report.state)).toBe(canonicalJson(t.finalState));
  });

  it('catches a tampered patch', async () => {
    const t = await play();
    const states = t.states.map((e) => {
      if (!e.content.includes('"patch"')) return e;
      const raw = JSON.parse(e.content);
      raw.patch.round = 999;
      return { ...e, content: JSON.stringify(raw) };
    });

    const report = auditGame(ordersModule, {
      gmPubkey: t.gmPubkey,
      start: t.start,
      states,
      moves: t.moves,
    });
    expect(report.ok).toBe(false);
    // Tampering breaks the signature first, which is itself the right finding.
    expect(report.findings.map((f) => f.code)).toContain('bad_signature');
  });

  it('catches a GM that signs a patch not matching the module', async () => {
    // Re-sign the forged delta so the signature check passes and the divergence
    // must be caught by re-running the module.
    const t = await play();
    const states: typeof t.states = [];
    for (const e of t.states) {
      if (!e.content.includes('"patch"')) {
        states.push(e);
        continue;
      }
      const raw = JSON.parse(e.content);
      raw.patch.round = 999;
      states.push(await gm.signEvent({ ...e, content: JSON.stringify(raw) }));
    }

    const report = auditGame(ordersModule, {
      gmPubkey: t.gmPubkey,
      start: t.start,
      states,
      moves: t.moves,
    });
    expect(report.ok).toBe(false);
    expect(report.findings.map((f) => f.code)).toContain('patch_divergence');
  });

  it('catches a GM that publishes a plaintext the ciphertext does not support', async () => {
    const t = await play();
    const states: typeof t.states = [];
    for (const e of t.states) {
      const raw = e.content.includes('"applied"') ? JSON.parse(e.content) : null;
      if (!raw?.applied?.length) {
        states.push(e);
        continue;
      }
      raw.applied[0].move = { type: 'advance', data: { distance: 3 } };
      states.push(await gm.signEvent({ ...e, content: JSON.stringify(raw) }));
    }

    const report = auditGame(ordersModule, {
      gmPubkey: t.gmPubkey,
      start: t.start,
      states,
      moves: t.moves,
    });
    expect(report.ok).toBe(false);
    expect(report.findings.map((f) => f.code)).toContain('reveal_mismatch');
  });

  it('catches a forged seed reveal', async () => {
    const t = await play();
    const states: typeof t.states = [];
    for (const e of t.states) {
      const raw = e.content.includes('"seed"') ? JSON.parse(e.content) : null;
      if (!raw?.seed) {
        states.push(e);
        continue;
      }
      raw.seed = 'ab'.repeat(32);
      states.push(await gm.signEvent({ ...e, content: JSON.stringify(raw) }));
    }

    const report = auditGame(ordersModule, {
      gmPubkey: t.gmPubkey,
      start: t.start,
      states,
      moves: t.moves,
    });
    expect(report.ok).toBe(false);
    expect(report.findings.map((f) => f.code)).toContain('seed_commit_mismatch');
  });

  it('rejects a log audited against the wrong GM key', async () => {
    const t = await play();
    const report = auditGame(ordersModule, {
      gmPubkey: signerFromSeed(99).pubkey,
      start: t.start,
      states: t.states,
      moves: t.moves,
    });
    expect(report.ok).toBe(false);
    expect(report.findings.map((f) => f.code)).toContain('wrong_author');
  });

  it('rejects a log audited against the wrong module', async () => {
    const t = await play();
    const other = { ...ordersModule, id: 'net.example.chess' };
    const report = auditGame(other, {
      gmPubkey: t.gmPubkey,
      start: t.start,
      states: t.states,
      moves: t.moves,
    });
    expect(report.ok).toBe(false);
    expect(report.findings.map((f) => f.code)).toContain('module_mismatch');
  });

  it('flags a broken seq chain instead of replaying a gap', async () => {
    const t = await play();
    const states = t.states.filter((e) => !e.content.includes('"seq":2'));
    const report = auditGame(ordersModule, {
      gmPubkey: t.gmPubkey,
      start: t.start,
      states,
      moves: t.moves,
    });
    expect(report.ok).toBe(false);
    expect(report.findings.map((f) => f.code)).toContain('seq_chain_broken');
  });
});

describe('auditGame with move revisions', () => {
  // Alice composes her move across the round, publishing three revisions
  // before settling; Bob and Carol submit once. NIP-GM §Move revisions.
  const revisedScript: ScriptedRound<OrdersMove>[] = [
    {
      moves: [
        {
          player: alice,
          move: { type: 'advance', distance: 3 } as OrdersMove,
          wire: ordersMove({ type: 'advance', distance: 3 }),
          drafts: [ordersMove({ type: 'hold' }), ordersMove({ type: 'advance', distance: 1 })],
        },
        {
          player: bob,
          move: { type: 'advance', distance: 1 } as OrdersMove,
          wire: ordersMove({ type: 'advance', distance: 1 }),
        },
        { player: carol, move: { type: 'hold' } as OrdersMove, wire: ordersMove({ type: 'hold' }) },
      ],
    },
  ];

  const playRevised = () =>
    runScriptedGame(ordersModule, {
      gm,
      players: [alice, bob, carol],
      config: CONFIG,
      rounds: revisedScript,
    });

  const audit = (t: Awaited<ReturnType<typeof playRevised>>, states = t.states) =>
    auditGame(ordersModule, {
      gmPubkey: t.gmPubkey,
      start: t.start,
      states,
      moves: t.moves,
    });

  it('accepts a round in which a player revised', async () => {
    const t = await playRevised();
    const report = audit(t);
    expect(report.findings.filter((f) => f.severity === 'error')).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it('publishes every superseded revision with its key', async () => {
    const t = await playRevised();
    const delta = JSON.parse(t.states[0].content);
    // Two drafts superseded; each must carry a key or the audit below is blind.
    expect(delta.superseded).toHaveLength(2);
    expect(delta.superseded.every((e: { key?: string }) => typeof e.key === 'string')).toBe(true);
  });

  it('does not mistake a superseded revision for a dropped move', async () => {
    // The failure this guards against is noisy rather than unsafe: every draft
    // would raise a warning, making the audit report useless for a game where
    // revision is the normal path.
    const t = await playRevised();
    expect(audit(t).findings.map((f) => f.code)).not.toContain('possible_dropped_move');
  });

  it('catches a GM that applies a stale revision', async () => {
    // The attack the reveal obligation exists to stop: Alice's rev 2 said
    // advance 3, but the GM applies her rev 0 (hold) instead — while still
    // publishing the higher revisions, because it must.
    const t = await playRevised();
    const delta = JSON.parse(t.states[0].content);

    const aliceApplied = delta.applied.find(
      (e: { id: string }) => t.moves.find((m) => m.id === e.id)?.pubkey === alice.pubkey,
    );
    const aliceDraft = delta.superseded.find(
      (e: { id: string }) => t.moves.find((m) => m.id === e.id)?.pubkey === alice.pubkey,
    );
    expect(aliceApplied && aliceDraft).toBeTruthy();

    // Swap the applied entry with a superseded one, keeping both cited.
    delta.applied = delta.applied.map((e: { id: string }) =>
      e.id === aliceApplied.id ? aliceDraft : e,
    );
    delta.superseded = delta.superseded
      .filter((e: { id: string }) => e.id !== aliceDraft.id)
      .concat(aliceApplied);

    const forged = await gm.signEvent({
      kind: t.states[0].kind,
      tags: t.states[0].tags,
      content: JSON.stringify(delta),
      pubkey: gm.pubkey,
      created_at: t.states[0].created_at,
    });

    const report = audit(t, [forged, ...t.states.slice(1)]);
    expect(report.ok).toBe(false);
    expect(report.findings.map((f) => f.code)).toContain('revision_not_highest');
  });

  it('flags omitted lower revisions without calling them fraud', async () => {
    // Dropping `superseded` from an otherwise honest delta is a spec violation,
    // not an attack: the applied move is still the highest. It should be
    // reported, but as uncited moves rather than as a wrong winner.
    const t = await playRevised();
    const delta = JSON.parse(t.states[0].content);
    delete delta.superseded;

    const forged = await gm.signEvent({
      kind: t.states[0].kind,
      tags: t.states[0].tags,
      content: JSON.stringify(delta),
      pubkey: gm.pubkey,
      created_at: t.states[0].created_at,
    });

    const report = audit(t, [forged, ...t.states.slice(1)]);
    const codes = report.findings.map((f) => f.code);
    expect(codes).toContain('possible_dropped_move');
    expect(codes).not.toContain('uncited_higher_revision');
  });

  it('catches a GM that applies a stale revision *and* hides the higher ones', async () => {
    // The stealthy version of the attack: apply Alice's rev 0 and omit revs 1
    // and 2 entirely, so `revision_not_highest` has nothing to compare against.
    //
    // It still fails, because Alice's whole round rides one ephemeral key: the
    // key the GM must reveal for the revision it *did* cite also decrypts the
    // ones it hid. Hiding the evidence is impossible once any key for that
    // round is out.
    const t = await playRevised();
    const delta = JSON.parse(t.states[0].content);

    const isAlice = (e: { id: string }) =>
      t.moves.find((m) => m.id === e.id)?.pubkey === alice.pubkey;
    const aliceDraft = delta.superseded.filter(isAlice)[0];

    delta.applied = delta.applied.map((e: { id: string }) => (isAlice(e) ? aliceDraft : e));
    delta.superseded = delta.superseded.filter((e: { id: string }) => !isAlice(e));

    const forged = await gm.signEvent({
      kind: t.states[0].kind,
      tags: t.states[0].tags,
      content: JSON.stringify(delta),
      pubkey: gm.pubkey,
      created_at: t.states[0].created_at,
    });

    const report = audit(t, [forged, ...t.states.slice(1)]);
    // Both hidden revisions outrank the applied rev 0, so both are reported.
    const hidden = report.findings.filter((f) => f.code === 'uncited_higher_revision');
    expect(hidden).toHaveLength(2);
    expect(hidden.some((f) => f.detail.includes('rev 2'))).toBe(true);
    expect(hidden.every((f) => f.detail.includes('the rev 0 the GM applied'))).toBe(true);
  });

  it('feeds the module exactly one move per player, and it is the last revision', async () => {
    // Revisions are transport, not game logic. Note this cannot be shown by
    // comparing a drafted run against an undrafted one: the extra events give
    // Alice's winning move a different event id, and event ids feed the
    // canonical ordering, so the two games legitimately diverge. The claim that
    // holds is about what reaches the engine.
    const t = await playRevised();
    const delta = JSON.parse(t.states[0].content);

    expect(delta.applied).toHaveLength(3);
    const authors = delta.applied.map(
      (e: { id: string }) => t.moves.find((m) => m.id === e.id)?.pubkey,
    );
    expect(new Set(authors).size).toBe(3);

    const aliceMove = delta.applied.find(
      (e: { id: string }) => t.moves.find((m) => m.id === e.id)?.pubkey === alice.pubkey,
    ).move;
    expect(aliceMove).toEqual(ordersMove({ type: 'advance', distance: 3 }));
  });

  describe('events published after the game is over', () => {
    // A finished game is a fixed record, but relays keep accepting events that
    // reference it. Anyone can publish more, forever, for free. The property
    // that has to hold is that none of it can change the audit's verdict.

    const forgeMove = async (
      t: Awaited<ReturnType<typeof playRevised>>,
      author: typeof alice,
      content: string,
      createdAt = 2_000_000_000,
    ) => {
      const { buildMove } = await import('nip-gm-core');
      return author.signEvent({
        ...buildMove(t.start.id, gm.pubkey, content),
        pubkey: author.pubkey,
        created_at: createdAt,
      });
    };

    it('ignores a stranger’s events entirely', async () => {
      // Not merely "does not fail" — produces no findings at all. A stranger
      // able to add warnings could smear an honest GM's record at will.
      const t = await playRevised();
      const mallory = signerFromSeed(99);
      const junk = await forgeMove(
        t,
        mallory,
        JSON.stringify({ seq: 1, prev: t.start.id, rev: 0, type: 'advance', data: {} }),
      );

      const before = audit(t).findings;
      const after = audit(t);
      expect(after.findings).toEqual(before);
      expect(after.ok).toBe(true);
      void junk;
      expect(
        auditGame(ordersModule, {
          gmPubkey: t.gmPubkey,
          start: t.start,
          states: t.states,
          moves: [...t.moves, junk],
        }).findings,
      ).toEqual(before);
    });

    it('rejects an unsigned move at the gate rather than reporting it as dropped', async () => {
      // Everything the uncited-move pass reports has already been through
      // verifyEvent, because it iterates only events that made it into the
      // move index. An event with a bad signature must not reach it at all —
      // otherwise anyone could forge moves from a seated player's pubkey and
      // have them reported as revisions the GM dropped.
      const t = await playRevised();
      const real = await forgeMove(
        t,
        alice,
        JSON.stringify({ seq: 1, prev: t.start.id, rev: 999, type: 'advance', data: {} }),
      );
      const unsigned = { ...real, sig: 'f'.repeat(128) };

      const report = auditGame(ordersModule, {
        gmPubkey: t.gmPubkey,
        start: t.start,
        states: t.states,
        moves: [...t.moves, unsigned],
      });

      const codes = report.findings.map((f) => f.code);
      expect(codes).toContain('bad_move_signature');
      expect(codes).not.toContain('uncited_higher_revision');
      expect(report.ok).toBe(true);
    });

    it('rejects a move whose content was altered under a valid signature', async () => {
      // A schnorr signature covers only the id, so checking the signature
      // without recomputing the hash would let this through.
      const t = await playRevised();
      const real = await forgeMove(
        t,
        alice,
        JSON.stringify({ seq: 1, prev: t.start.id, rev: 999, type: 'advance', data: {} }),
      );
      const tampered = {
        ...real,
        content: JSON.stringify({ seq: 1, prev: t.start.id, rev: 1000, type: 'hold', data: {} }),
      };

      const report = auditGame(ordersModule, {
        gmPubkey: t.gmPubkey,
        start: t.start,
        states: t.states,
        moves: [...t.moves, tampered],
      });

      expect(report.findings.map((f) => f.code)).toContain('bad_move_signature');
      expect(report.ok).toBe(true);
    });

    it('cannot flip a seated player’s late forgery into an audit failure', async () => {
      // Alice backdates a plaintext move claiming a huge rev for a closed
      // round. It is reported, because it might equally be a revision the GM
      // dropped — but it stays a warning and the game still verifies.
      const t = await playRevised();
      const late = await forgeMove(
        t,
        alice,
        JSON.stringify({ seq: 1, prev: t.start.id, rev: 999, type: 'advance', data: {} }),
        t.start.created_at + 1,
      );

      const report = auditGame(ordersModule, {
        gmPubkey: t.gmPubkey,
        start: t.start,
        states: t.states,
        moves: [...t.moves, late],
      });

      expect(report.findings.filter((f) => f.severity === 'error')).toEqual([]);
      expect(report.ok).toBe(true);
      expect(report.findings.map((f) => f.code)).toContain('uncited_higher_revision');
    });

    it('replays to the same state regardless of what was published afterwards', async () => {
      // The verdict and the state both come only from what the GM cited, so
      // later events cannot move them.
      const t = await playRevised();
      const late = await forgeMove(
        t,
        alice,
        JSON.stringify({ seq: 1, prev: t.start.id, rev: 999, type: 'advance', data: {} }),
      );

      const clean = audit(t);
      const polluted = auditGame(ordersModule, {
        gmPubkey: t.gmPubkey,
        start: t.start,
        states: t.states,
        moves: [...t.moves, late],
      });

      expect(canonicalJson(polluted.state)).toBe(canonicalJson(clean.state));
      expect(polluted.rounds).toBe(clean.rounds);
    });
  });

  it('reproduces the game id when the seed and start time are pinned', async () => {
    // Only the start event is reproducible, and that is the part fixtures need
    // — the game id is what every other event roots to.
    //
    // The move log deliberately is not: each move draws a fresh ephemeral
    // keypair and NIP-44 picks a random nonce, so ciphertexts and therefore
    // event ids differ per run. Under an id-sensitive resolution order that
    // also makes the final state differ, so two harness runs are self-consistent
    // games rather than the same game. Anything needing a fixed log must pin
    // event ids itself, which is why vectors/games/orders.json is a GameLog of
    // synthetic ids rather than harness output.
    const opts = {
      gm,
      players: [alice, bob, carol],
      config: CONFIG,
      rounds: revisedScript,
      seed: new Uint8Array(32).fill(7),
      salt: new Uint8Array(32).fill(8),
      startedAt: 1_700_000_000,
    };
    const a = await runScriptedGame(ordersModule, opts);
    const b = await runScriptedGame(ordersModule, opts);
    expect(a.start.id).toBe(b.start.id);
    expect(a.moves.map((m) => m.id)).not.toEqual(b.moves.map((m) => m.id));
  });
});
