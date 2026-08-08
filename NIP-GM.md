# NIP-GM: Turn-Based Games

`draft` `optional`

A protocol for running turn-based (and turn-based-realtime) multiplayer games over Nostr, using a **Game Master (GM)** client as a semi-trusted third party that executes game logic, with **Player** clients submitting moves and anyone able to spectate and audit.

Out of scope: physics-heavy or network-intensive realtime games (better served by direct p2p transports), matchmaking ratings, and payments.

> Kind numbers use the **2600 family** (after the Atari 2600) but remain placeholders pending NIP review. (Runner-up scheme: the 6502 family, after the chip inside the 2600, NES, Apple II, and C64 — its ephemeral mirror `25502` also lands in range.)

## Roles

- **GM** — a Nostr client (usually a daemon) that hosts lobbies, validates and applies moves, and publishes authoritative game state. Identified by its pubkey.
- **Player** — a client that joins lobbies and submits moves. Players MAY use throwaway keys per game; identity requirements are a per-lobby policy.
- **Spectator / Auditor** — any client subscribing to a game's public events. Auditors additionally replay the input log to verify the GM (see [Verification](#verification)).

## Identifiers and Encoding

- **Keys.** Every participant (GM or player) is identified by a secp256k1 keypair. The private key (displayed as `nsec`) signs that party's events; the public key is the identity. **In events and tags, pubkeys are always 64-character lowercase hex** — bech32 encodings (`npub`, `nsec`, `nevent`, `naddr`) are display/sharing formats per [NIP-19](https://nostrhub.io/nip/19) and MUST NOT appear in tag values.
- **Game module id.** The reverse-domain identifier of a game module (e.g. `com.example.holdem`). It is the value of `game` tags and the `d` tag of GM announcements. Not to be confused with the game id, which identifies one specific match.
- **Game id.** The **event id (hex) of the game start event** (see [Game State](#game-state-kind-2601--21601)). It appears in `e` tags as `["e", "<game_id>", "<relay hint>", "root"]`. When shared out-of-band (spectate links, replays), encode it as a [NIP-19](https://nostrhub.io/nip/19) `nevent` with relay hints.
- **Lobby address.** Lobbies are addressable events, referenced in `a` tags as standard addressable coordinates: `<kind>:<gm_pubkey>:<lobby_id>`, e.g. `32601:<gm_pubkey>:<lobby_id>`. Shared out-of-band as an `naddr`.
- Placeholders in this document: `<gm_pubkey>` and `<player_pubkey>` are hex pubkeys; `<game_id>`, `<request_id>`, `<move_id>` are hex event ids; `<lobby_id>` is the lobby's `d`-tag value.

## Game Modules

A **game module** is the implementation of one game's rules, identified by:

- `game`: the **game module id** — a reverse-domain identifier, e.g. `com.example.holdem`
- `version`: semver of the ruleset
- `rules_hash`: OPTIONAL SHA-256 of a canonical machine-readable rules spec; whether to publish one, and what exactly is hashed, is at the module's discretion

Two implementations claiming the same `(game, version)` — and, when present, the same `rules_hash` — MUST be move-for-move compatible.

**Determinism requirement:** a game module MUST be a deterministic function of `(config, seed, ordered inputs)`, where inputs are player moves plus GM system inputs (timeouts, disconnect forfeits). This is what makes GM verification possible. Wall-clock-dependent decisions (e.g. a timeout) MUST be materialized as signed GM system inputs so they become replayable.

### Protocol vs. module responsibilities

**This protocol defines** (fixed for all games): event kinds and tag grammar; the message envelope fields `seq`, `prev`, `action`, `state`; lobby semantics (visibility, join window, start conditions); the game lifecycle (`start` → deltas → `end`/`abort`); persistence modes; the commit-reveal mechanics for seeds and hidden moves; and the verification procedure.

**The game module defines** (varies per game): the vocabulary of move `type`s and the schema of their `data`; the game-specific `config` schema; the semantics of state and `patch` contents; move legality; valid `timeout_action` values; whether and how RNG is used; whether player seed contributions are required; simultaneous-round resolution order (see below); hot-join support; and whether a `rules_hash` is published.

Clients and GMs MUST NOT need game-specific knowledge to speak the protocol; they need it only to render and validate the module-defined payloads.

## Event Kinds

| Kind | Type | Author | Purpose |
|---|---|---|---|
| 32600 | addressable | GM | GM announcement (one per supported game, `d` = game module id) |
| 32601 | addressable | GM | Lobby (`d` = lobby id) |
| 32602 | addressable | GM | Game head: latest full snapshot + seq (`d` = game id) |
| 21602 | ephemeral | any | Discovery (request and offer) |
| 2600 / 21600 | regular / ephemeral | Player or GM | Game message (actions and responses) |
| 2601 / 21601 | regular / ephemeral | GM | Game state (lifecycle, deltas, private state) |

Mirrored pairs follow the rule **ephemeral = regular + 19000** and are structurally identical; which is used is set by the lobby `mode` (see [Persistence Modes](#persistence-modes)).

Within a kind, events are differentiated by tags and by **author** — the GM's pubkey is known from its announcement, so player→GM and GM→player traffic on the same kind is unambiguous. Message subtypes use non-indexed tags deliberately: relay-side filtering happens on kind, `#e` (game id), `#a` (lobby), and `#p` (recipient/next-actor), which covers every subscription this protocol needs.

## GM Announcement (kind 32600)

Modeled on [NIP-89](https://nostrhub.io/nip/89) handler / [NIP-90](https://nostrhub.io/nip/90) DVM announcements. A GM publishes one per supported game so clients can browse a directory even when the GM isn't actively answering discovery.

```jsonc
{
  "kind": 32600,
  "tags": [
    ["d", "com.example.holdem"],
    ["version", "1.2.0"],
    ["rules_hash", "<sha256>"],      // optional
    ["relays", "wss://relay1.example", "wss://relay2.example"],
    ["modes", "verified", "casual"]
  ],
  "content": "{ ...AnnouncementConfig }"
}
```

`AnnouncementConfig` (content, JSON):

```jsonc
{
  "name": "Ace GM",
  "about": "Hosted hold'em since 2026.",   // optional
  "icon": "https://.../gm.png",            // optional
  "max_concurrent_games": 50,              // optional; omit for unlimited
  "capabilities": ["create", "hot-join", "spectate", "hidden-info", "rng"]
}
```

## Discovery (kind 21602)

One ephemeral kind for both directions; author and tags disambiguate.

Request (player):

```jsonc
{ "kind": 21602, "tags": [["game", "com.example.holdem"], ["version", "1.2.0"]] }
```

Offer (GM) — distinguished by the `e` tag referencing a request and authorship by an announced GM key:

```jsonc
{
  "kind": 21602,
  "tags": [
    ["e", "<request_id>"],
    ["p", "<player_pubkey>"],
    ["a", "32600:<gm_pubkey>:com.example.holdem"],
    ["capacity", "12"]              // open seats/lobbies, "0" = full
  ]
}
```

Clients SHOULD treat the announcement (32600) as the source of truth for compatibility and the offer only as a liveness/capacity signal. Version negotiation is exact-match on `(game, version)`; when both sides publish a `rules_hash`, a mismatch at matching version SHOULD be treated as incompatible.

## Lobby (kind 32601)

Published and replaced by the GM as membership and status change.

```jsonc
{
  "kind": 32601,
  "tags": [
    ["d", "<lobby_id>"],
    ["game", "com.example.holdem"],
    ["version", "1.2.0"],
    ["visibility", "public"],                 // public | private
    ["join", "before"],                       // before | anytime
    ["start", "ready"],                       // ready | timer:<seconds> | leader
    ["leader", "<player_pubkey>"],            // required when start=leader
    ["status", "open"],                       // open | starting | active | closed
    ["p", "<player_pubkey>", "", "ready"],    // joined players + ready state
    ["p", "<player_pubkey>", "", "joined"],
    ["relays", "wss://relay1.example"],
    ["e", "<game_id>"]                        // present once status=active
  ],
  "content": "{ ...LobbyConfig }"
}
```

`LobbyConfig` (content, JSON):

```jsonc
{
  "name": "Friday Poker",
  "mode": "verified",          // verified | casual
  "min_players": 2,
  "max_players": 6,
  "turn_timeout": 60,          // seconds; 0 = none (async-friendly)
  "timeout_action": "fold",    // module-defined system input applied on timeout
  "snapshot_interval": 10,     // update head snapshot every N deltas
  "spectator_delay": 30,       // seconds; 0 = live spectating
  "config": { }                // module-defined settings
}
```

### Behaviors

- **Visibility.** `public` lobbies are published to the declared relays and discoverable by filter. `private` lobbies SHOULD NOT be broadcast; share the `naddr` out-of-band. A join code, if used, is checked by the GM — it never appears in the lobby event; players send it [NIP-44](https://nostrhub.io/nip/44)-encrypted in the join message.
- **Join window.** `before`: joins accepted only while `status=open`. `anytime`: the GM may admit players mid-game if the module supports hot-join (a declared capability).
- **Start condition.** `ready`: game starts when all joined players are ready (and `min_players` met). `timer:<s>`: starts `s` seconds after the lobby opens if `min_players` met, regardless of ready states. `leader`: starts when the leader sends a ready message carrying `["intent", "start"]`.

## Game Messages (kind 2600 / 21600)

All player↔GM communication uses this single kind, differentiated by an `action` tag and by author.

**Player actions** — `create`, `join`, `leave`, `ready`, `move`, and (ephemeral mirror only) `presence`:

```jsonc
// create — ask a GM to open a lobby
{
  "kind": 2600,
  "tags": [
    ["action", "create"],
    ["a", "32600:<gm_pubkey>:com.example.holdem"],
    ["p", "<gm_pubkey>"]
  ],
  "content": "<NIP-44 to GM: {
    \"game\": \"com.example.holdem\", \"version\": \"1.2.0\",
    \"visibility\": \"private\", \"join\": \"before\", \"start\": \"leader\",
    \"code\": \"...\",                 // optional; required for code-gated private lobbies
    \"config\": { ...LobbyConfig }
  }>"
}
```

The request is [NIP-44](https://nostrhub.io/nip/44)-encrypted because it may carry the join code. On acceptance the GM publishes the lobby (32601), responds with `{"status":"accepted","lobby":"<lobby_id>"}`, auto-joins the creator, and sets them as `leader` where `start=leader`. Whether a GM accepts creation requests at all — and from whom (allowlists, rate limits, per-module policy) — is GM policy; GMs offering it SHOULD list `"create"` in their announced capabilities.

```jsonc
// join
{
  "kind": 2600,
  "tags": [
    ["action", "join"],
    ["a", "32601:<gm_pubkey>:<lobby_id>"],
    ["p", "<gm_pubkey>"]
  ],
  "content": "<NIP-44 to GM: {\"code\":\"...\"} — or empty for public lobbies>"
}

// move
{
  "kind": 2600,
  "tags": [
    ["action", "move"],
    ["e", "<game_id>", "", "root"],
    ["p", "<gm_pubkey>"]
  ],
  "content": "{\"seq\": 12, \"prev\": \"<event id of last state event seen>\", \"type\": \"raise\", \"data\": {\"amount\": 40}}"
}
```

The envelope (`seq`, `prev`, `type`, `data`) is protocol; the meaning of `type` and `data` is module-defined. Move content is plaintext for public-move turn-taking games, and [NIP-44](https://nostrhub.io/nip/44)-encrypted to the GM when the move is hidden information — which includes **all simultaneous-round moves**, even in otherwise public-move games (see below). `seq` claims which turn or round the move answers; `prev` pins the state it was made against — together they make stale/duplicate rejection deterministic and auditable. `prev` MUST reference a **public** state event (the `start` event or a `delta`), never a `private` event: rejections are only auditable against state every verifier can order. Leaving after start is a forfeit, which the GM materializes as a system input.

**GM responses** — same kind, authored by the GM, `e`-tagging the message they answer:

```jsonc
{
  "kind": 2600,
  "tags": [
    ["action", "response"],
    ["e", "<player message id>"],
    ["p", "<player_pubkey>"],
    ["e", "<game_id>", "", "root"]    // when game-scoped
  ],
  "content": "{\"status\":\"rejected\", \"reason\":\"not_your_turn\"}"   // or {"status":"applied","state":"<delta event id>"} / {"status":"accepted"} for joins
}
```

On an accepted join/leave/ready, the GM also republishes the lobby with updated `p` tags; the response gives the player immediate feedback (content MAY be [NIP-44](https://nostrhub.io/nip/44)-encrypted).

## Game State (kind 2601 / 21601)

All GM-authored lifecycle and state events use this single kind with a `state` tag: `start`, `delta`, `private`, `end`, `abort`.

### Start

The start event's **id is the game id**; every subsequent game event carries `["e", "<game_id>", "<relay hint>", "root"]`, so one `#e` filter follows the whole game.

```jsonc
{
  "kind": 2601,
  "tags": [
    ["state", "start"],
    ["a", "32601:<gm_pubkey>:<lobby_id>"],
    ["p", "<player_pubkey>"], ["p", "<player_pubkey>"],
    ["game", "com.example.holdem"], ["version", "1.2.0"]
  ],
  "content": "{
    \"rules_hash\": \"<sha256>\",          // optional
    \"config\": { },
    \"seed_commit\": \"<sha256(seed || salt)>\",
    \"player_seed_commits\": { \"<player_pubkey>\": \"<hash>\" }   // optional, module-defined
  }"
}
```

The roster lives only in the `p` tags: **the order of `p` tags defines seat order**. Tag order is preserved in the event and covered by the GM's signature, and seat order is a module input (deal order, canonical simultaneous-resolution order), so it is not duplicated in content.

### Deltas

Published after applying input:

```jsonc
{
  "kind": 2601,
  "tags": [
    ["state", "delta"],
    ["e", "<game_id>", "", "root"],
    ["seq", "13"],
    ["p", "<player_pubkey>"]           // one tag per player expected to act next
  ],
  "content": "{\"seq\":13, \"applied\":[\"<move_id>\"], \"patch\":{ }, \"system\":null}"
}
```

The `p` tags marking who acts next are deliberate: an async player subscribes to `{"kinds":[2601], "#p":["<their pubkey>"]}` and gets "your turn" notifications across all their games. GM system inputs (timeouts, forfeits, hot-joins) are deltas with a `system` object instead of `applied`, and count as replay inputs.

**Simultaneous rounds and many players.** The `p` tags generalize: a delta opening a simultaneous round carries one `p` tag per player who must act (possibly all of them), and those players submit moves sharing the same `seq` and `prev`. Because move events are visible on relays the moment they are published, **simultaneous-round moves MUST be encrypted** (see [per-round commit-reveal](#hidden-information-and-randomness)) even in otherwise public-move games — a plaintext simultaneous move would be readable by opponents before they submit their own. The GM closes the round with a single delta whose `applied` array lists every accepted move **in resolution order**, with plaintext and decryption key per entry:

```jsonc
"applied": [
  { "id": "<move_id>", "move": {"type": "bid", "data": {"amount": 40}}, "key": "<nip44 conversation key, hex>" }
]
```

Anyone can decrypt each cited ciphertext with its revealed key and confirm it matches the published plaintext, so the round is verifiable the moment it closes. Modules whose resolution is order-sensitive MUST define a canonical order derivable from the events themselves (e.g. ascending move event id, or seat order from the start event) so auditors can reproduce it; the GM's published order MUST match. Player counts large enough to make per-player `p` tags unwieldy are unusual for turn-based games, but a module MAY declare rounds where *everyone* acts and omit per-player tags in favor of a single `["p-all", "true"]`-style marker — left as module discretion.

### Private state

Per-player hidden state (hole cards, fog of war):

```jsonc
{
  "kind": 2601,
  "tags": [
    ["state", "private"],
    ["e", "<game_id>", "", "root"],
    ["seq", "13"],
    ["p", "<player_pubkey>"]           // recipient
  ],
  "content": "<NIP-44 encrypted to recipient>"
}
```

All private payloads in this protocol use [NIP-44](https://nostrhub.io/nip/44). [NIP-44](https://nostrhub.io/nip/44) encrypts content but not metadata: observers see that private state moved from GM to player at a given moment. **This is acceptable here because of turn cadence** — in a well-formed hidden-info game the GM sends a private event to *every* involved player each turn (a no-op/padding payload when a player has no new secrets), so the existence and timing of private events reveals nothing beyond what the game's public structure already implies. Modules whose private state does *not* follow the turn cadence (event-driven secrets, where the mere arrival of a private event is informative) SHOULD either pad to a fixed cadence or have implementers wrap those events in [NIP-59](https://nostrhub.io/nip/59) gift wrap instead. These events are persistent in `verified` mode so offline players receive them on reconnect.

### End and abort

```jsonc
{
  "kind": 2601,
  "tags": [["state", "end"], ["e", "<game_id>", "", "root"], ["p", "<player_pubkey>"], ["p", "<player_pubkey>"]],
  "content": "{
    \"result\": { \"winners\": [\"<player_pubkey>\"], \"scores\": { } },
    \"seed\": \"<hex>\", \"salt\": \"<hex>\",
    \"key_reveals\": { \"<move_id>\": \"<nip44 conversation key, hex>\" }
  }"
}
```

`abort` is used when a game cannot complete (GM shutdown, insufficient players); it SHOULD still include the GM's seed reveal so the partial log remains auditable. Lifecycle events (`start`, `end`, `abort`) are ALWAYS published on the regular kind, even in `casual` mode, so every game leaves a minimal permanent record.

### Head snapshot (kind 32602)

Instead of periodic checkpoint events, the GM maintains one addressable head per game (`d` = game id) containing the latest full public state and `seq`, replaced every `snapshot_interval` deltas and at game end. Late joiners and spectators fetch the head plus subsequent deltas instead of the whole log; being replaceable, it is always a single cheap query. History is not lost — the delta log and start event remain the authoritative record.

## Hidden Information and Randomness

Hidden info and verifiability pull in opposite directions; commit-reveal reconciles them.

**GM randomness (mandatory when the module uses RNG).** Before start, the GM samples `seed` and publishes `seed_commit = sha256(seed || salt)` in the start event. All shuffles/rolls MUST derive deterministically from the seed (e.g. HKDF over `seed || game_id || seq`). At game end the GM reveals `seed` and `salt`; auditors recompute the commit and re-derive every deal, so the GM cannot pick outcomes after seeing play. (A committed GM can still *know* the deck and leak it to a colluder — inherent to any trusted-dealer design and out of scope.)

**Player seed contributions (optional, module-defined).** Modules wanting randomness no single party controls can require each player to commit a seed in their ready message and reveal it at game end; the effective seed is a hash over all contributions. Tradeoff: a player who aborts without revealing leaves the game partially unverifiable, so modules SHOULD require this only where it matters.

**Hidden player moves** (sealed bids, simultaneous orders): the player generates an ephemeral keypair, includes its pubkey in the move event as `["ephemeral", "<pubkey>"]`, and [NIP-44](https://nostrhub.io/nip/44)-encrypts move content to the GM using it. The signed, timestamped, persistent ciphertext is the player's commitment; revealing the [NIP-44](https://nostrhub.io/nip/44) conversation key (derivable by the GM from the ephemeral pubkey) makes it verifiable. Two reveal cadences:

- **Per-round reveal** (REQUIRED for simultaneous rounds): the player uses a fresh ephemeral key *per round*; the GM reveals each move's conversation key in the round-closing delta as shown above. A fresh key per round is what keeps the reveal scoped — a conversation key decrypts everything between one key pair.
- **End-of-game reveal** (for moves that must stay hidden through play, e.g. secret orders resolved only at the end): one ephemeral key per game; the GM reveals the conversation keys in the end event's `key_reveals`.

In both cadences the GM derives every conversation key itself — `ECDH(gm_privkey, ephemeral_pubkey)` equals what the player computed — so reveals never require player cooperation and no private key is ever transmitted. The only reveal that *does* depend on a player is a seed contribution, covered above.

**Hole-card games** (poker-like) usually need neither of the above beyond the GM seed: player actions (bet/fold) are public moves, and private deals are re-derivable from the revealed seed.

## Verification

In `verified` mode, anyone can audit a finished game:

1. Fetch the start event (config, commits), all move messages, all deltas/system inputs, and the end event (reveals), via the `#e` game-id filter on kinds 2600 and 2601.
2. Order inputs by the `seq` chain and, within simultaneous rounds, by the module's canonical resolution order — never by relay return order or `created_at` alone.
3. Check `seed_commit` against the revealed seed and salt; decrypt every hidden move with its revealed conversation key (per-round keys from round-closing deltas, per-game keys from `key_reveals`) and check the plaintexts against their ciphertext commitments.
4. Re-run the game module over the ordered inputs and confirm the resulting states match every published delta, that every rejected move was in fact illegal, that no signed legal move was silently dropped, and that system inputs (timeouts) are plausible against event timestamps.

Divergence is cryptographic evidence of a faulty or dishonest GM, attributable to its pubkey. This is the actual trust mechanism; version strings and `rules_hash` are compatibility metadata, not security. Reputation systems over audit results (e.g. [NIP-32](https://nostrhub.io/nip/32) labels on GM pubkeys) are encouraged but out of scope.

## Persistence Modes

- **`verified`** (default): game messages and state use the regular kinds (2600, 2601). Required for auditability, async play, and full crash recovery. Turn-based traffic is low-volume; persistence is cheap.
- **`casual`**: game messages and state use the ephemeral mirrors (21600, 21601). No audit trail, no async, recovery only to the last head snapshot. Appropriate for fast casual sessions where relay hygiene matters more than proof. Lifecycle events remain regular either way.

**Async games** are `verified`-mode games with `turn_timeout: 0` (or very large). Everything needed is already persistent: moves are store-and-forward, private state waits on relays for offline players, and the `p` tags on deltas provide turn notifications. Clients MAY use [NIP-40](https://nostrhub.io/nip/40) expiration on stale lobbies.

## Crash Recovery

A restarting GM fetches its own head (32602), then all persistent inputs for the game with `seq` greater than the head's, replays them (deterministically — the same code path auditors use), and resumes. In `casual` mode anything after the head is lost; the GM SHOULD publish a system delta rolling the game back to the head so clients resynchronize.

*Note:* because the full input log is public in `verified` mode, a replacement GM running the same module could in principle adopt an orphaned game; handoff/failover authorization is deliberately not addressed by this protocol.

## Spectators

Spectators subscribe to `{"#e": ["<game_id>"], "kinds": [2601]}` on the game's declared relays (optionally 2600 as well, to watch raw moves in public-move games). They see only public state; hidden information stays encrypted until its per-round or end-of-game reveal, after which replays are fully open. Secrecy is therefore enforced by encryption, not by spectator rules. What remains is realtime coaching: a spectator (or their solver) analyzing public state and feeding advice to a player as the game runs. As a soft mitigation — the same reason broadcast poker runs on a delay even with hole cards hidden — a competitive lobby MAY set `spectator_delay`: the GM sends players their private state immediately but publishes public deltas that many seconds late, so any relayed analysis is stale. `spectator_delay` MUST be 0 or clearly surfaced to players, since it also delays their own public view.

## In-Game Chat

Chat is out of protocol scope and up to client/app implementations. Clients SHOULD use [NIP-22](https://nostrhub.io/nip/22) comments (kind 1111) rooted at the game id (or at the lobby address pre-game), which gives threaded, permanently scoped chat for free and keeps it off the game kinds.

## Relay Strategy

The GM declares its relay set in the announcement and lobby; players and spectators MUST read/write game events there. This is essential for ephemeral kinds (which exist only for currently-connected subscribers) and strongly recommended generally so a game's log lives in one predictable place. GMs SHOULD use at least two relays for redundancy in `verified` mode, since the input log is also their recovery mechanism.

## Security and Privacy Notes

- All private payloads (join codes, hidden moves, private state) use [NIP-44](https://nostrhub.io/nip/44). [NIP-44](https://nostrhub.io/nip/44) does not hide metadata; the turn-cadence argument in [Private state](#private-state) explains why that is acceptable, and when [NIP-59](https://nostrhub.io/nip/59) gift wrap is the right escape hatch.
- Players wanting identity privacy SHOULD use per-game throwaway keys, optionally driven by their main identity via [NIP-46](https://nostrhub.io/nip/46).
- Players SHOULD verify that lobby, state, and response events are signed by the GM pubkey from the announcement they trusted.
- The `prev`/`seq` fields in moves prevent replay of old signed moves into new games and make "stale move" rejections deterministic and auditable.
- A malicious GM's main residual powers are leaking hidden state to a colluder (undetectable, inherent) and stalling/aborting. Everything else — misdealing, dropping moves, misapplying rules — is detectable in `verified` mode.

## Open Questions

- Kind number allocation (the 2600 family is a proposal) and whether mirrored `+19000` pairs are acceptable to the NIP process.
- Whether the `action` / `state` subtype tags should get an indexed single-letter alias if relay-side subtype filtering proves useful in practice.
- Whether a standard capability-flag vocabulary (hot-join, spectate, hidden-info, rng) should be normative in the announcement or remain informal.
