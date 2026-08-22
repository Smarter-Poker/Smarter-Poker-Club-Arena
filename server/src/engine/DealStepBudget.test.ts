/**
 * THE BETWEEN-HANDS BUDGET — behavioural proof.
 *
 * On 2026-08-22 the live fleet logged 1,603 `dealing_loop_dead` kills in six
 * hours. Every running cash table was killed 22-30 times, each after an
 * average of three hands, and `hand_history` showed the shape exactly: normal
 * 8-45s hand spacing, then gaps of 107s, 107s, 114s, 87s — two 90s watchdog
 * trips plus a rebuild, over and over, on fully funded tables with nothing
 * wrong with them.
 *
 * The cause was that the path BETWEEN hands — load seats, refresh blinds,
 * refresh rake, apply add-ons, recover busted horses — is five Supabase round
 * trips with nothing bounding them and nothing marking progress while they
 * run, sitting under a 90s watchdog. Database slowness is correlated across
 * tables, so one slow minute stalled the whole fleet at once, got every engine
 * killed at once, and the rebuild storm then loaded the database harder than
 * the slowness that started it.
 *
 * `withStepBudget` is what stops a step from being able to outlast the
 * watchdog silently. These pin the two things it must do.
 */

import { describe, it, expect } from 'vitest';
import { ServerTableEngine } from './ServerTableEngine.js';

const TABLE = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

const engine = () => new ServerTableEngine(TABLE) as any;

describe('withStepBudget', () => {
  it('returns the step result and stamps the phase it ran in', async () => {
    const e = engine();
    const seats = await e.withStepBudget('load_seats', 5_000, Promise.resolve(['a', 'b']));
    expect(seats).toEqual(['a', 'b']);
    expect(e.loopPhase).toBe('load_seats');
    // Freshly stamped: this is what tells the watchdog the loop is moving.
    expect(e.msSinceLoopPhase()).toBeLessThan(1_000);
  });

  it('rejects a step that outlasts its budget, naming the step', async () => {
    const e = engine();
    // A promise that never settles is exactly what a hung Supabase socket
    // looks like from here.
    const hung = new Promise(() => {});
    await expect(e.withStepBudget('refresh_rake', 20, hung)).rejects.toThrow(/refresh_rake/);
  });

  it('rejects with a message the dealing loop already treats as transient', async () => {
    // The loop backs off and retries on `deal_step_timeout` instead of
    // counting the step toward its 10-consecutive-error shutdown. A slow
    // database must never be able to stop an engine — a rebuilt engine cannot
    // make a database faster, it can only add another reconnect to one that is
    // already struggling.
    const e = engine();
    await expect(e.withStepBudget('load_seats', 20, new Promise(() => {}))).rejects.toThrow(
      /deal_step_timeout/
    );
  });

  it('re-stamps the clock on every visit, so a cycling loop never looks wedged', async () => {
    const e = engine();
    await e.withStepBudget('load_seats', 5_000, Promise.resolve(null));
    e.loopPhaseSinceMs = Date.now() - 200_000; // pretend a long time passed
    expect(e.msSinceLoopPhase()).toBeGreaterThan(150_000);
    // Second time through the same step is new evidence of life, not a
    // continuation of the first.
    await e.withStepBudget('load_seats', 5_000, Promise.resolve(null));
    expect(e.msSinceLoopPhase()).toBeLessThan(1_000);
  });
});
