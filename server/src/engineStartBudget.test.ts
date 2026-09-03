/**
 * C20 (2026-08-23): the engine adoption budget.
 *
 * THE INCIDENT
 * Nine minutes after a routine engine restart, production logged 686 statement
 * timeouts in three minutes, 35 hand-history insert failures, 21 lost table
 * leases, a discovery loop stalled for 108 seconds, and /health reporting
 * liveness dead while the process itself was perfectly healthy. Hand
 * throughput fell from ~250/min to 24/min.
 *
 * pg_stat_activity showed ZERO lock waits throughout, and 25 of 90 connections
 * simultaneously active. So this was never contention - the hand_history hot
 * row fixed earlier the same day stayed fixed. It was raw concurrency: on a
 * restart no table has an engine, so discovery adopted the entire ~180-table
 * fleet inside a single sweep, and because engine.start() is fired and not
 * awaited, all of their seat and config reads were in flight at once.
 *
 * WHY IT LASTED MINUTES RATHER THAN SECONDS
 * The 40ms C19 stagger spread the initiation of starts across ~7s, so on its
 * own the burst would have cleared quickly. What made it persist is that
 * failure was free to repeat: a start that times out runs a .catch which
 * deletes the table from tableEngines, which makes it eligible again on the
 * very next sweep. Load caused failure; failure recreated the load; nothing in
 * the loop noticed it was the source of its own problem.
 *
 * THE FIX UNDER TEST
 * A per-sweep adoption budget governed by additive-increase /
 * multiplicative-decrease. These tests pin the control law itself. The wiring
 * that applies it - the loop bound, the failure counter, and both back-off
 * sites - is pinned by todaysIncidentsStayFixed.test.ts, because a correct law
 * that nothing calls would still have let this incident happen.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  nextEngineStartBudget,
  ENGINE_START_BUDGET_MAX,
  ENGINE_START_BUDGET_MIN,
  ENGINE_START_BUDGET_RECOVER,
} from './engineStartBudget.js';

describe('C20 engine adoption budget', () => {
  it('has a ceiling above its floor, so a healthy boot is not slowed down', () => {
    // The budget only exists to bound distress. Absent any failure signal it
    // must not tax a database that is coping.
    expect(ENGINE_START_BUDGET_MAX).toBeGreaterThan(ENGINE_START_BUDGET_MIN);
  });

  it('halves on distress - retreat is immediate', () => {
    expect(nextEngineStartBudget(25, true)).toBe(12);
    expect(nextEngineStartBudget(12, true)).toBe(6);
  });

  it('never retreats below the floor, so the fleet always converges', () => {
    // A budget of 0 would be a deadlock dressed up as safety: no table would
    // ever be adopted again and nothing would generate the clean sweep needed
    // to recover. Slow convergence beats none.
    expect(nextEngineStartBudget(6, true)).toBe(ENGINE_START_BUDGET_MIN);
    expect(nextEngineStartBudget(ENGINE_START_BUDGET_MIN, true)).toBe(ENGINE_START_BUDGET_MIN);
    expect(nextEngineStartBudget(1, true)).toBe(ENGINE_START_BUDGET_MIN);
  });

  it('recovers additively, not multiplicatively', () => {
    // Doubling back up would re-create the burst that caused the incident the
    // moment the database drew breath. That is the oscillation AIMD exists to
    // prevent, so the asymmetry is the whole point of the design.
    expect(nextEngineStartBudget(5, false)).toBe(5 + ENGINE_START_BUDGET_RECOVER);
    expect(nextEngineStartBudget(10, false)).toBe(10 + ENGINE_START_BUDGET_RECOVER);
  });

  it('never recovers above the ceiling', () => {
    expect(nextEngineStartBudget(ENGINE_START_BUDGET_MAX, false)).toBe(ENGINE_START_BUDGET_MAX);
    expect(nextEngineStartBudget(ENGINE_START_BUDGET_MAX - 1, false)).toBe(ENGINE_START_BUDGET_MAX);
  });

  it('retreat outpaces recovery wherever the budget is large enough to matter', () => {
    // The invariant that makes the law stable. If recovery could ever outpace
    // retreat, sustained distress would not actually reduce load.
    for (let b = ENGINE_START_BUDGET_MIN * 2 + 1; b <= ENGINE_START_BUDGET_MAX; b++) {
      const down = b - nextEngineStartBudget(b, true);
      const up = nextEngineStartBudget(b, false) - b;
      expect(down).toBeGreaterThan(up);
    }
  });

  it('converges to the floor under sustained distress and stays there', () => {
    let b = ENGINE_START_BUDGET_MAX;
    for (let i = 0; i < 50; i++) b = nextEngineStartBudget(b, true);
    expect(b).toBe(ENGINE_START_BUDGET_MIN);
  });

  it('converges back to the ceiling once the database recovers', () => {
    let b = ENGINE_START_BUDGET_MIN;
    for (let i = 0; i < 50; i++) b = nextEngineStartBudget(b, false);
    expect(b).toBe(ENGINE_START_BUDGET_MAX);
  });

  it('bounds the fleet-wide burst that actually caused the incident', () => {
    // 180 tables adopted at once was the failure. At the ceiling, the most
    // that can now be in flight in one sweep is the budget - a 7x reduction in
    // peak concurrent starts, which is the number that matters.
    const FLEET = 180;
    expect(ENGINE_START_BUDGET_MAX).toBeLessThan(FLEET / 5);

    // And the fleet still comes up promptly: sweeps needed at full budget,
    // against the 5s TABLE_DISCOVERY_INTERVAL.
    const sweeps = Math.ceil(FLEET / ENGINE_START_BUDGET_MAX);
    expect(sweeps * 5).toBeLessThanOrEqual(45);
  });
});

/**
 * WIRING GUARD (2026-08-24). The law above being correct is not enough - the
 * first shipped version of C20 had a correct law and still starved the fleet,
 * because the call that applies it was reachable only on the happy path.
 *
 * Source guards rather than a live harness because discoverCashTables() talks
 * to Supabase on every line; these assert the exact structural properties
 * whose absence caused the defect.
 */
describe('C20 wiring - the verdict is unskippable', () => {
  const SRC = readFileSync(join(process.cwd(), 'src/GameServer.ts'), 'utf8');
  const sweep = SRC.slice(
    SRC.indexOf('private async discoverCashTables'),
    SRC.indexOf('private async discoverTournaments')
  );
  const code = sweep.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

  it('applies the budget exactly once per sweep', () => {
    // Two call sites means two verdicts in one sweep, which double-halves.
    const calls = code.match(/this\.adjustEngineStartBudget\(/g) || [];
    expect(calls.length).toBe(1);
  });

  it('applies it from a finally, so a throw cannot deny recovery', () => {
    // THE DEFECT: the verdict sat in the try, after heartbeatTables(),
    // claimTable() and the adoption loop. Any throw in those skipped it while
    // the RPC-error path still halved - so the budget only ever went down.
    const fin = code.slice(code.lastIndexOf('} finally {'));
    expect(code).toContain('} finally {');
    expect(fin).toMatch(/this\.adjustEngineStartBudget\(/);
  });

  it('captures the failure count before the try, where no throw can skip it', () => {
    const beforeTry = code.slice(0, code.indexOf('try {'));
    expect(beforeTry).toMatch(/this\.engineStartFailures/);
    expect(beforeTry).toMatch(/sweepDistressed/);
  });

  it('treats a mid-sweep throw as distress, not as a clean sweep', () => {
    const cat = code.slice(code.lastIndexOf('} catch (err)'), code.lastIndexOf('} finally {'));
    expect(cat).toMatch(/sweepDistressed\s*=\s*true/);
  });

  it('still bounds the adoption loop', () => {
    expect(code).toMatch(/startedThisSweep\s*>=\s*budgetThisSweep/);
  });
});
