/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  A RECOVERY THAT FLOODS THE DECISION PIPELINE IS NOT A RECOVERY (2026-09-27)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * RUNNING re-adoption is budgeted under the C20 AIMD law
 * (tournamentResumeBudget.ts), and before today the only thing that could
 * make a pass distressed - and so halve the budget - was a resume that came
 * back WITHOUT a manager.
 *
 * On 2026-09-22 at 13:24 UTC twenty-two events were re-adopted and their
 * tables began dealing. Every one of those resumes SUCCEEDED, so no pass was
 * ever distressed and the budget climbed +5 per pass to its ceiling of 25 -
 * while the live horse-decision pipeline went `expiredJobs` 0 -> 1,320 and
 * `oldestQueuedAgeMs` 0 -> 9,274 ms, and horses timed out in the middle of
 * hands on the very tables the recovery had just restored.
 *
 * Measured on 2026-09-27 while writing this, the same blind spot was still
 * open: /health read `tournamentResumeBudget` 25 - the ceiling - with 48
 * resumes failing.
 *
 * Horses are players. A table whose players cannot decide is not a recovered
 * table, so the pipeline's own health is now a distress input to the same
 * AIMD law, beside the resume outcomes.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { sliceMethod } from './testHelpers/sourceWindow.js';
import {
  DECISION_QUEUE_AGE_DISTRESS_MS,
  decisionPipelineDistress,
} from './decisionPipelinePressure.js';
import {
  ENGINE_START_BUDGET_MAX,
  ENGINE_START_BUDGET_MIN,
  nextEngineStartBudget,
} from './engineStartBudget.js';

/** The healthy fleet measured on production 2026-09-27: 156 tables dealing. */
const HEALTHY = { oldestQueuedAgeMs: 584, expiredJobs: 55 };
/** The 2026-09-22 13:24 flood. */
const FLOOD = { oldestQueuedAgeMs: 9_274, expiredJobs: 1_320 };

describe('the queue age says the pipeline is behind before anything is lost', () => {
  it('a healthy busy fleet is not distress', () => {
    const verdict = decisionPipelineDistress(HEALTHY, HEALTHY.expiredJobs);
    expect(verdict.distressed).toBe(false);
    expect(verdict.expiredBaseline).toBe(55);
  });

  it('the threshold sits above a healthy read and well under the flood', () => {
    expect(DECISION_QUEUE_AGE_DISTRESS_MS).toBeGreaterThan(HEALTHY.oldestQueuedAgeMs);
    expect(DECISION_QUEUE_AGE_DISTRESS_MS).toBeLessThan(FLOOD.oldestQueuedAgeMs);
  });

  it('a queue that has fallen behind is distress on its own', () => {
    // No new expiries yet: this is the leading signal, caught before damage.
    const verdict = decisionPipelineDistress(
      { oldestQueuedAgeMs: DECISION_QUEUE_AGE_DISTRESS_MS, expiredJobs: 55 },
      55
    );
    expect(verdict.distressed).toBe(true);
  });

  it('an empty queue is never distress', () => {
    expect(
      decisionPipelineDistress({ oldestQueuedAgeMs: null, expiredJobs: 55 }, 55).distressed
    ).toBe(false);
  });
});

describe('a horse that timed out mid-hand is damage, and needs no threshold', () => {
  it('any new expiry since the previous pass is distress', () => {
    expect(
      decisionPipelineDistress({ oldestQueuedAgeMs: 12, expiredJobs: 56 }, 55).distressed
    ).toBe(true);
  });

  it('the same expiries read twice are not distress twice', () => {
    const first = decisionPipelineDistress(FLOOD, 0);
    expect(first.distressed).toBe(true);
    expect(first.expiredBaseline).toBe(1_320);
    // The flood has drained; the counter has not gone anywhere.
    const second = decisionPipelineDistress(
      { oldestQueuedAgeMs: 120, expiredJobs: 1_320 },
      first.expiredBaseline
    );
    expect(second.distressed).toBe(false);
  });

  it('a worker restart rebases rather than claiming a repair', () => {
    // A restarted lane counts from zero. That is a new lane, not a fixed one.
    const verdict = decisionPipelineDistress({ oldestQueuedAgeMs: 10, expiredJobs: 3 }, 1_320);
    expect(verdict.distressed).toBe(false);
    expect(verdict.expiredBaseline).toBe(3);
    // And the very next new expiry on the restarted lane is distress again.
    expect(
      decisionPipelineDistress({ oldestQueuedAgeMs: 10, expiredJobs: 4 }, verdict.expiredBaseline)
        .distressed
    ).toBe(true);
  });
});

describe('an unreadable pipeline may slow a recovery, never stop one', () => {
  it.each([[null], [undefined]])('a missing lane reads as no pressure (%s)', (reading) => {
    const verdict = decisionPipelineDistress(reading as never, 77);
    expect(verdict.distressed).toBe(false);
    expect(verdict.expiredBaseline).toBe(77);
  });

  it('a non-finite reading is measured as nothing, not as congestion', () => {
    const verdict = decisionPipelineDistress(
      { oldestQueuedAgeMs: Number.NaN, expiredJobs: Number.NaN },
      42
    );
    expect(verdict.distressed).toBe(false);
    expect(verdict.expiredBaseline).toBe(42);
  });
});

describe('the verdict drives the same AIMD law, and the floor still holds', () => {
  it('a flood halves the budget instead of letting it climb', () => {
    const flooded = decisionPipelineDistress(FLOOD, 0).distressed;
    expect(nextEngineStartBudget(ENGINE_START_BUDGET_MAX, flooded)).toBe(
      Math.floor(ENGINE_START_BUDGET_MAX / 2)
    );
  });

  it('sustained flooding retreats to the floor and never below it', () => {
    let budget = ENGINE_START_BUDGET_MAX;
    let baseline = 0;
    for (let pass = 0; pass < 12; pass++) {
      const verdict = decisionPipelineDistress(
        { oldestQueuedAgeMs: 9_274, expiredJobs: 1_320 + pass * 100 },
        baseline
      );
      baseline = verdict.expiredBaseline;
      budget = nextEngineStartBudget(budget, verdict.distressed);
    }
    // The fleet keeps converging at full retreat rather than stalling.
    expect(budget).toBe(ENGINE_START_BUDGET_MIN);
  });

  it('a pipeline that recovers lets the budget climb back additively', () => {
    let budget = ENGINE_START_BUDGET_MIN;
    let baseline = 1_320;
    for (let pass = 0; pass < 6; pass++) {
      const verdict = decisionPipelineDistress(HEALTHY, baseline);
      baseline = verdict.expiredBaseline;
      budget = nextEngineStartBudget(budget, verdict.distressed);
    }
    expect(budget).toBe(ENGINE_START_BUDGET_MAX);
  });
});

describe('the re-adoption pass is wired to the pipeline it spends', () => {
  const GAMESERVER = readFileSync(resolve(import.meta.dirname, 'GameServer.ts'), 'utf8');
  const PASS = sliceMethod(GAMESERVER, 'private async discoverRunningResumes(');

  it('the pass reads the live lane and feeds the same distress verdict', () => {
    expect(GAMESERVER).toContain("from './decisionPipelinePressure.js'");
    expect(PASS).toContain('decisionPipelineDistress(');
    expect(PASS).toContain('liveHorseDecisionWorkerStatus()');
    expect(PASS).toContain('|| decisionPressure.distressed');
  });

  it('the expiry baseline is carried across passes, not recomputed from zero', () => {
    expect(PASS).toContain('this.decisionPipelineExpiredBaseline');
    expect(PASS).toContain(
      'this.decisionPipelineExpiredBaseline = decisionPressure.expiredBaseline;'
    );
  });

  it('the verdict still reaches exactly one AIMD adjustment per pass', () => {
    expect(PASS).toContain('nextEngineStartBudget(');
    expect((PASS.match(/nextEngineStartBudget\(/g) ?? []).length).toBe(1);
    // Pacing is a budget, never a sleep, a sweep or a watchdog.
    expect(PASS).not.toMatch(/setInterval|watchdog|healer/i);
  });
});
