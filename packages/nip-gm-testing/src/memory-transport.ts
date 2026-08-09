/**
 * An in-process relay.
 *
 * This is what makes a full game — lobby, start, simultaneous rounds with
 * encrypted moves, per-round key reveals, end — run inside vitest with no
 * network and no container. It is not a mock: the GM and the client sessions
 * talk to it through the same `Transport` port they use against a real relay,
 * so a bug in filter construction or in ephemeral-vs-regular handling surfaces
 * here rather than at integration time.
 *
 * It implements the parts of NIP-01 that NIP-GM actually leans on:
 *
 * - **Storage classes.** Ephemeral kinds (20000–29999) are broadcast and never
 *   stored; replaceable and addressable kinds are overwritten in place. NIP-GM
 *   puts lobbies and heads on addressable kinds precisely so a client that joins
 *   late sees current membership without replaying joins, and puts `casual`-mode
 *   traffic and `status` on ephemeral kinds so it leaves no permanent trace.
 *   Getting those wrong silently is easy; getting them wrong loudly is the point
 *   of implementing them here.
 * - **Signature verification on publish**, as a real relay does — so a test that
 *   passes here cannot be relying on an unsigned or tampered event.
 *
 * Delivery is **synchronous**: by the time `publish()` resolves, every matching
 * open subscription has had `onEvent` called. That is stronger than a real relay
 * offers, and it is deliberate — it makes ordering in tests deterministic rather
 * than dependent on microtask scheduling. Code that would only work under that
 * guarantee is code that will break on a real relay, so sessions here still
 * treat arrival order as arbitrary.
 */
import {
  tagValue,
  verifyEvent,
  type Filter,
  type Hex,
  type NostrEvent,
  type SubscribeHandlers,
  type Subscription,
  type Transport,
} from 'nip-gm-core';

/** NIP-01 storage classes. */
export type EventClass = 'regular' | 'replaceable' | 'ephemeral' | 'addressable';

export function eventClass(kind: number): EventClass {
  if (kind === 0 || kind === 3 || (kind >= 10000 && kind < 20000)) return 'replaceable';
  if (kind >= 20000 && kind < 30000) return 'ephemeral';
  if (kind >= 30000 && kind < 40000) return 'addressable';
  return 'regular';
}

/**
 * Whether an event satisfies a filter.
 *
 * Exported because it is useful on its own for asserting what a subscription
 * *would* have matched, which is usually a sharper test than asserting on what
 * arrived.
 */
export function matchesFilter(event: NostrEvent, filter: Filter): boolean {
  if (filter.ids && !filter.ids.includes(event.id)) return false;
  if (filter.authors && !filter.authors.includes(event.pubkey)) return false;
  if (filter.kinds && !filter.kinds.includes(event.kind)) return false;
  if (filter.since !== undefined && event.created_at < filter.since) return false;
  if (filter.until !== undefined && event.created_at > filter.until) return false;

  for (const [key, values] of Object.entries(filter)) {
    if (!key.startsWith('#') || values === undefined) continue;
    const wanted = values as string[];
    const name = key.slice(1);
    // Tag filters match a tag's first value only, and multiple filters AND while
    // the values within one OR.
    if (!event.tags.some((tag) => tag[0] === name && wanted.includes(tag[1]))) return false;
  }
  return true;
}

export function matchesAny(event: NostrEvent, filters: readonly Filter[]): boolean {
  return filters.some((f) => matchesFilter(event, f));
}

/** Newest first; ties by ascending id, so ordering never depends on insertion. */
function byRecency(a: NostrEvent, b: NostrEvent): number {
  return b.created_at - a.created_at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/** NIP-01 replacement: later `created_at` wins, ties go to the lower id. */
function supersedes(candidate: NostrEvent, held: NostrEvent): boolean {
  if (candidate.created_at !== held.created_at) return candidate.created_at > held.created_at;
  return candidate.id < held.id;
}

export interface MemoryRelay extends Transport {
  /** Every stored event, newest first. Ephemeral events never appear here. */
  stored(filters?: Filter[]): NostrEvent[];
  /** Everything ever published, in publication order — including ephemeral. */
  readonly log: readonly NostrEvent[];
  /** Open subscription count, for asserting that sessions clean up after themselves. */
  readonly subscriptions: number;
  reset(): void;
}

export function createMemoryRelay(): MemoryRelay {
  const events = new Map<Hex, NostrEvent>();
  /** `<kind>:<pubkey>[:<d>]` → the id currently occupying that slot. */
  const slots = new Map<string, Hex>();
  const published: NostrEvent[] = [];

  interface Sub {
    filters: Filter[];
    handlers: SubscribeHandlers;
    open: boolean;
  }
  const subs = new Set<Sub>();

  const slotKey = (event: NostrEvent, cls: EventClass): string | undefined => {
    if (cls === 'replaceable') return `${event.kind}:${event.pubkey}`;
    if (cls === 'addressable') return `${event.kind}:${event.pubkey}:${tagValue(event.tags, 'd') ?? ''}`;
    return undefined;
  };

  const store = (event: NostrEvent): void => {
    const cls = eventClass(event.kind);
    if (cls === 'ephemeral') return;

    const key = slotKey(event, cls);
    if (key === undefined) {
      events.set(event.id, event);
      return;
    }

    const heldId = slots.get(key);
    const held = heldId === undefined ? undefined : events.get(heldId);
    if (held && !supersedes(event, held)) return; // An older replacement is dropped.
    if (heldId !== undefined) events.delete(heldId);
    events.set(event.id, event);
    slots.set(key, event.id);
  };

  const matching = (filters: readonly Filter[]): NostrEvent[] => {
    const out = [...events.values()].filter((e) => matchesAny(e, filters)).sort(byRecency);
    // `limit` is per-filter in NIP-01; a single cap over the union is close
    // enough for the single-filter subscriptions this protocol issues, and the
    // approximation is documented rather than hidden.
    const limit = Math.min(...filters.map((f) => f.limit ?? Number.POSITIVE_INFINITY));
    return Number.isFinite(limit) ? out.slice(0, limit) : out;
  };

  return {
    async publish(event: NostrEvent): Promise<void> {
      if (!verifyEvent(event)) {
        throw new Error(`memory relay rejected event ${event.id.slice(0, 8)}: bad id or signature`);
      }
      published.push(event);
      store(event);

      // Copy: a handler may close its own subscription, or open another.
      for (const sub of [...subs]) {
        if (sub.open && matchesAny(event, sub.filters)) sub.handlers.onEvent(event);
      }
    },

    subscribe(filters: Filter[], handlers: SubscribeHandlers): Subscription {
      const sub: Sub = { filters, handlers, open: true };
      subs.add(sub);

      // Stored history first, then EOSE, then live — the order a real relay
      // uses, so a session that assumes it will behave the same over the wire.
      for (const event of matching(filters)) handlers.onEvent(event);
      handlers.onEose?.();

      return {
        close(): void {
          // Idempotent: React StrictMode double-unmounts.
          sub.open = false;
          subs.delete(sub);
        },
      };
    },

    async query(filters: Filter[]): Promise<NostrEvent[]> {
      return matching(filters);
    },

    stored(filters?: Filter[]): NostrEvent[] {
      return filters ? matching(filters) : [...events.values()].sort(byRecency);
    },

    get log(): readonly NostrEvent[] {
      return published;
    },

    get subscriptions(): number {
      return subs.size;
    },

    reset(): void {
      events.clear();
      slots.clear();
      published.length = 0;
      for (const sub of subs) sub.open = false;
      subs.clear();
    },
  };
}
