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
 * An in-memory relay does not reproduce this: last-write-wins is the obvious
 * implementation, and it is wrong. Only a real relay shows it.
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
  (template: EventTemplate): Promise<NostrEvent>;
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
}

export function createPublisher(options: PublisherOptions): Publisher {
  const { transport, signer, clock } = options;
  const lastAt = new Map<string, number>();

  return async (template: EventTemplate): Promise<NostrEvent> => {
    const pubkey = options.pubkey();
    const key = coordinate(pubkey, template);

    let createdAt = clock.now();
    if (key !== undefined) {
      const previous = lastAt.get(key);
      if (previous !== undefined && previous >= createdAt) createdAt = previous + 1;
      lastAt.set(key, createdAt);
    }

    const event = await signer.signEvent({ ...template, pubkey, created_at: createdAt });
    await transport.publish(event);
    return event;
  };
}
