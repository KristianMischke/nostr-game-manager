/**
 * A `GMStore` that lives in a Map, for testing resume without a database.
 *
 * A real implementation, in the same sense that `createMemoryRelay` is a real
 * relay: it enforces the invariants a SQL schema would enforce, so a GM that
 * would corrupt a database fails here instead of passing and failing in
 * production. In particular it refuses a second delta at a `seq` it has already
 * seen one for — the unique index a durable store is expected to carry — because
 * that failure is the entire reason the sign-then-commit-then-send order in
 * `store.ts` exists, and a store that shrugged at it would leave the rule
 * untested.
 *
 * Two things it deliberately does *not* emulate. It is not durable, so it cannot
 * show a torn write; a test that wants one wraps this and throws. And it holds
 * live object references rather than rows, so anything that survives only by
 * reference would pass here and fail against JSON — which is why everything
 * written in is cloned on the way through.
 */
import type {
  GMStore,
  Outgoing,
  PersistedGM,
  RoundCommit,
  StoredGame,
  StoredLobby,
  StoredRevision,
  StoredRound,
} from 'nip-gm-gm';
import type { Hex } from 'nip-gm-core';

/**
 * Everything crosses the boundary as JSON would carry it.
 *
 * The point of a store is that its contents outlive the objects that produced
 * them. Handing back the same object the GM put in would let a resume "work" on
 * a shared reference the GM was still mutating — the one bug a memory
 * implementation exists to not have.
 */
function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export interface MemoryStore extends GMStore {
  /** Signed events still waiting to be sent. For asserting on a torn write. */
  readonly unsent: readonly Outgoing[];
  /** Every event this store was ever asked to send, in order. */
  readonly outgoing: readonly Outgoing[];
}

export function createMemoryStore(): MemoryStore {
  const watermarks = new Map<string, number>();
  const lobbies = new Map<string, StoredLobby>();
  const games = new Map<Hex, StoredGame>();
  const rounds = new Map<Hex, StoredRound>();
  const revisions = new Map<Hex, StoredRevision[]>();
  const outbox = new Map<Hex, Outgoing & { sent: boolean }>();
  const handled = new Set<Hex>();
  /** `${gameId}:${seq}` for every delta ever queued. The unique index. */
  const deltas = new Set<string>();

  let owner: Hex | undefined;
  let sequence = 0;

  const enqueue = (out: Outgoing): void => {
    if (out.purpose === 'delta') {
      const key = `${out.gameId}:${out.seq}`;
      if (deltas.has(key)) {
        throw new Error(
          `refusing a second delta at seq ${out.seq} of ${out.gameId}: ` +
            'the log would fork, and every audit of this game would fail',
        );
      }
      deltas.add(key);
    }
    if (!outbox.has(out.event.id)) outbox.set(out.event.id, { ...clone(out), sent: false });
  };

  return {
    async open(gmPubkey: Hex): Promise<PersistedGM> {
      if (owner && owner !== gmPubkey) {
        throw new Error(`store belongs to ${owner}, not ${gmPubkey}`);
      }
      owner = gmPubkey;

      // Back to the oldest open round, not to the last message seen: a GM with a
      // round open wants the moves that arrived while it was down, and those are
      // older than its shutdown.
      const openedAt = [...rounds.values()].map((r) => r.openedAt);

      return {
        watermarks: [...watermarks.entries()],
        lobbies: clone([...lobbies.values()]),
        games: clone([...games.values()].filter((g) => g.endedAt === undefined)),
        ...(openedAt.length ? { inboxSince: Math.min(...openedAt) } : {}),
      };
    },

    async close(): Promise<void> {},

    stamp(coordinate: string, createdAt: number): void {
      watermarks.set(coordinate, createdAt);
    },

    async wasHandled(eventId: Hex): Promise<boolean> {
      return handled.has(eventId);
    },

    async markHandled(eventId: Hex): Promise<void> {
      handled.add(eventId);
    },

    async nextLobbySequence(): Promise<number> {
      return sequence++;
    },

    async putLobby(lobby): Promise<void> {
      lobbies.set(lobby.identifier, clone(lobby));
      if (lobby.cause) handled.add(lobby.cause);
    },

    async dropLobby(identifier: string): Promise<void> {
      lobbies.delete(identifier);
    },

    async beginGame(game, start, lobby): Promise<void> {
      games.set(game.gameId, clone(game));
      lobbies.set(lobby.identifier, clone(lobby));
      enqueue(start);
      if (game.cause) handled.add(game.cause);
    },

    async loadRound(gameId: Hex) {
      const round = rounds.get(gameId);
      if (!round) return undefined;
      return clone({ round, revisions: revisions.get(gameId) ?? [] });
    },

    async openRound(round: StoredRound): Promise<void> {
      rounds.set(round.gameId, clone(round));
      revisions.set(round.gameId, []);
    },

    async acceptRevision(revision: StoredRevision): Promise<void> {
      const held = revisions.get(revision.gameId) ?? [];
      // Keyed by event id, because the same move event can legitimately be
      // offered twice — once live, once recovered from the relay after a restart.
      if (!held.some((r) => r.event.id === revision.event.id)) held.push(clone(revision));
      revisions.set(revision.gameId, held);
      if (revision.cause) handled.add(revision.cause);
    },

    async commitRound(commit: RoundCommit): Promise<void> {
      const game = games.get(commit.gameId);
      if (!game) throw new Error(`no such game: ${commit.gameId}`);

      // One transaction: the outbox entries go in with the snapshot that
      // justifies them, so a reader can never see a delta this store has no
      // memory of producing, nor a snapshot ahead of the delta that made it.
      for (const out of commit.outgoing) enqueue(out);

      games.set(commit.gameId, {
        ...game,
        snapshot: clone(commit.snapshot),
        ...(commit.result ? { result: clone(commit.result) } : {}),
        ...(commit.endedAt === undefined ? {} : { endedAt: commit.endedAt }),
      });

      rounds.delete(commit.gameId);
      revisions.delete(commit.gameId);
      if (commit.next) {
        rounds.set(commit.gameId, clone(commit.next));
        revisions.set(commit.gameId, []);
      }
      if (commit.cause) handled.add(commit.cause);
    },

    async pending(): Promise<Outgoing[]> {
      return clone([...outbox.values()].filter((o) => !o.sent).map(({ sent: _sent, ...o }) => o));
    },

    async markSent(eventId: Hex): Promise<void> {
      const held = outbox.get(eventId);
      if (held) held.sent = true;
    },

    get unsent(): readonly Outgoing[] {
      return [...outbox.values()].filter((o) => !o.sent).map(({ sent: _sent, ...o }) => o);
    },

    get outgoing(): readonly Outgoing[] {
      return [...outbox.values()].map(({ sent: _sent, ...o }) => o);
    },
  };
}
