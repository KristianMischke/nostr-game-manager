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

| Directory | Contents |
|---|---|
| `codec/` | Event ⇄ parsed struct, both directions, for every kind. Must include tag-order cases — `p` tag order is seat order. |
| `nip44/` | The official NIP-44 vectors, vendored unchanged. |
| `rng/` | `(seed, game_id, seq, label)` → expected derived bytes. |
| `commit/` | `(seed, salt)` → `seed_commit`, plus verification cases. |
| `games/` | Full ordered input logs → expected final state, per module. Includes resolution-order cases. |

## Conventions

- All hex is 64-char lowercase. Never bech32 — NIP-GM §Identifiers forbids
  `npub`/`nsec`/`nevent` in tag values.
- Every file is a JSON array of cases; each case has a `name` explaining what it
  pins down, so a failure names the rule it broke.
- Include negative cases. A vector proving a malformed event is *rejected* is
  worth as much as one proving a good event parses, and ports get those wrong.
- Vectors are append-only in spirit: changing an expected value means the
  protocol changed, so it should come with a note in `NIP-GM.md`.
