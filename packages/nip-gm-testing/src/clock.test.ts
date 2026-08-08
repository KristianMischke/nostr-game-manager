import { describe, expect, it, vi } from 'vitest';
import { createManualClock } from './clock.js';

describe('createManualClock', () => {
  it('does not fire before the deadline', () => {
    const clock = createManualClock(1000);
    const fn = vi.fn();
    clock.setTimeout(60, fn);
    clock.advance(59);
    expect(fn).not.toHaveBeenCalled();
    clock.advance(1);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('fires callbacks in deadline order, not scheduling order', () => {
    const clock = createManualClock(0);
    const seen: string[] = [];
    clock.setTimeout(30, () => seen.push('late'));
    clock.setTimeout(10, () => seen.push('early'));
    clock.advance(60);
    expect(seen).toEqual(['early', 'late']);
  });

  it('reports the callback’s own time inside the callback, not the target time', () => {
    // A GM stamping a timeout system input must record when the timeout was
    // due, not how far the test happened to jump.
    const clock = createManualClock(1000);
    let observed = 0;
    clock.setTimeout(10, () => {
      observed = clock.now();
    });
    clock.advance(500);
    expect(observed).toBe(1010);
    expect(clock.now()).toBe(1500);
  });

  it('runs timers scheduled from within a callback', () => {
    const clock = createManualClock(0);
    const seen: string[] = [];
    clock.setTimeout(10, () => {
      seen.push('first');
      clock.setTimeout(5, () => seen.push('chained'));
    });
    clock.advance(100);
    expect(seen).toEqual(['first', 'chained']);
  });

  it('honours cancellation', () => {
    const clock = createManualClock(0);
    const fn = vi.fn();
    clock.setTimeout(10, fn).cancel();
    clock.advance(100);
    expect(fn).not.toHaveBeenCalled();
    expect(clock.pending).toBe(0);
  });

  it('jumps to the next deadline with runNext', () => {
    const clock = createManualClock(0);
    const fn = vi.fn();
    clock.setTimeout(42, fn);
    expect(clock.runNext()).toBe(42);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(clock.pending).toBe(0);
  });
});
