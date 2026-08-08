/**
 * A hand-advanced clock implementing the `Clock` port.
 *
 * Turn timeouts are a first-class protocol input (NIP-GM §Game Modules
 * requires them materialized as signed system inputs), so tests must be able to
 * fire a 60-second timeout without waiting 60 seconds. Injecting time also
 * makes an accidental `Date.now()` in game code show up as a test that passes
 * only in real time.
 */
import type { Clock } from 'nip-gm-core';

interface Scheduled {
  at: number;
  fn: () => void;
  cancelled: boolean;
}

export interface ManualClock extends Clock {
  /** Advance by `seconds`, firing everything scheduled in that window, in order. */
  advance(seconds: number): void;
  /** Jump straight to the next scheduled callback, if any. Returns the new time. */
  runNext(): number;
  readonly pending: number;
}

export function createManualClock(startAt = 1_700_000_000): ManualClock {
  let current = startAt;
  const scheduled: Scheduled[] = [];

  const fireDueUpTo = (time: number): void => {
    for (;;) {
      const due = scheduled
        .filter((s) => !s.cancelled && s.at <= time)
        .sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      due.cancelled = true;
      // Advance to the callback's own time before running it, so anything it
      // schedules is relative to when it actually fired.
      current = due.at;
      due.fn();
    }
    current = time;
  };

  return {
    now: () => current,

    setTimeout(seconds, fn) {
      const entry: Scheduled = { at: current + seconds, fn, cancelled: false };
      scheduled.push(entry);
      return {
        cancel: () => {
          entry.cancelled = true;
        },
      };
    },

    advance(seconds) {
      fireDueUpTo(current + seconds);
    },

    runNext() {
      const next = scheduled.filter((s) => !s.cancelled).sort((a, b) => a.at - b.at)[0];
      if (next) fireDueUpTo(next.at);
      return current;
    },

    get pending() {
      return scheduled.filter((s) => !s.cancelled).length;
    },
  };
}
