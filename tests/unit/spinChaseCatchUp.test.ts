/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  A CLIENT THAT JOINS MID-CHASE JOINS THE CHASE, NOT THE START OF IT
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The spin reveal is a SHARED moment: the engine names an instant, every seat
 * animates against it, and a client that loads slowly or refreshes picks the
 * wheel up where everyone else is. `SpinWheel` does that with
 *
 *     const at = (offsetMs) => Math.max(0, offsetMs - elapsed);
 *
 * and every phase — lead-in, countdown, chase, result, fade — is scheduled
 * through it.
 *
 * Every phase except the chase's own light steps. Those were scheduled at
 * their RAW offsets:
 *
 *     schedule.forEach((offset, stepIdx) =>
 *       timers.push(setTimeout(() => setLitIndex(stepIdx % order.length), offset)));
 *
 * so they always replayed from step one over the full `chaseMs`. A client that
 * joined two seconds into a six-second chase therefore got the RESULT card at
 * the correct instant — `at()` handled that — while the runner was still
 * walking from the beginning, and its remaining steps then overwrote
 * `setLitIndex(targetIndex)` for the rest of the chase.
 *
 * The visible consequence: the light lands on the winner, walks off it, and
 * keeps going. On a table where three seats are meant to be watching the same
 * disc, the one player who reloaded watches it stop somewhere else. The
 * ticking had the same shape — `playSpinTicking` was handed the full schedule,
 * so pegs kept striking after the prize was announced.
 */

import { describe, it, expect } from 'vitest';
import { chaseSchedule, chaseCatchUp } from '../../src/components/tournament/SpinWheel';

const CHASE_MS = 6000;
const SEGMENTS = 8;
const TARGET = 5;

describe('a client that is on time replays nothing', () => {
  const schedule = chaseSchedule(SEGMENTS, TARGET, CHASE_MS);

  it('keeps every step when no time has elapsed', () => {
    const { litNow, remaining } = chaseCatchUp(schedule, 0);
    expect(remaining).toHaveLength(schedule.length);
    expect(litNow).toBe(-1); // nothing behind us, so nothing to pre-light
  });

  it('leaves the step offsets exactly as the easing put them', () => {
    const { remaining } = chaseCatchUp(schedule, 0);
    expect(remaining.map((r) => r.at)).toEqual(schedule);
  });
});

describe('a client that joins mid-chase', () => {
  const schedule = chaseSchedule(SEGMENTS, TARGET, CHASE_MS);
  const HALFWAY = CHASE_MS / 2;

  it('drops the steps that have already happened', () => {
    const { remaining } = chaseCatchUp(schedule, HALFWAY);
    expect(remaining.length).toBeLessThan(schedule.length);
    expect(remaining.length).toBeGreaterThan(0);
  });

  it('rebases the rest so none of them is in the past', () => {
    const { remaining } = chaseCatchUp(schedule, HALFWAY);
    for (const step of remaining) expect(step.at).toBeGreaterThan(0);
  });

  it('the last remaining step still lands at the end of the chase', () => {
    /* The runner must still arrive on the winner at the same wall-clock
       instant it would have for everyone else — that is the whole point of a
       shared moment. Its offset from NOW is simply what is left of the chase. */
    const { remaining } = chaseCatchUp(schedule, HALFWAY);
    const last = remaining[remaining.length - 1];
    expect(last.at).toBe(schedule[schedule.length - 1] - HALFWAY);
    expect(last.stepIdx).toBe(schedule.length - 1);
  });

  it('reports where the runner already IS, so the disc is never blank', () => {
    const { litNow } = chaseCatchUp(schedule, HALFWAY);
    expect(litNow).toBeGreaterThanOrEqual(0);
    // It is the last step whose time has passed, not an arbitrary one.
    expect(schedule[litNow]).toBeLessThanOrEqual(HALFWAY);
    expect(schedule[litNow + 1]).toBeGreaterThan(HALFWAY);
  });
});

describe('a client that joins after the chase is over', () => {
  const schedule = chaseSchedule(SEGMENTS, TARGET, CHASE_MS);

  it('schedules nothing at all', () => {
    const { remaining } = chaseCatchUp(schedule, CHASE_MS + 1);
    expect(remaining).toHaveLength(0);
  });

  it('and the runner is left on the final step, which is the winner', () => {
    /* chaseSchedule ends on `targetIndex`: the last step index is
       CHASE_LOOPS*n + (target%n), so stepIdx % n is the winning segment. That
       is what the disc must be showing when the result card arrives. */
    const { litNow } = chaseCatchUp(schedule, CHASE_MS + 1);
    expect(litNow).toBe(schedule.length - 1);
    expect(litNow % SEGMENTS).toBe(TARGET % SEGMENTS);
  });
});

describe('the regression itself', () => {
  it('the un-caught-up schedule would still be stepping after the result', () => {
    /* This is what shipped. With 2s of a 6s chase already gone, the raw
       schedule's final step was 6s away — a full 2s past the moment the
       result card was due, which is when setLitIndex(targetIndex) runs. Every
       step after that instant walked the light off the winner. */
    const schedule = chaseSchedule(SEGMENTS, TARGET, CHASE_MS);
    const elapsedIntoChase = 2000;
    const resultDueIn = CHASE_MS - elapsedIntoChase; // what at() gives the result

    const rawLast = schedule[schedule.length - 1];
    expect(rawLast).toBeGreaterThan(resultDueIn); // the bug: steps outlive the result

    const { remaining } = chaseCatchUp(schedule, elapsedIntoChase);
    const fixedLast = remaining[remaining.length - 1].at;
    expect(fixedLast).toBeLessThanOrEqual(resultDueIn); // the fix: they cannot
  });

  it('no step survives past the result on any join time', () => {
    const schedule = chaseSchedule(SEGMENTS, TARGET, CHASE_MS);
    for (const elapsedIntoChase of [0, 1, 500, 2000, 4500, 5999, 6000]) {
      const resultDueIn = Math.max(0, CHASE_MS - elapsedIntoChase);
      const { remaining } = chaseCatchUp(schedule, elapsedIntoChase);
      for (const step of remaining) {
        expect(
          step.at,
          `a light step at +${step.at}ms outlives a result due in ${resultDueIn}ms`
        ).toBeLessThanOrEqual(resultDueIn);
      }
    }
  });
});

describe('it cannot be handed nonsense', () => {
  it('a negative elapsed is treated as none', () => {
    const schedule = chaseSchedule(SEGMENTS, TARGET, CHASE_MS);
    expect(chaseCatchUp(schedule, -5000).remaining).toHaveLength(schedule.length);
  });

  it('a NaN elapsed is treated as none rather than dropping every step', () => {
    const schedule = chaseSchedule(SEGMENTS, TARGET, CHASE_MS);
    expect(chaseCatchUp(schedule, Number.NaN).remaining).toHaveLength(schedule.length);
  });

  it('an empty schedule (reduced motion) is not an error', () => {
    expect(chaseCatchUp([], 1234)).toEqual({ litNow: -1, remaining: [] });
  });
});
