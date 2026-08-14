/**
 * The `Transport` port, over NDK.
 *
 * Three methods, and the interesting behaviour is in the corners: an idempotent
 * `close()`, a `query()` that resolves at EOSE rather than hanging forever, and
 * a relay set pinned to the GM's declared relays rather than to whatever the
 * user's pool happens to contain.
 */
import NDK, { NDKRelaySet, type NDKEvent, type NDKFilter } from '@nostr-dev-kit/ndk';
import type { Filter, NostrEvent, SubscribeHandlers, Subscription, Transport } from 'nip-gm-core';
import { toNDKEvent, toNostrEvent } from './event.js';

export interface NdkTransportOptions {
  /**
   * Relay URLs this transport reads and writes. NIP-GM §Relay Strategy makes
   * these mandatory rather than advisory: ephemeral kinds exist only for
   * currently-connected subscribers, so a client on the wrong relays does not
   * see a degraded game, it sees no game.
   */
  relays: string[];
  /**
   * An existing NDK instance to share. Pass the app's own so a game rides the
   * relay pool, cache and signer that are already connected — the reason NDK is
   * a peer dependency. Omit and one is constructed for the given relays.
   */
  ndk?: NDK;
}

export interface NdkTransport extends Transport {
  readonly ndk: NDK;
  /**
   * Connect the pool. Safe to call more than once; the underlying NDK call is
   * itself idempotent per relay. `publish`/`subscribe`/`query` all await this,
   * so calling it explicitly is only useful to front-load the handshake.
   */
  connect(): Promise<void>;
}

export function createTransport(options: NdkTransportOptions): NdkTransport {
  const { relays } = options;
  if (relays.length === 0) throw new Error('createTransport: at least one relay is required');

  const ndk = options.ndk ?? new NDK({ explicitRelayUrls: [...relays] });

  // Built lazily and cached: `fromRelayUrls` adds relays to the pool, which we
  // want to happen once, on first use, rather than at construction time.
  let relaySet: NDKRelaySet | undefined;
  const getRelaySet = (): NDKRelaySet => {
    relaySet ??= NDKRelaySet.fromRelayUrls(relays, ndk, true);
    return relaySet;
  };

  let connecting: Promise<void> | undefined;
  const connect = (): Promise<void> => {
    connecting ??= ndk.connect().then(() => {
      getRelaySet();
    });
    return connecting;
  };

  return {
    ndk,
    connect,

    async publish(event: NostrEvent): Promise<void> {
      await connect();
      const published = await toNDKEvent(ndk, event).publish(getRelaySet());
      // NDK resolves with the set of relays that accepted. An empty set means
      // the event reached nobody, which for a move or a round delta is a
      // failure the caller must see — `nip-gm-client` surfaces it as
      // `publish_failed` rather than leaving a player wondering why their move
      // never landed.
      if (published.size === 0) {
        throw new Error(`publish: no relay accepted event ${event.id}`);
      }
    },

    subscribe(filters: Filter[], handlers: SubscribeHandlers): Subscription {
      let closed = false;
      let sub: ReturnType<NDK['subscribe']> | undefined;

      void connect().then(() => {
        // The caller may have closed us during the connect handshake.
        if (closed) return;

        sub = ndk.subscribe(
          filters as NDKFilter[],
          {
            closeOnEose: false,
            // Grouping merges filters across subscriptions that look alike and
            // delays them to do it. A game session's subscriptions are neither
            // interchangeable nor latency-tolerant, so opt out.
            groupable: false,
          },
          getRelaySet(),
          false,
        );

        sub.on('event', (event: NDKEvent) => {
          if (closed) return;
          const converted = toNostrEvent(event);
          if (converted) handlers.onEvent(converted);
        });

        if (handlers.onEose) {
          sub.on('eose', () => {
            if (!closed) handlers.onEose?.();
          });
        }

        sub.start();

        // `start()` can deliver cached events synchronously, so re-check.
        if (closed) sub.stop();
      });

      return {
        close(): void {
          // Idempotent by contract — React StrictMode double-mounts, and the
          // subscription may not even exist yet if connect() is still pending.
          if (closed) return;
          closed = true;
          sub?.stop();
        },
      };
    },

    async query(filters: Filter[]): Promise<NostrEvent[]> {
      await connect();

      return new Promise<NostrEvent[]>((resolve) => {
        // Deduped by id: the same event arriving from three relays is one
        // event, and callers index the result by id.
        const seen = new Map<string, NostrEvent>();

        const sub = ndk.subscribe(
          filters as NDKFilter[],
          { closeOnEose: true, groupable: false },
          getRelaySet(),
          false,
        );

        let settled = false;
        const finish = (): void => {
          if (settled) return;
          settled = true;
          sub.stop();
          resolve([...seen.values()]);
        };

        sub.on('event', (event: NDKEvent) => {
          const converted = toNostrEvent(event);
          if (converted) seen.set(converted.id, converted);
        });
        sub.on('eose', finish);
        // A relay that never EOSEs would otherwise hang a session's `start()`
        // forever. Resolving with what we have is the right failure mode: the
        // client can still fold deltas from the live subscription.
        sub.on('close', finish);

        sub.start();
      });
    },
  };
}
