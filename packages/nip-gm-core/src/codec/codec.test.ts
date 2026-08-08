import { describe, expect, it } from 'vitest';
import { KIND } from '../kinds.js';
import type { EventTemplate, Hex, NostrEvent } from '../types.js';
import { buildAnnouncement, parseAnnouncement } from './announcement.js';
import { buildDiscoveryOffer, buildDiscoveryRequest, parseDiscovery } from './discovery.js';
import { buildHead, parseHead } from './head.js';
import { buildLobby, canStart, acceptsJoins, parseLobby, type Lobby } from './lobby.js';
import {
  buildLobbyAction,
  buildMove,
  buildResponse,
  parseMessage,
  parseResponseBody,
} from './message.js';
import { buildDelta, buildEnd, buildPrivate, buildStart, parseState } from './state.js';
import { canonicalJson } from './json.js';

const A = 'a'.repeat(64) as Hex;
const B = 'b'.repeat(64) as Hex;
const C = 'c'.repeat(64) as Hex;
const GM = 'd'.repeat(64) as Hex;
const GAME = 'e'.repeat(64) as Hex;

/** Wrap a template as a signed event; id/sig are irrelevant to codecs. */
function signed(template: EventTemplate, pubkey: Hex = GM): NostrEvent {
  return { ...template, pubkey, created_at: 1_700_000_000, id: '0'.repeat(64), sig: '1'.repeat(64) };
}

function unwrap<T>(result: { ok: true; value: T } | { ok: false; error: string }): T {
  if (!result.ok) throw new Error(`expected ok, got ${result.error}`);
  return result.value;
}

describe('announcement (32600)', () => {
  const announcement = {
    game: 'com.example.holdem',
    version: '1.2.0',
    rulesHash: 'f'.repeat(64),
    relays: ['wss://relay1.example', 'wss://relay2.example'],
    modes: ['verified', 'casual'] as const,
    config: {
      name: 'Ace GM',
      about: "Hosted hold'em since 2026.",
      maxConcurrentGames: 50,
      capabilities: ['create', 'hot-join', 'spectate'],
    },
  };

  it('round-trips', () => {
    const parsed = unwrap(parseAnnouncement(signed(buildAnnouncement({ ...announcement }))));
    expect(parsed).toEqual({ ...announcement, modes: ['verified', 'casual'], config: { ...announcement.config, icon: undefined } });
  });

  it('puts multiple relays in one tag, per the spec example', () => {
    const built = buildAnnouncement({ ...announcement });
    expect(built.tags).toContainEqual(['relays', 'wss://relay1.example', 'wss://relay2.example']);
    expect(built.tags).toContainEqual(['modes', 'verified', 'casual']);
  });

  it('defaults an absent modes tag to verified rather than to nothing', () => {
    const built = buildAnnouncement({ ...announcement, modes: [] });
    expect(unwrap(parseAnnouncement(signed(built))).modes).toEqual(['verified']);
  });

  it.each([
    ['wrong kind', { ...signed(buildAnnouncement({ ...announcement })), kind: 1 }, 'wrong_kind'],
    ['no d tag', signed({ kind: KIND.GM_ANNOUNCEMENT, tags: [['version', '1.0.0']], content: '{"name":"x"}' }), 'missing_d'],
    ['no version', signed({ kind: KIND.GM_ANNOUNCEMENT, tags: [['d', 'g']], content: '{"name":"x"}' }), 'missing_version'],
    ['bad json', signed({ kind: KIND.GM_ANNOUNCEMENT, tags: [['d', 'g'], ['version', '1']], content: '{' }), 'malformed_json'],
    ['no name', signed({ kind: KIND.GM_ANNOUNCEMENT, tags: [['d', 'g'], ['version', '1']], content: '{}' }), 'missing_name'],
  ])('rejects %s', (_label, event, error) => {
    expect(parseAnnouncement(event as NostrEvent)).toEqual({ ok: false, error });
  });
});

describe('lobby (32601)', () => {
  const lobby: Lobby = {
    lobbyId: 'friday-poker',
    game: 'com.example.holdem',
    version: '1.2.0',
    visibility: 'public',
    join: 'before',
    start: { kind: 'ready' },
    status: 'open',
    players: [
      { pubkey: A, state: 'ready' },
      { pubkey: B, state: 'joined' },
    ],
    relays: ['wss://relay1.example'],
    config: {
      name: 'Friday Poker',
      mode: 'verified',
      minPlayers: 2,
      maxPlayers: 6,
      turnTimeout: 60,
      timeoutAction: 'fold',
      snapshotInterval: 10,
      spectatorDelay: 30,
      config: { blinds: [1, 2] },
    },
  };

  it('round-trips', () => {
    expect(unwrap(parseLobby(signed(buildLobby(lobby))))).toEqual(lobby);
  });

  it('preserves player order, which becomes seat order at start', () => {
    const reordered: Lobby = { ...lobby, players: [lobby.players[1], lobby.players[0]] };
    expect(unwrap(parseLobby(signed(buildLobby(reordered)))).players.map((p) => p.pubkey)).toEqual([
      B,
      A,
    ]);
  });

  it('round-trips each start condition', () => {
    for (const start of [
      { kind: 'ready' as const },
      { kind: 'timer' as const, seconds: 120 },
      { kind: 'leader' as const },
    ]) {
      const withLeader: Lobby = { ...lobby, start, leader: start.kind === 'leader' ? A : undefined };
      expect(unwrap(parseLobby(signed(buildLobby(withLeader)))).start).toEqual(start);
    }
  });

  it('rejects a leader-start lobby with no leader, since it could never start', () => {
    const built = buildLobby({ ...lobby, start: { kind: 'leader' } });
    expect(parseLobby(signed(built))).toEqual({ ok: false, error: 'missing_leader' });
  });

  it('carries the game id once active', () => {
    const active: Lobby = { ...lobby, status: 'active', gameId: GAME };
    expect(unwrap(parseLobby(signed(buildLobby(active)))).gameId).toBe(GAME);
  });

  it.each([
    ['timer:', undefined],
    ['timer:abc', undefined],
    ['timer:-5', undefined],
    ['nonsense', undefined],
  ])('rejects malformed start condition %s', (raw) => {
    const built = buildLobby(lobby);
    const tags = built.tags.map((t) => (t[0] === 'start' ? ['start', raw] : t));
    expect(parseLobby(signed({ ...built, tags }))).toEqual({ ok: false, error: 'bad_start' });
  });

  describe('behaviours', () => {
    it('accepts joins while open and below capacity', () => {
      expect(acceptsJoins(lobby)).toBe(true);
      expect(acceptsJoins({ ...lobby, status: 'active' })).toBe(false);
      expect(acceptsJoins({ ...lobby, status: 'active', join: 'anytime' })).toBe(true);
    });

    it('refuses joins at capacity', () => {
      const full: Lobby = { ...lobby, config: { ...lobby.config, maxPlayers: 2 } };
      expect(acceptsJoins(full)).toBe(false);
    });

    it('starts on ready only when everyone is ready', () => {
      expect(canStart(lobby)).toBe(false);
      const allReady: Lobby = {
        ...lobby,
        players: lobby.players.map((p) => ({ ...p, state: 'ready' as const })),
      };
      expect(canStart(allReady)).toBe(true);
    });

    it('respects min_players', () => {
      const solo: Lobby = {
        ...lobby,
        players: [{ pubkey: A, state: 'ready' }],
        config: { ...lobby.config, minPlayers: 2 },
      };
      expect(canStart(solo)).toBe(false);
    });

    it('starts on timer once elapsed', () => {
      const timed: Lobby = {
        ...lobby,
        start: { kind: 'timer', seconds: 60 },
        players: lobby.players.map((p) => ({ ...p, state: 'joined' as const })),
      };
      expect(canStart(timed, 1_000_059, 1_000_000)).toBe(false);
      expect(canStart(timed, 1_000_060, 1_000_000)).toBe(true);
    });
  });
});

describe('discovery (21602)', () => {
  it('round-trips a request', () => {
    const parsed = unwrap(parseDiscovery(signed(buildDiscoveryRequest('com.example.holdem', '1.2.0'))));
    expect(parsed).toEqual({ type: 'request', game: 'com.example.holdem', version: '1.2.0' });
  });

  it('round-trips an offer, distinguished by its e tag', () => {
    const offer = {
      requestId: GAME,
      player: A,
      announcement: { kind: KIND.GM_ANNOUNCEMENT, pubkey: GM, identifier: 'com.example.holdem' },
      capacity: 12,
    };
    expect(unwrap(parseDiscovery(signed(buildDiscoveryOffer(offer))))).toEqual({
      type: 'offer',
      ...offer,
    });
  });

  it('accepts capacity 0 as "full" rather than treating it as absent', () => {
    const built = buildDiscoveryOffer({
      requestId: GAME,
      player: A,
      announcement: { kind: KIND.GM_ANNOUNCEMENT, pubkey: GM, identifier: 'g' },
      capacity: 0,
    });
    const parsed = unwrap(parseDiscovery(signed(built)));
    expect(parsed.type === 'offer' && parsed.capacity).toBe(0);
  });

  it('rejects an offer whose a-tag points at the wrong kind', () => {
    const built = buildDiscoveryOffer({
      requestId: GAME,
      player: A,
      announcement: { kind: KIND.LOBBY, pubkey: GM, identifier: 'g' },
      capacity: 1,
    });
    expect(parseDiscovery(signed(built))).toEqual({ ok: false, error: 'wrong_announcement_kind' });
  });
});

describe('messages (2600)', () => {
  it('round-trips a move', () => {
    const built = buildMove(GAME, GM, '{"seq":12}', { ephemeral: B });
    const parsed = unwrap(parseMessage(signed(built, A)));
    expect(parsed).toEqual({
      action: 'move',
      gameId: GAME,
      recipient: GM,
      ephemeral: B,
      content: '{"seq":12}',
    });
  });

  it('round-trips lobby actions and the leader start intent', () => {
    const lobby = { kind: KIND.LOBBY, pubkey: GM, identifier: 'friday' };
    for (const action of ['join', 'leave', 'ready'] as const) {
      const parsed = unwrap(parseMessage(signed(buildLobbyAction(action, lobby, GM), A)));
      expect(parsed.action).toBe(action);
    }
    const ready = buildLobbyAction('ready', lobby, GM, '', { intent: 'start' });
    const parsed = unwrap(parseMessage(signed(ready, A)));
    expect(parsed.action === 'ready' && parsed.intent).toBe('start');
  });

  it('distinguishes the answered message from the game root in a response', () => {
    // A response carries an unmarked `e` (the message) and a root `e` (the
    // game); conflating them would misroute every rejection.
    const target = 'f'.repeat(64) as Hex;
    const built = buildResponse(target, A, { status: 'rejected', reason: 'not_your_turn' }, { gameId: GAME });
    const parsed = unwrap(parseMessage(signed(built)));
    expect(parsed).toMatchObject({ action: 'response', target, gameId: GAME, recipient: A });
  });

  it('round-trips response bodies', () => {
    expect(unwrap(parseResponseBody(JSON.stringify({ status: 'accepted', lobby: 'x' })))).toEqual({
      status: 'accepted',
      lobby: 'x',
    });
    expect(unwrap(parseResponseBody(JSON.stringify({ status: 'applied', state: GAME })))).toEqual({
      status: 'applied',
      state: GAME,
    });
    expect(parseResponseBody('{"status":"applied","state":"nope"}')).toEqual({
      ok: false,
      error: 'bad_state',
    });
    expect(parseResponseBody('{"status":"weird"}')).toEqual({ ok: false, error: 'bad_status' });
  });

  it('rejects an unknown action rather than guessing', () => {
    const event = signed({
      kind: KIND.MESSAGE,
      tags: [['action', 'teleport'], ['p', GM]],
      content: '',
    });
    expect(parseMessage(event)).toEqual({ ok: false, error: 'unknown_action' });
  });

  it('parses the ephemeral mirror kind too', () => {
    const built = buildMove(GAME, GM, '{}', { mode: 'casual' });
    expect(built.kind).toBe(KIND.MESSAGE_EPHEMERAL);
    expect(parseMessage(signed(built, A)).ok).toBe(true);
  });
});

describe('state (2601)', () => {
  it('round-trips a start event and preserves seat order', () => {
    const start = {
      lobby: { kind: KIND.LOBBY, pubkey: GM, identifier: 'friday' },
      seats: [C, A, B],
      game: 'com.example.holdem',
      version: '1.2.0',
      content: { config: { blinds: [1, 2] }, seedCommit: 'f'.repeat(64) },
    };
    const parsed = unwrap(parseState(signed(buildStart(start))));
    expect(parsed.type).toBe('start');
    // Seat order is C, A, B — deliberately not sorted.
    expect(parsed.type === 'start' && parsed.seats).toEqual([C, A, B]);
  });

  it('round-trips a delta with simultaneous-round reveals', () => {
    const delta = {
      gameId: GAME,
      seq: 13,
      awaiting: [A, B],
      content: {
        seq: 13,
        applied: [
          { id: 'a'.repeat(64), move: { type: 'bid', data: { amount: 40 } }, key: 'ab12' },
          { id: 'b'.repeat(64), move: { type: 'bid', data: { amount: 10 } }, key: 'cd34' },
        ],
        patch: { pot: 50 },
        system: null,
      },
    };
    expect(unwrap(parseState(signed(buildDelta(delta))))).toEqual({ type: 'delta', ...delta });
  });

  it('accepts bare move ids in applied, for public-move games', () => {
    const built = buildDelta({
      gameId: GAME,
      seq: 1,
      awaiting: [A],
      content: { seq: 1, applied: [{ id: A }], patch: {}, system: null },
    });
    const raw = JSON.parse(built.content);
    raw.applied = [A]; // the bare-id form from the spec
    const parsed = unwrap(parseState(signed({ ...built, content: JSON.stringify(raw) })));
    expect(parsed.type === 'delta' && parsed.content.applied).toEqual([{ id: A }]);
  });

  it('rejects a delta whose tag seq and content seq disagree', () => {
    // Otherwise a GM could show one ordering to filtering relays and another to
    // replaying auditors.
    const built = buildDelta({
      gameId: GAME,
      seq: 13,
      awaiting: [],
      content: { seq: 13, applied: [], patch: {}, system: null },
    });
    const content = JSON.stringify({ ...JSON.parse(built.content), seq: 99 });
    expect(parseState(signed({ ...built, content }))).toEqual({ ok: false, error: 'seq_mismatch' });
  });

  it('leaves private content as ciphertext instead of trying to parse it', () => {
    const built = buildPrivate({ gameId: GAME, seq: 4, recipient: A, content: 'not-json-at-all' });
    const parsed = unwrap(parseState(signed(built)));
    expect(parsed).toEqual({
      type: 'private',
      gameId: GAME,
      seq: 4,
      recipient: A,
      content: 'not-json-at-all',
    });
  });

  it('round-trips end with seed reveal', () => {
    const end = {
      gameId: GAME,
      players: [A, B],
      content: {
        result: { winners: [A] },
        seed: 'ab'.repeat(32),
        salt: 'cd'.repeat(16),
        keyReveals: { [A]: 'deadbeef' },
      },
    };
    const parsed = unwrap(parseState(signed(buildEnd(end))));
    expect(parsed).toEqual({ type: 'end', ...end, content: { ...end.content, reason: undefined } });
  });

  it('keeps lifecycle events on the regular kind even in casual mode', () => {
    // NIP-GM §End and abort — every game leaves a permanent record.
    expect(buildStart({ lobby: { kind: KIND.LOBBY, pubkey: GM, identifier: 'x' }, seats: [A], game: 'g', version: '1', content: { config: {} } }, 'casual').kind).toBe(KIND.STATE);
    expect(buildEnd({ gameId: GAME, players: [A], content: {} }).kind).toBe(KIND.STATE);
    // ...while deltas do move to the ephemeral mirror.
    expect(buildDelta({ gameId: GAME, seq: 1, awaiting: [], content: { seq: 1, applied: [], patch: {}, system: null } }, { mode: 'casual' }).kind).toBe(KIND.STATE_EPHEMERAL);
  });

  it('rejects a start event with no seats', () => {
    const built = buildStart({
      lobby: { kind: KIND.LOBBY, pubkey: GM, identifier: 'x' },
      seats: [],
      game: 'g',
      version: '1',
      content: { config: {} },
    });
    expect(parseState(signed(built))).toEqual({ ok: false, error: 'no_seats' });
  });
});

describe('head (32602)', () => {
  const head = { gameId: GAME, seq: 42, game: 'com.example.holdem', version: '1.2.0', state: { pot: 100 } };

  it('round-trips', () => {
    expect(unwrap(parseHead(signed(buildHead(head))))).toEqual(head);
  });

  it('serializes state with canonical key order', () => {
    const a = buildHead({ ...head, state: { b: 1, a: 2 } });
    const b = buildHead({ ...head, state: { a: 2, b: 1 } });
    expect(a.content).toBe(b.content);
  });

  it('rejects a head with no state field', () => {
    const built = buildHead(head);
    const content = JSON.stringify({ seq: head.seq });
    expect(parseHead(signed({ ...built, content }))).toEqual({ ok: false, error: 'missing_state' });
  });
});

describe('canonicalJson', () => {
  it('sorts keys recursively so equal values yield equal bytes', () => {
    expect(canonicalJson({ b: { d: 1, c: 2 }, a: [{ z: 1, y: 2 }] })).toBe(
      '{"a":[{"y":2,"z":1}],"b":{"c":2,"d":1}}',
    );
  });
});
