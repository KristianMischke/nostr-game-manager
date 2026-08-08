/**
 * Auditing a finished game (NIP-GM §Verification).
 *
 * Divergence found here is cryptographic evidence of a faulty or dishonest GM,
 * attributable to its pubkey. This is the actual trust mechanism of the
 * protocol — version strings and `rules_hash` are compatibility metadata, not
 * security.
 *
 * ## What this checks
 *
 * - Every event is signed by the GM whose announcement the auditor trusted, and
 *   the start event's id really is the game id.
 * - The revealed seed and salt reproduce the published `seed_commit`.
 * - Each cited move exists, and its revealed conversation key decrypts the
 *   original ciphertext to exactly the plaintext the GM published.
 * - Each round's moves are in the module's canonical resolution order.
 * - Where a player revised, the applied revision is the highest `rev` among the
 *   revisions the delta cited, ties broken by lowest event id.
 * - Re-running the module over the ordered inputs reproduces every published
 *   patch and `awaiting` set.
 * - No signed, legal, correctly-addressed move was silently dropped.
 *
 * ## What it deliberately does not check
 *
 * - **Who is at fault for an uncited revision.** Because a player uses one
 *   ephemeral key per round, a key the GM revealed for a cited revision also
 *   opens that player's uncited ones, so the audit can usually read them and
 *   report `uncited_higher_revision`. It cannot say *why* one exists: a GM that
 *   hid a revision and a player who published one after the round closed to
 *   discredit the GM leave the same trace, and `created_at` is author-asserted
 *   so it settles nothing. Reported as a warning for that reason. Events whose
 *   round revealed no key at all stay unreadable and are reported as
 *   `uncited_hidden_move`.
 * - **Events from anyone who is not seated.** They could never have been
 *   applied, so they are ignored entirely rather than reported — otherwise
 *   anyone could publish events at a finished game and pad its report.
 * - **`status` events**, which are GM-asserted progress reports carrying no
 *   state and are not replay inputs.
 *
 * - **Whether rejections were justified.** That needs the GM's response events,
 *   which are per-player and may be encrypted; pass them via `responses` to
 *   enable the check.
 * - **Private state contents.** Encrypted to individual players; an auditor
 *   cannot read them and is not supposed to.
 * - **Timeout plausibility beyond ordering.** Wall-clock judgement is a policy
 *   question, not a cryptographic one; `created_at` is GM-asserted anyway.
 * - **Collusion.** A GM that leaks hidden state to a confederate leaves no
 *   trace. Inherent to any trusted-dealer design and explicitly out of scope.
 */
import { canonicalJson } from '../codec/json.js';
import { parseMessage } from '../codec/message.js';
import {
  parseState,
  type AppliedMove,
  type GameDelta,
  type GameEnd,
  type GameStart,
} from '../codec/state.js';
import { verifySeedCommit } from '../crypto/commit.js';
import { verifyEvent } from '../crypto/event.js';
import { decrypt } from '../crypto/nip44.js';
import {
  parseMoveEnvelope,
  selectRevisions,
  type MoveEnvelope,
  type RevisionCandidate,
} from '../envelope.js';
import type { GameModule, ResolvedMove } from '../module/types.js';
import type { Hex, NostrEvent } from '../types.js';
import { isCanonicalOrder } from './ordering.js';
import { GameEngine } from './replay.js';

export interface AuditInput {
  /** The GM key from the announcement the auditor chose to trust. */
  gmPubkey: Hex;
  start: NostrEvent;
  /** Kind 2601/21601 events for this game: deltas, private, end/abort. */
  states: NostrEvent[];
  /** Kind 2600/21600 move messages referencing this game. */
  moves: NostrEvent[];
  /** Optional GM responses, to check that rejections were justified. */
  responses?: NostrEvent[];
}

export interface AuditFinding {
  severity: 'error' | 'warning';
  /** Stable code, so ports and tooling can agree on what was found. */
  code: string;
  seq?: number;
  detail: string;
}

export interface AuditReport<State = unknown> {
  /** True when no `error`-severity finding was recorded. */
  ok: boolean;
  gameId: Hex;
  findings: AuditFinding[];
  /** Rounds successfully replayed. */
  rounds: number;
  /** Final replayed state, absent if replay could not start. */
  state?: State;
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/**
 * Audit a finished game.
 *
 * `module` must be the implementation named by the start event's `(game,
 * version)`; verifying against a different ruleset proves nothing.
 */
export function auditGame<Config, State, Move, Patch>(
  module: GameModule<Config, State, Move, Patch>,
  input: AuditInput,
): AuditReport<State> {
  const findings: AuditFinding[] = [];
  const error = (code: string, detail: string, seq?: number): void => {
    findings.push({ severity: 'error', code, seq, detail });
  };
  const warn = (code: string, detail: string, seq?: number): void => {
    findings.push({ severity: 'warning', code, seq, detail });
  };

  const gameId = input.start.id;
  const done = (rounds: number, state?: State): AuditReport<State> => ({
    ok: !findings.some((f) => f.severity === 'error'),
    gameId,
    findings,
    rounds,
    state,
  });

  /* --- provenance ------------------------------------------------------- */

  if (!verifyEvent(input.start)) error('bad_signature', 'start event signature is invalid');
  if (input.start.pubkey !== input.gmPubkey) {
    error('wrong_author', 'start event was not authored by the trusted GM');
  }

  const parsedStart = parseState(input.start);
  if (!parsedStart.ok || parsedStart.value.type !== 'start') {
    error('bad_start', `start event did not parse: ${parsedStart.ok ? 'wrong type' : parsedStart.error}`);
    return done(0);
  }
  const start: GameStart = parsedStart.value;

  if (start.game !== module.id) {
    error('module_mismatch', `game is ${start.game}, module is ${module.id}`);
    return done(0);
  }
  if (start.version !== module.version) {
    warn('version_mismatch', `game is ${start.version}, module is ${module.version}`);
  }
  if (start.content.rulesHash && module.rulesHash && start.content.rulesHash !== module.rulesHash) {
    error('rules_hash_mismatch', 'start event rules_hash differs from the module');
  }

  /* --- sort state events, verify authorship ----------------------------- */

  const deltas: GameDelta[] = [];
  let end: GameEnd | undefined;

  for (const event of input.states) {
    if (!verifyEvent(event)) {
      error('bad_signature', `state event ${event.id.slice(0, 8)} signature is invalid`);
      continue;
    }
    if (event.pubkey !== input.gmPubkey) {
      error('wrong_author', `state event ${event.id.slice(0, 8)} was not authored by the GM`);
      continue;
    }
    const parsed = parseState(event);
    if (!parsed.ok) {
      error('bad_state_event', `state event did not parse: ${parsed.error}`);
      continue;
    }
    if (parsed.value.type === 'delta') deltas.push(parsed.value);
    else if (parsed.value.type === 'end' || parsed.value.type === 'abort') end = parsed.value;
  }

  deltas.sort((a, b) => a.seq - b.seq);

  // A gap or repeat in the chain means the log is incomplete or tampered, and
  // every downstream state comparison would be meaningless.
  for (let i = 0; i < deltas.length; i++) {
    if (deltas[i].seq !== i + 1) {
      error('seq_chain_broken', `expected seq ${i + 1}, found ${deltas[i].seq}`, deltas[i].seq);
      return done(0);
    }
  }

  /* --- seed reveal ------------------------------------------------------ */

  if (!end) {
    warn('no_end_event', 'game has no end or abort event; verification is partial');
  }

  let seed: Uint8Array | undefined;
  if (start.content.seedCommit) {
    if (!end?.content.seed || !end.content.salt) {
      error('no_seed_reveal', 'a seed was committed but never revealed');
    } else {
      seed = hexToBytes(end.content.seed);
      const salt = hexToBytes(end.content.salt);
      if (!verifySeedCommit(start.content.seedCommit, seed, salt)) {
        // The GM changed the seed after seeing play.
        error('seed_commit_mismatch', 'revealed seed and salt do not match the published commit');
        return done(0);
      }
    }
  }

  /* --- index the raw move log ------------------------------------------- */

  interface RawMove {
    event: NostrEvent;
    ephemeral?: Hex;
  }
  const rawMoves = new Map<Hex, RawMove>();

  for (const event of input.moves) {
    if (!verifyEvent(event)) {
      warn('bad_move_signature', `move ${event.id.slice(0, 8)} has an invalid signature`);
      continue;
    }
    const parsed = parseMessage(event);
    if (!parsed.ok || parsed.value.action !== 'move') continue;
    if (parsed.value.gameId !== gameId) continue;
    rawMoves.set(event.id, { event, ephemeral: parsed.value.ephemeral });
  }

  /* --- replay ----------------------------------------------------------- */

  let config: Config;
  try {
    config = module.parseConfig(start.content.config);
  } catch (e) {
    error('bad_config', `module rejected the start config: ${(e as Error).message}`);
    return done(0);
  }

  const engine = new GameEngine(module, {
    gameId,
    config,
    seats: start.seats,
    seed: seed ?? new Uint8Array(32),
  });

  /** Every id a delta cited at all, applied or superseded — none of these were dropped. */
  const citedIds = new Set<Hex>();
  /** Only ids that were actually applied; a superseded revision was legitimately not. */
  const appliedIds = new Set<Hex>();
  /**
   * Conversation keys the GM revealed, by player.
   *
   * A player uses one ephemeral key for a whole round, so revealing the key for
   * any one of their revisions reveals every revision of that round — including
   * ones the GM chose not to cite. That is what lets the pass below open
   * uncited moves instead of merely noting that they exist.
   */
  const revealedKeys = new Map<Hex, Set<string>>();
  /** (seq, player) → the revision the GM actually applied. */
  const appliedRev = new Map<string, number>();
  let rounds = 0;

  for (const delta of deltas) {
    const seq = delta.seq;
    const resolved: ResolvedMove<Move>[] = [];
    const candidates: RevisionCandidate[] = [];

    for (const entry of delta.content.applied) {
      citedIds.add(entry.id);
      appliedIds.add(entry.id);
      const opened = openCitedMove(entry, seq);
      if (!opened) continue;
      candidates.push({ id: entry.id, player: opened.player, envelope: opened.envelope });
      recordKey(entry, opened.player);
      appliedRev.set(`${seq}:${opened.player}`, opened.envelope.rev);
      const move = toResolved(entry, opened, seq);
      if (move) resolved.push(move);
    }

    // Superseded revisions are checked as strictly as applied ones, then fed
    // into the same selector the GM was required to run.
    for (const entry of delta.content.superseded ?? []) {
      citedIds.add(entry.id);
      const opened = openCitedMove(entry, seq);
      if (!opened) continue;
      candidates.push({ id: entry.id, player: opened.player, envelope: opened.envelope });
      recordKey(entry, opened.player);
    }

    // NIP-GM §Move revisions: highest rev wins, ties by lowest event id. Run
    // the rule rather than trusting the GM's choice — this is the check that
    // stops a GM applying a stale revision it happens to prefer.
    const winners = selectRevisions(candidates);
    for (const [player, winner] of winners) {
      if (appliedIds.has(winner.id)) continue;
      error(
        'revision_not_highest',
        `player ${player.slice(0, 8)} reached rev ${winner.envelope.rev} in move ${winner.id.slice(0, 8)}, but the GM applied an earlier revision`,
        seq,
      );
    }

    // Ordering must be reproducible from the events alone.
    if (!isCanonicalOrder(module.resolutionOrder, resolved, { seq, rng: engine.rng, seats: start.seats })) {
      error('order_not_canonical', 'published move order is not the module’s canonical order', seq);
    }

    let outcome;
    try {
      outcome = engine.applyRound(resolved, delta.content.system as never, delta.seq);
    } catch (e) {
      error('replay_threw', `module threw while applying round: ${(e as Error).message}`, seq);
      return done(rounds, engine.state);
    }

    // The GM's published patch must equal what the module recomputes.
    if (canonicalJson(outcome.patch) !== canonicalJson(delta.content.patch)) {
      error('patch_divergence', 'recomputed patch differs from the published patch', seq);
    }
    if (canonicalJson(outcome.awaiting) !== canonicalJson(delta.awaiting)) {
      error('awaiting_divergence', 'recomputed next actors differ from the delta’s p tags', seq);
    }

    rounds++;
    if (engine.isOver) break;
  }

  /* --- dropped moves ----------------------------------------------------- */

  for (const [id, raw] of rawMoves) {
    if (citedIds.has(id)) continue;

    // Only seated players can have had a move applied, so an uncited event from
    // anyone else is not evidence of anything. Without this, any stranger could
    // publish events at a finished game forever and pad its audit report — a
    // free way to make an honest GM's history look questionable.
    if (!start.seats.includes(raw.event.pubkey)) continue;

    // Try the keys revealed for this player's rounds. A whole round rides one
    // ephemeral key, so a key revealed for a cited revision also opens the
    // uncited ones — which is exactly the case worth reporting.
    const plaintext = parseMoveEnvelope(raw.event.content);
    const envelope = plaintext.ok
      ? plaintext.value
      : openWithRevealedKeys(raw.event.content, raw.event.pubkey);

    if (!envelope) {
      warn(
        'uncited_hidden_move',
        `encrypted move ${id.slice(0, 8)} from ${raw.event.pubkey.slice(0, 8)} was never cited and no revealed key opens it, so its revision cannot be checked`,
      );
      continue;
    }
    if (envelope.seq > deltas.length) continue;

    const applied = appliedRev.get(`${envelope.seq}:${raw.event.pubkey}`);
    if (applied !== undefined && envelope.rev > applied) {
      // Deliberately a warning, not an error, and the wording says why: the
      // log cannot distinguish a GM that hid this revision from a player who
      // published it after the fact to discredit the GM. Both are possible,
      // both leave this identical trace, and claiming to know which happened
      // would be the report overstating what the cryptography supports.
      warn(
        'uncited_higher_revision',
        `move ${id.slice(0, 8)} from ${raw.event.pubkey.slice(0, 8)} opens to seq ${envelope.seq} rev ${envelope.rev}, above the rev ${applied} the GM applied; either the GM omitted it or it was published after the round closed`,
        envelope.seq,
      );
      continue;
    }

    warn(
      'possible_dropped_move',
      `move ${id.slice(0, 8)} from ${raw.event.pubkey.slice(0, 8)} claims seq ${envelope.seq} rev ${envelope.rev} but was never applied`,
      envelope.seq,
    );
  }

  /* --- rejections -------------------------------------------------------- */

  if (input.responses) {
    for (const event of input.responses) {
      if (event.pubkey !== input.gmPubkey) continue;
      const parsed = parseMessage(event);
      if (!parsed.ok || parsed.value.action !== 'response') continue;
      // Deliberately `appliedIds`, not `citedIds`: answering a move and then
      // superseding it is the normal life of a revision, and only a move that
      // was rejected *and applied* is a contradiction.
      if (appliedIds.has(parsed.value.target)) {
        error(
          'rejected_then_applied',
          `move ${parsed.value.target.slice(0, 8)} was answered and also applied`,
        );
      }
    }
  }

  return done(rounds, engine.state);

  /**
   * Open one cited entry — applied or superseded — and confirm the plaintext
   * the GM published really is what the signed ciphertext contains.
   *
   * Shared by both citation lists on purpose: a superseded revision has to be
   * checked exactly as hard as an applied one, because the point of publishing
   * it is to prove which revision was highest, and an unverified `rev` in a
   * superseded entry would let a GM fabricate a loser to justify its winner.
   */
  function openCitedMove(
    entry: AppliedMove,
    seq: number,
  ): { envelope: MoveEnvelope; player: Hex; published: unknown } | undefined {
    const raw = rawMoves.get(entry.id);
    if (!raw) {
      error('cited_move_missing', `delta cites move ${entry.id.slice(0, 8)} which is not in the log`, seq);
      return undefined;
    }

    let envelope: MoveEnvelope;
    // Always taken from the envelope, never from `entry.move`: the GM's claim
    // about what a move said is the thing under test, so replaying it would
    // make the check circular.
    let published: unknown;

    if (entry.key) {
      // Hidden move: the revealed key must open the signed ciphertext to
      // exactly what the GM published. This is what makes the round auditable.
      let plaintext: string;
      try {
        plaintext = decrypt(raw.event.content, hexToBytes(entry.key));
      } catch (e) {
        error('reveal_failed', `revealed key does not decrypt move ${entry.id.slice(0, 8)}: ${(e as Error).message}`, seq);
        return undefined;
      }
      const parsed = parseMoveEnvelope(plaintext);
      if (!parsed.ok) {
        error('bad_revealed_envelope', `decrypted move ${entry.id.slice(0, 8)} is malformed: ${parsed.error}`, seq);
        return undefined;
      }
      envelope = parsed.value;
      const actual = { type: envelope.type, data: envelope.data };
      if (canonicalJson(actual) !== canonicalJson(entry.move)) {
        error('reveal_mismatch', `published plaintext for ${entry.id.slice(0, 8)} does not match the ciphertext`, seq);
        return undefined;
      }
      published = actual;
    } else {
      // Public move: the plaintext is on the wire, so compare it directly.
      const parsed = parseMoveEnvelope(raw.event.content);
      if (!parsed.ok) {
        error('bad_move_envelope', `move ${entry.id.slice(0, 8)} is malformed: ${parsed.error}`, seq);
        return undefined;
      }
      envelope = parsed.value;
      const actual = { type: envelope.type, data: envelope.data };
      if (entry.move !== undefined && canonicalJson(actual) !== canonicalJson(entry.move)) {
        error('applied_mismatch', `applied move ${entry.id.slice(0, 8)} differs from the signed event`, seq);
      }
      published = actual;
    }

    if (envelope.seq !== seq) {
      error('move_seq_mismatch', `move ${entry.id.slice(0, 8)} claims seq ${envelope.seq}, cited at ${seq}`, seq);
    }

    return { envelope, player: raw.event.pubkey, published };
  }

  /** Remember a revealed conversation key so uncited revisions can be tried against it. */
  function recordKey(entry: AppliedMove, player: Hex): void {
    if (!entry.key) return;
    const keys = revealedKeys.get(player) ?? new Set<string>();
    keys.add(entry.key);
    revealedKeys.set(player, keys);
  }

  /**
   * Try to open an uncited ciphertext with the keys this player's rounds
   * revealed.
   *
   * This works only because a player uses one ephemeral key for a whole round:
   * the key the GM had to publish for the revision it *did* cite also opens the
   * ones it did not. A design with a fresh key per revision would make hidden
   * revisions permanently unreadable and this check impossible.
   */
  function openWithRevealedKeys(content: string, player: Hex): MoveEnvelope | undefined {
    for (const key of revealedKeys.get(player) ?? []) {
      let plaintext: string;
      try {
        plaintext = decrypt(content, hexToBytes(key));
      } catch {
        continue; // Wrong round's key; try the next.
      }
      const parsed = parseMoveEnvelope(plaintext);
      if (parsed.ok) return parsed.value;
    }
    return undefined;
  }

  /** Turn an opened applied entry into a replay input. */
  function toResolved(
    entry: AppliedMove,
    opened: { player: Hex; published: unknown },
    seq: number,
  ): ResolvedMove<Move> | undefined {
    const move = module.parseMove(opened.published);
    if (move === undefined) {
      error('module_rejected_move', `module could not parse applied move ${entry.id.slice(0, 8)}`, seq);
      return undefined;
    }
    return {
      id: entry.id,
      player: opened.player,
      seat: start.seats.indexOf(opened.player),
      move,
    };
  }
}
