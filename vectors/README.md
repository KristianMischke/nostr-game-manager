# Test vectors

Language-neutral JSON fixtures. **This directory is the port contract.**

The reason this project is TypeScript-first rather than Rust-first is that the
thing which genuinely has to be shared across languages is not compiled code —
it is agreement on bytes. NIP-GM §Game Modules requires that two implementations
claiming the same `(game, version)` be move-for-move compatible, and
§Verification requires that an auditor in any language reproduce a GM's
derivations exactly. A corpus of `(input → expected output)` cases enforces both;
a shared binary would not, and would drag wasm or FFI packaging into every
target runtime.

A future C#/Rust/Python port is therefore a specified exercise: implement
`nip-gm-core`, run this corpus, go green.

Write vectors alongside the TypeScript implementation, never after.

## Layout

| Directory | Contents | Status |
|---|---|---|
| `codec/` | Event ⇄ parsed struct for every kind, including tag-order cases — `p` tag order is seat order. | 63 cases |
| `envelope/` | Move envelope parsing, and the revision-selection rule a GM and an auditor must agree on. | 17 cases |
| `nip44/` | The official NIP-44 v2 vectors, vendored unchanged from [paulmillr/nip44](https://github.com/paulmillr/nip44). | 129 cases |
| `rng/` | `(seed, game_id, seq, label)` → derived bytes, `int` draws and shuffles. | 15 cases |
| `commit/` | `(seed, salt)` → `seed_commit`, plus multi-party seed combination. | 5 cases |
| `games/` | A full ordered input log → expected final state, per-round patches and canonical move order, for the Orders reference module. | 1 game, 6 checks |

Run them with `pnpm --filter nip-gm-testing test`.

Two different kinds of vector live here, and they carry different authority.
`nip44/` is an **external** corpus: it is the interoperability contract with
every other Nostr implementation, and our code is wrong if it disagrees. The
rest are **ours** — generated from this implementation to pin constructions that
are otherwise only described in prose (see the `note` field in each file). A
change to those is a protocol change, never a refactor.

## Conventions

- All hex is 64-char lowercase. Never bech32 — NIP-GM §Identifiers forbids
  `npub`/`nsec`/`nevent` in tag values.
- Every file is a JSON array of cases; each case has a `name` explaining what it
  pins down, so a failure names the rule it broke.
- Include negative cases. A vector proving a malformed event is *rejected* is
  worth as much as one proving a good event parses, and ports get those wrong.
- Vectors are append-only in spirit: changing an expected value means the
  protocol changed, so it should come with a note in `NIP-GM.md`.
