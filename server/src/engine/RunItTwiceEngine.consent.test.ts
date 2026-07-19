/**
 * RUN IT TWICE — unanimous consent (FIX-A8, 2026-07-19).
 *
 * Bible V8 §4.20: running the board twice requires the agreement of EVERY
 * all-in player, not just the chooser plus one opponent. These assert that a
 * 3-way all-in does not proceed until all three consent, that non-participants
 * cannot consent, and that the heads-up (2-player) path is unchanged.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { RunItTwiceEngine } from './RunItTwiceEngine.js';
import type { DeadlineScheduler } from './DeadlineScheduler.js';

// Inert scheduler so tests don't arm real timers / leave open handles.
const stubScheduler = {
  start() {},
  schedule() {},
  cancel() {},
} as unknown as DeadlineScheduler;

function mkEngine() {
  const engine = new RunItTwiceEngine(undefined, stubScheduler);
  engine.configure('t1', { enabled: true, autoDeclineTimeout: 10, maxRuns: 2 });
  return engine;
}

describe('RIT unanimous consent', () => {
  let engine: RunItTwiceEngine;
  beforeEach(() => {
    engine = mkEngine();
  });

  it('3-way all-in: does NOT proceed until every all-in player accepts', () => {
    engine.offer('t1', 't1:1', 'A', ['A', 'B', 'C'], 300); // A = chooser (pre-accepted)
    expect(engine.isActive('t1')).toBe(false); // status 'offered', not yet accepted

    expect(engine.accept('t1', 'B')).toBe(false); // one opponent only — not enough
    expect(engine.isActive('t1')).toBe(false);
    expect(engine.getState('t1')?.status).toBe('offered');

    expect(engine.accept('t1', 'C')).toBe(true); // now unanimous
    expect(engine.isActive('t1')).toBe(true);
    expect(engine.getState('t1')?.status).toBe('accepted');
  });

  it('a non-participant cannot consent', () => {
    engine.offer('t1', 't1:1', 'A', ['A', 'B', 'C'], 300);
    expect(engine.accept('t1', 'Z')).toBe(false);
    expect(engine.accept('t1', 'B')).toBe(false);
    expect(engine.accept('t1', 'C')).toBe(true);
  });

  it('any all-in player declining kills RIT for everyone', () => {
    engine.offer('t1', 't1:1', 'A', ['A', 'B', 'C'], 300);
    expect(engine.accept('t1', 'B')).toBe(false);
    engine.decline('t1', 'C');
    expect(engine.getState('t1')?.status).toBe('declined');
    expect(engine.isActive('t1')).toBe(false);
  });

  it('heads-up (2-player) path is unchanged: the single opponent accepting is enough', () => {
    engine.offer('t1', 't1:1', 'A', ['A', 'B'], 200);
    expect(engine.accept('t1', 'B')).toBe(true);
    expect(engine.isActive('t1')).toBe(true);
    expect(engine.getState('t1')?.status).toBe('accepted');
  });
});
