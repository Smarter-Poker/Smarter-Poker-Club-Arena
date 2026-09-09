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
import { sliceEnclosingBlock, sliceMethod } from '../testHelpers/sourceWindow.js';

const SRC = readFileSync(resolve(__dirname, './RakebackSettlerService.ts'), 'utf8');

/**
 * STRUCTURAL, NOT ARITHMETIC.
 *
 * The first version of this file bounded its window by hand and sliced
 * BACKWARDS - `scheduleCatchUp` is declared ABOVE `runSettlement`, so
 * `slice(indexOf(run), indexOf(schedule))` returned an empty string and four
 * pins passed on nothing at all. The second version fixed the direction and
 * still measured the gate with `slice(gateAt, gateAt + 400)`, which is a window
 * that silently changes meaning the moment a comment above it grows.
 *
 * `tests/unit/noFixedSizeSourceWindows.test.ts` is the law against exactly that,
 * and it caught this file. The helpers walk the braces: the window is the method
 * and the block, or the extractor throws.
 */
const RUN = sliceMethod(SRC, 'runSettlement(): Promise<void>');
const GATE = sliceEnclosingBlock(RUN, 'deferring the read-only sentinels');

describe('the drain outranks the read-only sentinels', () => {
  it('the window under test is really runSettlement', () => {
    // A pin that reads '' passes every `indexOf(...) > 0` it is given, purely by
    // accident. This is the guard on the guard.
    expect(RUN.length).toBeGreaterThan(1000);
    expect(RUN).toContain('await this.runTournamentChipConservation();');
  });

  it('skips the sentinel tail entirely while backlog remains', () => {
    expect(RUN.indexOf('if (backlogRemains) {'), 'the backlog gate must exist').toBeGreaterThan(0);
    expect(GATE).toMatch(/deferring the read-only sentinels so the drain keeps the floor/);
    expect(GATE).toMatch(/return;/);
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
    // Both are cleared in `finally` blocks, so a `return` from inside the try -
    // which is what the gate does - still runs them. Ordering is what matters:
    // the gate must sit before the release, not after it.
    expect(RUN).toMatch(/this\.isSettling = false;/);
    expect(RUN).toMatch(/releaseLifecycle\(\)/);
    expect(RUN.indexOf('if (backlogRemains) {')).toBeLessThan(
      RUN.lastIndexOf('releaseLifecycle()')
    );
  });

  it('the drain still cannot overlap itself - that is what isSettling is for', () => {
    // The re-entrancy guard has to come BEFORE the flag is taken, or two drains
    // can both pass it. Positions, not a hand-cut window.
    const guardAt = RUN.indexOf('if (this.isSettling)');
    const takeAt = RUN.indexOf('this.isSettling = true;');
    expect(guardAt).toBeGreaterThanOrEqual(0);
    expect(takeAt).toBeGreaterThan(guardAt);
    expect(RUN).toMatch(/settlement already in progress/);
  });

  it('the catch-up only arms when there is backlog to catch up on', () => {
    const sched = sliceMethod(
      SRC,
      'scheduleCatchUp(backlogRemains: boolean, generation: number | null): void'
    );
    expect(sched).toMatch(/if \(!backlogRemains \|\| generation === null/);
  });
});
