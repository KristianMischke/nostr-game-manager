/**
 * Durable GM state: the port, and the rules for using it.
 *
 * A GM's memory holds three kinds of thing. Most of it — the roster, the board,
 * every move ever applied — is also on the relays, and a restart could in
 * principle read it back. Some of it is *only* here: the seed and salt behind a
 * game's `seed_commit`, and a lobby's join code, neither of which is ever
 * published. And a little of it is bookkeeping the relays could never carry: the
 * `created_at` watermark, which round is open, how far the inbox has been read.
 *
 * Lose the first and a restart is slow. Lose the second and a game is over: with
 * no seed there is no reveal, so the game cannot be honestly ended and cannot be
 * audited — `auditGame` returns `no_seed_reveal` and the log is worthless to
 * everyone, including the GM that wrote it. That asymmetry is why this exists.
 *
 * ## Three rules
 *
 * **1. Every method is one transaction.** There is no `flush()`, no write-behind
 * and no per-field setter. A method that resolves has committed; a crash during
 * one leaves nothing behind. Callers group writes by putting them in one call,
 * not by bracketing several.
 *
 * **2. Nothing the GM signs reaches a relay before the fact that it signed it is
 * durable.** Every history-bearing publish is `publish.prepare` → a store call
 * carrying the signed event *and* the state change it represents → `publish.send`
 * → {@link GMStore.markSent}. A crash anywhere in that resumes by re-sending the
 * bytes that were written down, which hash to the same id and therefore land on
 * the relay as the same event. Re-deriving the event instead would take a fresh
 * `created_at`, mint a second id, and leave two deltas at one `seq` — a fork in
 * the log, signed, and indistinguishable from a dishonest GM.
 *
 * **3. The store never sees a module type.** Rows hold `NostrEvent` JSON and
 * `module.serialize()` output. That is what lets one schema serve any game, and
 * what lets resume rebuild parsed state by re-running the code paths that
 * produced it rather than by maintaining a second representation of it.
 *
 * ## What it is not
 *
 * Not a cache, not an index, and not the audit log — the relays are that, and a
 * store that disagreed with them would be the bug rather than the backup. It is
 * the GM's own working memory, written down.
 */
import type { EngineSnapshot, GameResult, Hex, Lobby, LobbyConfig, NostrEvent } from 'nip-gm-core';

/**
 * The inbound event a write is the effect of.
 *
 * Recorded in the same transaction as the effect, so that a restart does not
 * act on a message it already acted on. It buys *at most one durable effect per
 * message*, which is the part that matters — no duplicate lobbies, no duplicate
 * revisions. It does not buy exactly-once handling, and cannot: publishing and
 * committing are not one atomic act, so a message whose response was lost is
 * indistinguishable from one never answered. Clients retry; responses are
 * harmless to repeat.
 */
export interface Caused {
  cause?: Hex;
}

/** A lobby as its GM must remember it, which is more than it publishes. */
export interface StoredLobby {
  identifier: string;
  /** Game module id — the `d` tag of the announcement this lobby answers. */
  module: string;
  openedAt: number;
  /**
   * The published lobby document, verbatim.
   *
   * Stored whole rather than field by field because it already carries the
   * roster in seat order, the `LobbyConfig` and the status, and because seat
   * order is covered by the GM's signature on the start event — a restored
   * lobby that reordered its players would deal a different game.
   */
  lobby: Lobby;
  /** Hex. On no relay until the end event reveals it. */
  seed: string;
  /** Hex. Likewise. */
  salt: string;
  /** Hex `sha256(seed || salt)`, as published in the start event. */
  commit: string;
  /**
   * The join code, in the clear.
   *
   * NIP-GM §Behaviors is explicit that this never appears in the lobby event, so
   * there is nowhere else it could come back from. It is the second reason this
   * file is as sensitive as a key file.
   */
  code?: string;
  gameId?: Hex;
}

/** A game in progress, at its last committed round. */
export interface StoredGame {
  gameId: Hex;
  lobbyId: string;
  /** The signed start event: seats, raw config and `seed_commit` all re-derive from it. */
  start: NostrEvent;
  lobbyConfig: LobbyConfig;
  seed: string;
  salt: string;
  /**
   * Everything the engine needs to carry on, or absent before the first round.
   *
   * Absent means seq 0: the game has been announced but nothing has been dealt,
   * and a resume re-runs `module.init` off the same seed to land on the same
   * board. Writing a snapshot at that point would mean serializing a state
   * nobody has published, to save a derivation that is deterministic anyway.
   */
  snapshot?: EngineSnapshot;
  result?: GameResult;
  /** Unix seconds. Set means the game is over and needs no runner. */
  endedAt?: number;
}

/** The round a game is waiting in. */
export interface StoredRound {
  gameId: Hex;
  seq: number;
  /**
   * Event id of the state event this round is played against.
   *
   * The game id for round 1, the previous delta's id after that. Every incoming
   * move's `prev` is compared against it, so a round reopened without it rejects
   * every move in it as stale — which looks to a player exactly like a GM that
   * has stopped working.
   */
  prev: Hex;
  awaiting: Hex[];
  openedAt: number;
  /** Absolute unix seconds, or null for an untimed round. */
  deadline: number | null;
}

/**
 * One accepted move revision, as it arrived.
 *
 * The raw signed event, not the decrypted move: resume feeds it back through the
 * same admission path that accepted it the first time, so the conversation key
 * is re-derived (ECDH is deterministic), the envelope is re-parsed and the move
 * is re-validated against the state it was validated against originally. The
 * cached `key` saves the derivation, nothing more.
 */
export interface StoredRevision extends Caused {
  gameId: Hex;
  seq: number;
  event: NostrEvent;
  player: Hex;
  rev: number;
  /** Hex NIP-44 conversation key, when the move was hidden. */
  key?: string;
}

/** A signed event that must reach the relay exactly once, ever. */
export interface Outgoing {
  event: NostrEvent;
  purpose: 'start' | 'delta' | 'private' | 'end' | 'abort';
  gameId?: Hex;
  seq?: number;
}

/** Everything one closing round changes, in a single transaction. */
export interface RoundCommit extends Caused {
  gameId: Hex;
  /** The engine's position *after* the round was applied. */
  snapshot: EngineSnapshot;
  result?: GameResult;
  endedAt?: number;
  /** Signed and not yet sent: the delta, then any private states, then the end. */
  outgoing: Outgoing[];
  /** `seq` of the round that just closed; its row and revisions go. */
  closed: number;
  /**
   * The round this one opens, written now rather than after the delta is sent.
   *
   * Its `prev` is the delta's id, which does not exist until the delta is
   * signed — so this is the earliest it can be written, and writing it here is
   * what makes a crash between sending the delta and opening the round a no-op.
   * Absent when the game ended.
   */
  next?: StoredRound;
}

/** What a restarting GM reads back. */
export interface PersistedGM {
  /** Coordinate → highest `created_at` stamped on it. Feeds the publisher. */
  watermarks: Array<[string, number]>;
  /** Lobbies that have not closed, including the ones whose games are running. */
  lobbies: StoredLobby[];
  /** Games with no `endedAt`. */
  games: StoredGame[];
  /**
   * The oldest inbox message still worth reading, or undefined for "from now".
   *
   * Not simply the last message handled: a GM with a round open wants the moves
   * that arrived while it was down, and those are older than its shutdown.
   */
  inboxSince?: number;
}

export interface GMStore {
  /**
   * Open, migrate, and bind to one identity.
   *
   * The pubkey is checked rather than merely recorded. A store holding another
   * GM's games is not a store to resume from — it would republish someone
   * else's lobbies under this key and fail to reveal seeds it does not have —
   * and finding that out at `open()` is much cheaper than finding it out four
   * rounds into a game.
   */
  open(gmPubkey: Hex): Promise<PersistedGM>;
  close(): Promise<void>;

  /** Record a new `created_at` for a replacement coordinate. See `publisher.ts`. */
  stamp(coordinate: string, createdAt: number): void;

  /** True if this inbound event has already had its effect committed. */
  wasHandled(eventId: Hex): Promise<boolean>;
  /** Record a message that changed nothing, so a restart does not reconsider it. */
  markHandled(eventId: Hex, createdAt: number): Promise<void>;

  /**
   * A number that never repeats for this store, for the lobby identifier.
   *
   * The identifier is an addressable event's `d` tag, so a repeat does not make
   * a mess — it makes the new lobby *replace* the old one on the relay. A
   * per-process counter repeats on every restart, which is why this is here.
   */
  nextLobbySequence(): Promise<number>;

  putLobby(lobby: StoredLobby & Caused): Promise<void>;
  /** Drop a closed lobby and anything hanging off it. */
  dropLobby(identifier: string): Promise<void>;

  /** The start event, the game's first row and the lobby's new status, atomically. */
  beginGame(game: StoredGame & Caused, start: Outgoing, lobby: StoredLobby): Promise<void>;
  /** The open round and its accepted revisions, or undefined between rounds. */
  loadRound(gameId: Hex): Promise<{ round: StoredRound; revisions: StoredRevision[] } | undefined>;
  openRound(round: StoredRound): Promise<void>;
  acceptRevision(revision: StoredRevision): Promise<void>;
  commitRound(commit: RoundCommit): Promise<void>;

  /** Signed but unsent, oldest first. Flushed before a resumed GM does anything else. */
  pending(): Promise<Outgoing[]>;
  markSent(eventId: Hex): Promise<void>;
}
