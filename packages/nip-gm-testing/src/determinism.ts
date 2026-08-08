/**
 * Determinism checks for a game module.
 *
 * NIP-GM's whole trust model rests on a module being a pure function of
 * `(config, seed, ordered inputs)`: the GM runs it forward, an auditor re-runs
 * it years later, and a mismatch is supposed to mean the GM cheated. A module
 * that is quietly non-deterministic turns that signal into noise — it manufactures
 * divergence where there was no dishonesty.
 *
 * These are the checks from `docs/porting-game-logic.md` §15, packaged.
 */
import { canonicalJson, replay, type GameLog, type GameModule } from 'nip-gm-core';

export interface DeterminismReport {
  ok: boolean;
  findings: { code: string; detail: string }[];
}

export interface DeterminismOptions {
  /**
   * Also assert that shuffling the input order of each round's moves does not
   * change the outcome. Enable for modules whose rounds are simultaneous;
   * meaningless for strict turn-taking, where each round holds one move.
   */
  checkOrderIndependence?: boolean;
}

/**
 * Recursively freeze, so an accidental mutation throws in strict mode.
 *
 * Typed arrays and buffers are skipped: `Object.freeze` throws outright on a
 * non-empty `ArrayBuffer` view, so freezing the seed would report a mutation
 * that never happened. They are read-only to the engine in any case.
 */
function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return value;
  for (const key of Object.keys(value as object)) {
    deepFreeze((value as Record<string, unknown>)[key]);
  }
  return Object.freeze(value);
}

/**
 * Run a module against a log several ways and report anything non-deterministic.
 *
 * Note this proves absence of the *observed* nondeterminism, not its
 * impossibility: a module that branches on `Math.random()` only once in a
 * thousand rounds needs a log that reaches that branch. Treat a green report as
 * evidence, not proof.
 */
export function checkDeterminism<Config, State, Move, Patch>(
  module: GameModule<Config, State, Move, Patch>,
  log: GameLog<Config, Move>,
  options: DeterminismOptions = {},
): DeterminismReport {
  const findings: DeterminismReport['findings'] = [];
  const add = (code: string, detail: string): void => {
    findings.push({ code, detail });
  };

  const serialize = (state: State): string => canonicalJson(module.serialize(state));

  // 1. Same input twice, same output.
  let baseline: string;
  try {
    baseline = serialize(replay(module, log).state);
  } catch (e) {
    add('replay_threw', `module threw on a clean replay: ${(e as Error).message}`);
    return { ok: false, findings };
  }

  const second = serialize(replay(module, log).state);
  if (second !== baseline) {
    add('not_reproducible', 'two replays of the same log produced different states');
  }

  // 2. No ambient nondeterminism. Stubbing these to throw catches the module
  //    reaching for them even where the value would have looked harmless.
  const realRandom = Math.random;
  const realNow = Date.now;
  const realPerf = globalThis.performance?.now;
  try {
    Math.random = () => {
      throw new Error('Math.random() is not deterministic');
    };
    Date.now = () => {
      throw new Error('Date.now() is not deterministic');
    };
    if (globalThis.performance) {
      globalThis.performance.now = () => {
        throw new Error('performance.now() is not deterministic');
      };
    }
    const stubbed = serialize(replay(module, log).state);
    if (stubbed !== baseline) add('ambient_state', 'replay differed with clock and RNG stubbed');
  } catch (e) {
    add('ambient_nondeterminism', (e as Error).message);
  } finally {
    Math.random = realRandom;
    Date.now = realNow;
    if (globalThis.performance && realPerf) globalThis.performance.now = realPerf;
  }

  // 3. Purity: the module must not mutate the state or the round handed to it.
  //    Freezing the log alone is not enough — the states that matter are the
  //    intermediate ones the engine threads through, so wrap the module and
  //    freeze at every boundary.
  try {
    const frozenModule: GameModule<Config, State, Move, Patch> = {
      ...module,
      init: (ctx) => deepFreeze(module.init(ctx)),
      apply: (state, input, ctx) => {
        const result = module.apply(deepFreeze(state), deepFreeze(input), ctx);
        return { ...result, state: deepFreeze(result.state) };
      },
    };
    const frozenLog: GameLog<Config, Move> = deepFreeze({
      ...log,
      rounds: log.rounds.map((r) => ({ ...r, moves: [...r.moves] })),
    });
    const fromFrozen = serialize(replay(frozenModule, frozenLog).state);
    if (fromFrozen !== baseline) {
      add('impure', 'replay over frozen inputs produced a different state');
    }
  } catch (e) {
    add(
      'mutates_input',
      `module mutated a state or round it was given: ${(e as Error).message}`,
    );
  }

  // 4. Arrival order must not matter. The engine sorts each round into the
  //    module's canonical order before `apply` sees it, so this is really a
  //    joint check on the engine/module pair: it fires if a module re-sorts on
  //    something unstable, or reaches past `moves` to arrival order.
  if (options.checkOrderIndependence) {
    const reversed: GameLog<Config, Move> = {
      ...log,
      rounds: log.rounds.map((r) => ({ ...r, moves: [...r.moves].reverse() })),
    };
    try {
      if (serialize(replay(module, reversed).state) !== baseline) {
        add(
          'order_dependent',
          'reversing each round’s arrival order changed the outcome — the module is not honouring its declared resolutionOrder',
        );
      }
    } catch (e) {
      add('order_check_threw', (e as Error).message);
    }
  }

  return { ok: findings.length === 0, findings };
}
