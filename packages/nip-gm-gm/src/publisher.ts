/**
 * The GM's one way out to the relays: sign, stamp, publish.
 *
 * It exists for a single non-obvious reason. `created_at` is in **whole
 * seconds**, and NIP-01 says that when a relay holds two versions of the same
 * replaceable or addressable event it keeps the one with the greater
 * `created_at` — and on a tie, the one with the lexically lowest id. It does not
 * keep the one that arrived last.
 *
 * The GM republishes addressable events constantly. A lobby is rewritten on
 * every join, leave and ready; the game head is rewritten on every snapshot. All
 * of that happens far faster than once a second, so with a bare `clock.now()`
 * stamp most of those rewrites carry a `created_at` equal to the version already
 * stored — and the relay silently drops them. Nothing errors. The GM believes it
 * published a two-player lobby; every client still reads the one-player version
 * it published a few milliseconds earlier and waits forever for a game that,
 * from its point of view, never fills up.
 *
 * Last-write-wins is the obvious implementation of a relay and it is wrong, so
 * this used to be visible only against a real one. `nip-gm-testing`'s in-memory
 * relay now applies the NIP-01 rule properly — greater `created_at` wins, ties
 * to the lower id, and a refused replacement is not forwarded to live
 * subscribers either — so the regression tests for this live in the fast suite.
 *
 * So every addressable/replaceable event is stamped `max(now, lastSeen + 1)` per
 * coordinate. The cost is a clock that can run a few seconds ahead of the wall
 * during a burst of updates, which is harmless — these events are current-state
 * documents, not log entries, and the log kinds (moves, deltas, responses) are
 * regular events that keep the true timestamp.
 */
import type { Clock, Hex, NostrEvent, Signer, Transport } from 'nip-gm-core';

export interface EventTemplate {
  kind: number;
  tags: string[][];
  content: string;
}

export interface Publisher {
  /** Stamp, sign and publish. The whole job, for everything that can be lost. */
  (template: EventTemplate): Promise<NostrEvent>;
  /**
   * Stamp and sign, but do not publish.
   *
   * The half a durable GM needs. A signed event's id is a hash of its own
   * content, so an event written down before it is sent can be sent again after
   * a crash and the relay sees the same event rather than a second one. Building
   * it afresh instead would take a new `created_at`, produce a new id, and leave
   * two deltas at one `seq` — which is not a duplicate, it is a fork in the log,
   * signed by the GM, and it is what `auditGame` reports as `seq_chain_broken`.
   *
   * The monotonic guard applies here rather than in `send`, because it belongs
   * to the timestamp and the timestamp is fixed at signing.
   */
  prepare(template: EventTemplate): Promise<NostrEvent>;
  /** Publish an already-prepared event. Safe to call twice: same bytes, same id. */
  send(event: NostrEvent): Promise<NostrEvent>;
}

/** NIP-01: 30000–39999 are addressable, keyed by `kind:pubkey:d`. */
function isAddressable(kind: number): boolean {
  return kind >= 30000 && kind < 40000;
}

/** NIP-01: 10000–19999 are replaceable, as are the legacy kinds 0 and 3. */
function isReplaceable(kind: number): boolean {
  return kind === 0 || kind === 3 || (kind >= 10000 && kind < 20000);
}

/**
 * The relay's replacement key for an event, or undefined if the event is not
 * subject to replacement (regular and ephemeral kinds, which simply accumulate).
 */
function coordinate(pubkey: Hex, template: EventTemplate): string | undefined {
  if (isReplaceable(template.kind)) return `${template.kind}:${pubkey}`;
  if (!isAddressable(template.kind)) return undefined;
  const d = template.tags.find((tag) => tag[0] === 'd')?.[1] ?? '';
  return `${template.kind}:${pubkey}:${d}`;
}

export interface PublisherOptions {
  transport: Transport;
  signer: Signer;
  clock: Clock;
  /**
   * Resolved lazily: `createGM` builds its publisher before it has awaited
   * `signer.getPublicKey()`, and threading the same publisher through the lobby
   * manager and every runner is what keeps the monotonic guard shared.
   */
  pubkey(): Hex;
  /**
   * Watermarks carried over from a previous process, coordinate → `created_at`.
   *
   * The guard below is per-process state, and the drift it deliberately
   * accumulates outlives the process that accumulated it: a burst of lobby
   * rewrites leaves the stored `created_at` seconds ahead of the wall clock, and
   * a GM that restarts inside that window stamps its first rewrite *behind* what
   * the relay already holds. The relay drops it, silently, and every client goes
   * on reading the older lobby. Restoring the map is what closes that.
   */
  watermarks?: Iterable<readonly [string, number]>;
  /**
   * Called with each new watermark, before the event carrying it is signed.
   *
   * Synchronous by contract. This sits on the path of every lobby rewrite and
   * every head, and an `await` between reading `lastAt` and writing it would let
   * two publishes interleave and both decide they were first — the exact race
   * this file exists to prevent.
   */
  onStamp?(coordinate: string, createdAt: number): void;
}

export function createPublisher(options: PublisherOptions): Publisher {
  const { transport, signer, clock } = options;
  const lastAt = new Map<string, number>(options.watermarks ?? []);

  const prepare = async (template: EventTemplate): Promise<NostrEvent> => {
    const pubkey = options.pubkey();
    const key = coordinate(pubkey, template);

    let createdAt = clock.now();
    if (key !== undefined) {
      const previous = lastAt.get(key);
      if (previous !== undefined && previous >= createdAt) createdAt = previous + 1;
      lastAt.set(key, createdAt);
      options.onStamp?.(key, createdAt);
    }

    return signer.signEvent({ ...template, pubkey, created_at: createdAt });
  };

  const send = async (event: NostrEvent): Promise<NostrEvent> => {
    await transport.publish(event);
    return event;
  };

  // A callable with two extra members rather than an object with three methods:
  // every existing call site is `await publish(template)`, and this keeps them
  // all working while the durable paths reach for the halves.
  return Object.assign(
    async (template: EventTemplate): Promise<NostrEvent> => send(await prepare(template)),
    { prepare, send },
  );
}
