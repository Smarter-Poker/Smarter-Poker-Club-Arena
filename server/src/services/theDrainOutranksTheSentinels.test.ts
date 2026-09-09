/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  PLAYER MONEY MOVES FIRST; MONITORING RUNS IN THE GAPS (2026-09-09)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The rakeback settler sat 10.3 hours behind with a 60,870-row backlog,
 * advancing at only 1.65x real time - while its actual drain capacity is
 * ~80,000 records/hour against ~6,000/hour arriving. A page of 999 records
 * takes 22-28s, so three batches is ~75s.
 *
 * It could not catch up because the nine auxiliary sentinels that follow the
 * drain run inside the same `isSettling` critical section, and two of those
 * RPCs - `fn_union_treasury_selftest` and `fn_union_rake_rollup_catchup_all` -
 * reliably burn a statement timeout on this database. `scheduleCatchUp()` armed
 * its 60-second retry, the retry fired into the tail, hit `isSettling`, and
 * logged "settlement already in progress - skipping overlapping run". So the
 * drain ran once per THIRTY-MINUTE interval: 3,000 records per 30 minutes is
 * 6,000/hour, exactly the inflow, so it could never gain and any hiccup lost
 * ground permanently.
 *
 * These pins are the ORDERING, not the timing. A future change that lets the
 * read-only sentinels run while backlog remains re-creates the stall exactly.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SRC = readFileSync(resolve(__dirname, './RakebackSettlerService.ts'), 'utf8');
// `scheduleCatchUp` is DECLARED above runSettlement, so it cannot be the end
// bound - slicing to it produced an empty string and made four pins vacuous.
// Bound on the next method declared after runSettlement instead, and assert the
// slice is real so this can never silently pass on nothing again.
const RUN_START = SRC.indexOf('async runSettlement(');
const RUN_END = SRC.indexOf('\n  /**', RUN_START + 100);
const RUN = SRC.slice(RUN_START, RUN_END > RUN_START ? RUN_END : undefined);

describe('the drain outranks the read-only sentinels', () => {
  it('the slice under test is really runSettlement, not an empty string', () => {
    // A pin that reads '' passes every `indexOf(...) > 0` it is given only by
    // accident. This is the guard on the guard.
    expect(RUN_START).toBeGreaterThan(0);
    expect(RUN.length).toBeGreaterThan(1000);
    expect(RUN).toContain('async runSettlement(');
    expect(RUN).toContain('await this.runTournamentChipConservation();');
  });

  it('skips the sentinel tail entirely while backlog remains', () => {
    const gateAt = RUN.indexOf('if (backlogRemains) {');
    expect(gateAt, 'the backlog gate must exist').toBeGreaterThan(0);
    const gate = RUN.slice(gateAt, gateAt + 400);
    expect(gate).toMatch(/deferring the read-only sentinels so the drain keeps the floor/);
    expect(gate).toMatch(/return;/);
  });

  it('puts the gate AFTER the money work and BEFORE the first sentinel', () => {
    const catchUpAt = RUN.indexOf('this.scheduleCatchUp(backlogRemains');
    const closeAt = RUN.indexOf('await this.runWeeklyFinancialClose();');
    const gateAt = RUN.indexOf('if (backlogRemains) {');
    const firstSentinelAt = RUN.indexOf('await this.runTournamentSentinel();');
    expect(catchUpAt).toBeGreaterThan(0);
    expect(gateAt).toBeGreaterThan(closeAt);
    expect(firstSentinelAt).toBeGreaterThan(gateAt);
  });

  it('never defers money: the rakeback drain and the weekly close stay above the gate', () => {
    const gateAt = RUN.indexOf('if (backlogRemains) {');
    for (const money of [
      'await this.runUnionWeeklyRakeback();',
      'await this.runRakebackDrain();',
      'await this.runWeeklyFinancialClose();',
    ]) {
      const at = RUN.indexOf(money);
      expect(at, money).toBeGreaterThan(0);
      expect(at, `${money} must run before the gate`).toBeLessThan(gateAt);
    }
  });

  it('the two RPCs that burn a statement timeout are below the gate', () => {
    const gateAt = RUN.indexOf('if (backlogRemains) {');
    for (const sentinel of [
      'await this.runUnionTreasurySentinel();',
      'await this.runUnionRakeRollupCatchup();',
    ]) {
      const at = RUN.indexOf(sentinel);
      expect(at, sentinel).toBeGreaterThan(0);
      expect(at, `${sentinel} must be deferrable`).toBeGreaterThan(gateAt);
    }
  });

  it('the early return still releases the lock, so no flag can leak', () => {
    // `isSettling` is cleared in a finally, and the lifecycle in an outer one.
    // The gate returns from inside the try, so both still run.
    const tail = RUN.slice(RUN.lastIndexOf('} finally {') - 200);
    expect(RUN).toMatch(/this\.isSettling = false;/);
    expect(tail).toMatch(/releaseLifecycle\(\)/);
  });

  it('the drain still cannot overlap itself - that is what isSettling is for', () => {
    const head = RUN.slice(0, RUN.indexOf('this.isSettling = true;'));
    expect(head).toMatch(/if \(this\.isSettling\)/);
    expect(head).toMatch(/settlement already in progress/);
  });

  it('the catch-up only arms when there is backlog to catch up on', () => {
    const sched = SRC.slice(SRC.indexOf('private scheduleCatchUp('));
    expect(sched).toMatch(/if \(!backlogRemains \|\| generation === null/);
  });
});
