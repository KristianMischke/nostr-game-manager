# nostr-game-manager

A TypeScript implementation of [NIP-GM](./NIP-GM.md) — turn-based multiplayer
games over Nostr, with a Game Master client executing game logic, players
submitting signed moves, and anyone able to spectate or audit.

> Status: early. The protocol spec is a `draft` with open questions; the code is
> at milestone 4 of 8 — codec, commit-reveal crypto, the replay engine, the
> verifier and the determinism harness are in place, all pinned by vectors
> including the official NIP-44 suite. Relay transport, the GM daemon and the
> React bindings are not. Nothing is published yet.

Porting existing game logic into a module? See
[docs/porting-game-logic.md](docs/porting-game-logic.md).

## Packages

| Package | What it is |
|---|---|
| [`nip-gm-core`](packages/nip-gm-core) | Protocol codec, envelope semantics, commit-reveal crypto, the game-module contract, replay and verification. Zero I/O, no nostr library, no framework. |
| [`nip-gm-client`](packages/nip-gm-client) | Player and spectator sessions over injected ports, published through a framework-agnostic observable store. |
| [`nip-gm-gm`](packages/nip-gm-gm) | The GM runtime: lobby lifecycle, round resolution, timeouts as signed system inputs, snapshots, key reveals, crash recovery. |
| [`nip-gm-nostr`](packages/nip-gm-nostr) | `Transport`/`KeySigner` bindings over NDK. |
| [`nip-gm-react`](packages/nip-gm-react) | React provider and hooks. |
| [`nip-gm-testing`](packages/nip-gm-testing) | In-memory relay, manual clock, game harnesses, determinism checks, vector runner. |
| [`vectors/`](vectors) | Language-neutral JSON fixtures — the contract for ports to other languages. |

## Design

**Core is the port target.** It defines its own structural event types and never
imports a nostr library, a network, or a UI framework. That is what makes a
later C#/Rust/Python port mechanical, and it is enforced by lint rather than by
good intentions — see the dependency DAG in [`eslint.config.js`](eslint.config.js).

```
core ──┬── client ──── react
       ├── gm
       ├── nostr
       └── testing
```

**Game state never lives in a UI framework.** Sessions own an observable store;
`nip-gm-react` bridges it through `useSyncExternalStore` in about a hundred
lines. The same sessions drive the GM daemon, the verifier and headless tests
with no framework present, and a Solid binding would be equally thin.

**Determinism is structural, not advisory.** NIP-GM requires a module be a pure
function of `(config, seed, ordered inputs)`. Modules receive randomness through
`ctx.rng.at(seq, label)` and time through the input record — never ambient — so
the GM cannot grind for a favourable draw and an auditor can recompute every
value from the revealed seed.

**Ports are the only door outward.** Relays, keys and the clock all enter
through interfaces in `nip-gm-core/ports`. Note the deliberate split between
`Signer` (enough for a player; satisfiable by NIP-07 or a NIP-46 remote signer)
and `KeySigner` (adds raw conversation-key derivation, which a GM needs to
publish reveals). A GM therefore requires a local key, and the type system says
so rather than letting you find out at integration time.

## Development

```sh
pnpm install
pnpm build        # tsc per package
pnpm test         # vitest per package
pnpm typecheck
pnpm lint         # includes the package-boundary DAG check
```

Requires pnpm 9 and Node 20+.
