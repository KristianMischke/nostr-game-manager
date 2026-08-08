# Porting game logic to a NIP-GM module

A guide for turning existing game logic — in this case logic that currently runs
against Firebase — into a `GameModule`: a deterministic function of
`(config, seed, ordered inputs)`.

The interface you are implementing is
[`packages/nip-gm-core/src/module/types.ts`](../packages/nip-gm-core/src/module/types.ts),
with its execution context in
[`context.ts`](../packages/nip-gm-core/src/module/context.ts).

---

## 1. What you are porting, and what you are not

Your module owns **rules**. It does not own transport, identity, encryption,
ordering, persistence, or presentation.

| Stays in the module | Leaves the module |
|---|---|
| What moves exist and what they mean | How moves get to the GM |
| Whether a move is legal | Who signed it, and whether the signature is valid |
| How state changes when moves resolve | Encrypting, committing, revealing |
| Win/lose/score conditions | Publishing deltas, snapshots, timeouts |
| What randomness is needed, and when | Where the seed came from |
| What each player may see | Delivering it privately |

If a piece of your current logic touches Firebase, sockets, auth, or the DOM, it
is not going into the module. If it decides *what happens*, it is.

The practical test: **your module must produce identical output on a machine with
no network, no clock, and no keys.** That is what lets the GM run it live, an
auditor re-run it years later, and your tests run it a thousand times a second.

---

## 2. The shape change

Firebase logic is usually written as *mutations reacting to writes*: a player
writes a move, a trigger or client transaction reads current state, mutates it,
writes it back. State is a place you edit.

A NIP-GM module inverts this. State is a **value** produced by folding an ordered
log of inputs:

```
state₀ = init(config, seed, seats)
state₁ = apply(state₀, round₁)
state₂ = apply(state₁, round₂)
...
```

Nothing is read from outside the fold. The GM runs it forward as moves arrive; an
auditor runs the exact same code over the exact same log and must land on the
exact same state. That equality *is* the protocol's trust mechanism
(NIP-GM §Verification) — so anything that could make the two runs differ is a
security bug, not just a flake.

For your game, the unit of the fold is a **round**, not a single move: every tick,
all players' queued moves resolve together.

---

## 3. Carve out the state

Start by writing down `State` as a plain, serializable value.

Rules:

- **Plain data only.** No class instances, no functions, no `undefined` in
  positions that must round-trip, no `Date`, no DOM nodes, no references to
  anything live.
- **Everything the rules read must be inside it.** If your current code reaches
  for a config document, a player profile, or a "current server time", that
  either becomes part of `Config` (fixed at start) or arrives as an input.
- **Nothing the rules do not read.** Rendering hints, animation timers,
  camera position, sound cues, last-seen-at timestamps: leave them in your UI
  layer. They bloat snapshots and, worse, make two implementations disagree over
  values that do not matter.
- **Hidden state lives here too.** A player's queued orders are part of the
  authoritative state — they are simply not shown to everyone. Secrecy is
  enforced by what the GM encrypts, not by what the module stores.

A useful first pass: take your current Firebase document tree, delete every field
the rules never branch on, and what remains is close to your `State`.

### Watch the collection types

`Map` and `Set` iterate in insertion order, which is deterministic *only if the
insertion sequence is*. If you ever build a map by iterating over moves in
arrival order, its iteration order differs between the GM and an auditor even
though the contents match. Prefer keying by pubkey and, wherever you iterate for
anything that affects the result, sort explicitly — seat index is usually the
right key.

Plain objects have a sharper trap: integer-like string keys iterate in **numeric
order first**, regardless of insertion. `{"10": a, "2": b}` iterates `2, 10`. If
your board is keyed by numeric tile ids, do not rely on key order at all.

---

## 4. Define `Move` and `Config`

`Move` is one player's submission for one round. For your game that is the queued
order set — whatever a player commits to at a tick.

`Config` is the per-match settings from `LobbyConfig.config`: board size, victory
threshold, number of rounds, and so on. It is fixed at start and appears in the
signed start event, so both players and auditors can see exactly what was agreed.

Both arrive off the wire as untrusted JSON, so both get a parser:

```ts
parseMove(raw: unknown): Move | undefined   // undefined ⇒ reject
parseConfig(raw: unknown): Config           // throw ⇒ reject
```

Be strict here. `parseMove` is the boundary between "bytes someone published" and
"a value my rules may assume things about". Reject unknown fields rather than
ignoring them — a move that means one thing to your implementation and another to
a future port is exactly the incompatibility `(game, version)` is supposed to
rule out.

---

## 5. `init`

```ts
init(ctx: InitContext<Config>): State
```

You get `gameId`, `config`, `seats`, and `rng`.

`seats` is the roster **in seat order** — it comes from the order of `p` tags in
the signed start event (NIP-GM §Start). Use it as the canonical player order for
everything: deal order, turn order, tie-breaks, array indices.

Any setup randomness (starting positions, initial deal, map generation) draws
from `ctx.rng` — see §8.

---

## 6. `validate`

```ts
validate(state: State, move: ResolvedMove<Move>, ctx: TurnContext): ValidationResult
```

Called per move, before the round resolves. Return `{ ok: false, reason }` to
reject; the reason travels back to the player in the GM's response.

Three things to get right:

**It must be pure.** No mutation of `state`, no side effects, no RNG draws. It is
run by the GM live *and* by auditors checking that every rejection was justified
and that no legal move was silently dropped.

**`reason` is part of your public API.** Auditors compare rejections across
implementations. Use short stable codes (`not_enough_energy`, `tile_occupied`),
not prose that you will reword later.

**Do not validate what the protocol already did.** Signature validity, whether
the sender is in the game, whether `seq` and `prev` are current, duplicate
submissions — all handled before your module sees anything. Check rules only.

A subtlety for simultaneous rounds: `validate` sees each move against the state
at the *start* of the round, because no move in the round has resolved yet. Two
moves can each be individually legal and still conflict — two units ordered onto
one tile, two players spending the same shared resource. **Conflicts are not a
validation concern.** They resolve in `apply`, in canonical order. Validation
answers "could this player legally intend this?", not "will it succeed?".

---

## 7. `apply` — the core

```ts
apply(state: State, input: RoundInput<Move>, ctx: TurnContext): ApplyResult<State, Patch>
```

`input.moves` is **already sorted** into your declared `resolutionOrder`
([`engine/ordering.ts`](../packages/nip-gm-core/src/engine/ordering.ts)). Do not
re-sort it; fold over it in the order given. That order is what an auditor will
reproduce.

`input.system` is non-null when the GM is injecting a non-move input: a turn
timeout, a forfeit, a hot-join, an abort. These are ordinary inputs to you — the
GM signs them precisely so they become replayable (NIP-GM §Game Modules).

Return:

```ts
{
  state,                 // the new state — do not mutate the input
  patch,                 // what changed, for clients (§10)
  awaiting,              // pubkeys who must act next → the delta's p tags
  privateState?,         // Map<pubkey, secret> → encrypted private events
  end?,                  // present iff the game is over
}
```

### Cases your fold must handle

- **Zero moves.** Every player timed out. This is a real round, not an error.
- **Partial rounds.** Some players submitted, others were timed out by the GM.
  The absentees appear via `input.system`, not as moves.
- **Conflicts.** Two moves contending for one thing. First in resolution order
  wins; later ones fail *within the rules* (bounce, waste the action, take
  damage) rather than being rejected.
- **A move that has become impossible.** Legal when validated, moot by the time
  it resolves because an earlier move in the same round changed the world. Define
  what happens; do not throw.

That last group is where most of your porting effort will go, and it is
genuinely new work — Firebase's serialized transactions hid it from you by
letting each write see the previous one's result. Here the whole round is
decided against one starting state.

### `awaiting`

The pubkeys who must act next. It becomes the `p` tags on the delta, which is
how clients know to prompt and how async players get notified across games
(NIP-GM §Deltas). For a game where everyone acts every tick, this is usually
"every player still alive". Return `[]` when the game has ended.

---

## 8. Randomness

Never `Math.random()`. Draw from `ctx.rng`:

```ts
const stream = ctx.rng.at(seq, label);
stream.int(6);          // unbiased, rejection-sampled
stream.bytes(32);
stream.shuffle(deck);   // returns a new array
```

A stream is addressed by `(seq, label)` and derived from the seed the GM
committed to before play. Two consequences:

**You cannot grind.** The GM does not get to sample repeatedly and keep a
favourable draw, because auditors recompute the stream at exactly the
`(seq, label)` your module asked for. This is why the address is explicit rather
than an implicit counter — an implicit sequence would let a GM change how many
draws it made in order to move the result.

**Labels must be stable and unconditional.** Use fixed strings (`'deal'`,
`'storm'`, `'order'`), and derive the same labels on every run. If you draw
`rng.at(seq, 'x')` only when some condition holds, that is fine — but the
condition must itself be a pure function of state, or the GM and an auditor will
draw different streams.

Draw once per logical need and reuse the stream. Do not call `at()` with the same
address twice expecting different values; it is the same stream each time.

### Scheduling randomness ahead of time

Your case — the GM deciding now that a random element appears N turns later —
needs no extra machinery, which is worth understanding rather than working
around.

Every value is *fully determined* the moment the seed is committed, but
*unknowable* to anyone until the reveal at game end. So at round `s` you can
compute the event that will land at round `s + N`:

```ts
const storm = ctx.rng.at(ctx.seq + LEAD_TIME, 'storm').int(boardSize);
```

You may even publish it immediately in the patch — announcing "a storm hits tile
7 in three turns" leaks nothing, because it was already fixed by the commit and
the GM could not have chosen it. At game end the seed is revealed and anyone
recomputes `rng.at(s + N, 'storm')` to confirm the GM did not invent it.

The one rule: address it by the round it *belongs to*, not the round you happen
to compute it in. Otherwise a GM that computes it early, dislikes it, and stalls
could re-derive under a different address.

---

## 9. Private state

`privateState: Map<pubkey, secret>` becomes one NIP-44 encrypted `private` event
per recipient.

Before you use it, check whether you need it at all. Your hidden information is
players' own queued moves, and those already live in the players' own encrypted
move events — each player knows what they queued. If the GM never has a secret to
*tell* a player that the player does not already know, leave `privateState`
undefined and skip the channel.

If you do need it, one constraint from NIP-GM §Private state: encryption hides
content but not metadata, so the *arrival* of a private event is itself a signal.
The spec accepts this only when private events follow the turn cadence — one to
every involved player each round, padded when a player has no news. If yours
would be event-driven and sporadic, either pad to a fixed cadence or plan on
NIP-59 gift wrap. Sending a private event to exactly one player at exactly the
moment something happened to them tells everyone watching that something
happened to them.

---

## 10. Patches

`patch` is what clients apply to their copy of the state instead of re-running
your module. It is module-defined; the protocol just carries it.

Options, roughly in order of how much I would reach for them:

1. **A semantic diff of your own** — `{ moved: [...], destroyed: [...], scores: {...} }`.
   Compact, and your UI can animate from it, which a structural diff cannot.
2. **RFC 7386 merge patch** — trivial to apply, but cannot express array edits or
   deletions cleanly.
3. **The whole state** — start here if the state is small. Correct, boring, and
   you can optimise later without a protocol change.

Whatever you choose, `apply(state, round).patch` applied to `state` must yield
exactly `apply(state, round).state`. Clients that trust the patch and auditors
that re-run the module have to agree, or you get spurious divergence reports.
Property-test this the moment you have more than one patch shape.

---

## 11. `serialize` / `deserialize`

Used for the game head snapshot (kind 32602) and GM crash recovery.

`deserialize(serialize(s))` must be deep-equal to `s`. Two failure modes worth
pre-empting: `Map`/`Set` do not survive `JSON.stringify` (convert to sorted
arrays), and `undefined` fields silently vanish (use `null` where the absence
must round-trip).

Emit object keys in a stable order — sort them — so that a snapshot's bytes are
reproducible. It makes snapshot diffing meaningful and rules out a class of
"identical state, different bytes" confusion.

---

## 12. Determinism rules

The whole contract, in one list. Inside your module, never:

- `Math.random()` — use `ctx.rng`
- `Date.now()`, `new Date()`, `performance.now()` — use `ctx.now` / `input.now`
- `crypto.randomUUID()` or any id generation — derive ids from move event ids or `ctx.rng`
- Read a network, a file, a global, or module-level mutable state
- Depend on object or `Map` iteration order that came from arrival order
- Depend on `Array.prototype.sort` without a **total** comparator (ties must break deterministically — sort is stable, but only relative to the order you fed it)
- Mutate `state`, `input`, or anything reachable from them
- Branch on `typeof window`, environment variables, or locale
- Use locale-sensitive operations: `toLocaleString`, `localeCompare`, `Intl` — compare with `<`/`>` on strings instead

Floating-point arithmetic *is* deterministic across JS engines (IEEE-754), so
plain arithmetic is safe. `Math.sin`/`cos`/`pow` and friends are **not**
guaranteed identical across engines — if your rules depend on trigonometry,
switch to integers or fixed-point before porting, not after. This will not bite
you in TypeScript-to-TypeScript, but it will bite the C# port.

---

## 13. Firebase translation table

| What you have now | Where it goes |
|---|---|
| Security rules validating a write | `validate()` |
| A transaction reading-then-writing state | `apply()`, folding over the round |
| `serverTimestamp()` | `ctx.now`, supplied by the input record |
| A `onDisconnect` handler | A GM system input (`{ type: 'forfeit' }`) reaching `apply` |
| Auto-generated push ids | Move event ids, or `ctx.rng` |
| Optimistic local write, reconciled on ack | `pending` in the client snapshot — already handled, delete yours |
| A cloud function reacting to a write | The GM's round loop — delete it |
| Per-player private subtree with read rules | `privateState`, encrypted per recipient |
| "Read current state" mid-logic | Must already be in `State` |
| Server-side matchmaking | Lobbies (kind 32601) — out of the module |
| Presence / "who's online" | Out of scope; the protocol has `presence` messages in casual mode |

The one that most often hides a bug: anywhere your current code did a second read
of live state partway through resolving something. There is no live state to
read. Everything must be in `state` at the top of `apply`.

---

## 14. Skeleton

```ts
import type {
  GameModule, ResolvedMove, RoundInput, ApplyResult, ValidationResult,
  InitContext, TurnContext,
} from 'nip-gm-core';

export interface Config { boardSize: number; maxRounds: number }
export interface State {
  round: number;
  units: Record<string, Unit>;      // keyed by pubkey
  eliminated: string[];
  scheduled: { at: number; tile: number }[];
}
export type Move = { orders: Order[] };
export type Patch = { round: number; resolved: Resolution[]; eliminated: string[] };

const LEAD_TIME = 3;

export const myGame: GameModule<Config, State, Move, Patch> = {
  id: 'net.kkcoder.mygame',
  version: '0.1.0',

  // Seat order gives seat 0 a standing edge in every contested resolution;
  // 'shuffled' re-rolls the order each round from the committed seed.
  resolutionOrder: { kind: 'shuffled' },

  minPlayers: 2,
  maxPlayers: 6,

  init(ctx: InitContext<Config>): State {
    const spawns = ctx.rng.at(0, 'spawns').shuffle(tiles(ctx.config.boardSize));
    return {
      round: 0,
      units: Object.fromEntries(ctx.seats.map((pk, i) => [pk, newUnit(spawns[i])])),
      eliminated: [],
      scheduled: [],
    };
  },

  validate(state, move: ResolvedMove<Move>, _ctx: TurnContext): ValidationResult {
    if (state.eliminated.includes(move.player)) return { ok: false, reason: 'eliminated' };
    if (move.move.orders.length > MAX_ORDERS) return { ok: false, reason: 'too_many_orders' };
    // Legality against the round-start state only. Conflicts are apply's job.
    return { ok: true };
  },

  apply(state, input: RoundInput<Move>, ctx: TurnContext): ApplyResult<State, Patch> {
    let next = structuredClone(state);
    const resolved: Resolution[] = [];

    // Already in canonical order — fold, do not re-sort.
    for (const { player, move } of input.moves) {
      resolved.push(...resolveOrders(next, player, move.orders));
    }

    if (input.system?.type === 'forfeit' && input.system.player) {
      next.eliminated.push(input.system.player);
    }

    // Randomness for a future round, addressed by the round it lands on.
    const landing = ctx.seq + LEAD_TIME;
    next.scheduled.push({
      at: landing,
      tile: ctx.rng.at(landing, 'storm').int(ctx.seats.length ? boardTiles(state) : 1),
    });
    applyDueEvents(next, ctx.seq);

    next.round = ctx.seq;
    const alive = ctx.seats.filter((pk) => !next.eliminated.includes(pk));
    const over = alive.length <= 1 || next.round >= configOf(state).maxRounds;

    return {
      state: next,
      patch: { round: next.round, resolved, eliminated: next.eliminated },
      awaiting: over ? [] : alive,
      ...(over ? { end: { winners: alive } } : {}),
    };
  },

  parseMove(raw) { /* strict validation, return undefined to reject */ },
  parseConfig(raw) { /* strict validation, throw to reject */ },
  serialize: (s) => s,
  deserialize: (raw) => raw as State,
};
```

---

## 15. Testing

The harness now exists, so the three checks below are one call:

```ts
import { checkDeterminism } from 'nip-gm-testing';

const report = checkDeterminism(myGame, log, { checkOrderIndependence: true });
expect(report.findings).toEqual([]);
```

It replays your log twice and compares; replays again with `Math.random`,
`Date.now` and `performance.now` stubbed to throw; replays with every state and
round deep-frozen, so any in-place mutation throws; and replays with each
round's arrival order reversed. Findings come back as stable codes —
`ambient_nondeterminism`, `mutates_input`, `not_reproducible`, `order_dependent`.

One caveat worth taking seriously: this proves absence of the *observed*
nondeterminism, not its impossibility. A module that branches on `Math.random()`
once in a thousand rounds needs a log that reaches that branch. Green is
evidence, not proof — so make your logs cover the awkward paths.

There is also a **worked reference module** at
[`packages/nip-gm-testing/src/example/orders.ts`](../packages/nip-gm-testing/src/example/orders.ts):
a simultaneous-round game with hidden queued moves, contested tiles and a storm
scheduled three rounds ahead. It is close in shape to what you are porting, and
it is the thing to copy for `ctx.rng.at(landing, 'storm')` and for resolving
collisions in canonical order.

Once your module runs, `runScriptedGame` plays a full match and emits a signed
event log, and `auditGame` verifies it exactly as a third party would.

### Doing it by hand

If you would rather not pull in the harness, these are the same checks written
out.

**Determinism.** Run the same log twice and compare serialized output:

```ts
const run = () => log.reduce(
  (s, round) => myGame.apply(s, round, ctxFor(round)).state,
  myGame.init(initCtx),
);
expect(JSON.stringify(myGame.serialize(run())))
  .toBe(JSON.stringify(myGame.serialize(run())));
```

Then run it again with `Math.random` and `Date.now` stubbed to throw. If your
module survives, it is honest:

```ts
vi.spyOn(Math, 'random').mockImplementation(() => { throw new Error('nondeterminism'); });
vi.spyOn(Date, 'now').mockImplementation(() => { throw new Error('nondeterminism'); });
```

**Order independence.** The same round with its moves shuffled before ordering
must produce the same result — this proves you are honouring `resolutionOrder`
and not accidentally depending on arrival order:

```ts
const a = myGame.apply(s, { ...round, moves: order(round.moves) }, ctx).state;
const b = myGame.apply(s, { ...round, moves: order([...round.moves].reverse()) }, ctx).state;
expect(a).toEqual(b);
```

**Purity.** Deep-freeze the state you pass in. Any accidental mutation throws in
strict mode:

```ts
myGame.apply(deepFreeze(state), round, ctx);
```

---

## 16. Checklist

- [ ] `State` is plain serializable data; nothing presentational, nothing live
- [ ] `deserialize(serialize(s))` deep-equals `s`
- [ ] `parseMove` / `parseConfig` reject unknown and malformed input strictly
- [ ] `validate` is pure, returns stable reason codes, checks rules only
- [ ] `apply` never mutates its inputs
- [ ] `apply` handles zero moves, partial rounds, conflicts, and newly-impossible moves
- [ ] Resolution order declared, and `apply` folds in the order given
- [ ] All randomness via `ctx.rng.at(seq, label)`, with stable labels
- [ ] Scheduled randomness addressed by the round it lands on
- [ ] No banned calls from §12 anywhere in the module or its imports
- [ ] Patch application equals recomputed state
- [ ] `awaiting` is `[]` exactly when the game has ended
- [ ] Determinism, order-independence and purity tests green

---

## Two decisions to make while porting

**Resolution order.** `{ kind: 'seat' }` is stable and simple but hands seat 0 a
permanent advantage in every contested resolution. `{ kind: 'shuffled' }` re-rolls
per round from the committed seed — unbiased, and ungrindable by either side.
Cheap to choose now; awkward once games exist on relays.

**What a missing submission means.** Simultaneous rounds cannot wait forever on
one player, so you need a `turn_timeout` and a defined `timeout_action` — most
likely "empty queue / hold position". It arrives as `input.system`, and it must
be a rule, not an accident.
