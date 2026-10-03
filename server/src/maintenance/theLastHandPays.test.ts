/**
 * THE LAST HAND PAYS, AND A LAUNCH IS NEVER CUT IN HALF (2026-10-03).
 *
 * 1. An event decided by the hand its table finishes between the :53
 *    announcement and :55 settles then, not at the thaw. Only terminal
 *    settlement reads the window; every other freeze edge closes it.
 * 2. A start whose seating would cross the next :53 is held to the thaw.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  isMaintenanceFrozen,
  isTerminalSettlementFrozen,
  setLastHandSettlementWindow,
  setMaintenanceFrozen,
} from './freezeState.js';
import { launchSeatingBudgetMs, launchWouldCrossLastHand } from '../tournament/launchBreakHold.js';

afterEach(() => setMaintenanceFrozen(false));

describe('the last-hand terminal settlement window', () => {
  it('is open from the announcement until its deadline, and only for settlement', () => {
    const now = 1_000_000;
    setMaintenanceFrozen(true);
    setLastHandSettlementWindow(now + 90_000);
    expect(isMaintenanceFrozen()).toBe(true);
    expect(isTerminalSettlementFrozen(now)).toBe(false);
    expect(isTerminalSettlementFrozen(now + 89_999)).toBe(false);
    expect(isTerminalSettlementFrozen(now + 90_000)).toBe(true);
  });

  it('is closed by every later freeze edge and cleared by the thaw', () => {
    const now = 2_000_000;
    setMaintenanceFrozen(true);
    setLastHandSettlementWindow(now + 90_000);
    setMaintenanceFrozen(true); // adoption, recovery hold, release boundary
    expect(isTerminalSettlementFrozen(now)).toBe(true);
    setLastHandSettlementWindow(now + 90_000);
    setLastHandSettlementWindow(0); // the countdown at :55
    expect(isTerminalSettlementFrozen(now)).toBe(true);
    setMaintenanceFrozen(false);
    expect(isTerminalSettlementFrozen(now)).toBe(false);
    setMaintenanceFrozen(true);
    expect(isTerminalSettlementFrozen(now)).toBe(true);
  });

  it('cannot be opened while the platform is not frozen', () => {
    setLastHandSettlementWindow(Date.now() + 60_000);
    setMaintenanceFrozen(true);
    expect(isTerminalSettlementFrozen()).toBe(true);
  });

  it('is opened by the announcement with a reserve before :55 and closed by the countdown', () => {
    const src = readFileSync(join(process.cwd(), 'src/maintenance/MaintenanceBreak.ts'), 'utf8');
    const announce = src.slice(src.indexOf('private async announceBreak('));
    const body = announce.slice(0, announce.indexOf('\n  }\n'));
    expect(body.indexOf('setMaintenanceFrozen(true)')).toBeLessThan(
      body.indexOf('setLastHandSettlementWindow(')
    );
    expect(body).toContain('MaintenanceBreak.TERMINAL_SETTLEMENT_RESERVE_MS');
    const countdown = src.slice(src.indexOf('async beginCountdown()'));
    expect(countdown.slice(0, 2500)).toContain('setLastHandSettlementWindow(0)');
  });

  it('is read only by the non-satellite terminal settlement guard', () => {
    const elim = readFileSync(
      join(process.cwd(), 'src/tournament/TournamentManagerEliminations.ts'),
      'utf8'
    );
    expect(elim.match(/isTerminalSettlementFrozen\(\)/g)).toHaveLength(1);
    expect(elim).toContain(
      'terminalIsSatellite ? isMaintenanceFrozen() : isTerminalSettlementFrozen()'
    );
  });
});

describe('a launch is held when its seating would cross :53', () => {
  it('estimates seating from the field it will seat', () => {
    expect(launchSeatingBudgetMs(0)).toBe(20_000);
    expect(launchSeatingBudgetMs(300)).toBe(20_000 + 300 * 750);
  });

  it('held MTT 4735c72d: ~250 players two minutes before :53', () => {
    expect(launchWouldCrossLastHand(250, 121_000)).toBe(true);
    expect(launchWouldCrossLastHand(250, 10 * 60_000)).toBe(false);
    expect(launchWouldCrossLastHand(9, 60_000)).toBe(false);
    expect(launchWouldCrossLastHand(9, 20_000)).toBe(true);
  });

  it('never holds without an armed schedule', () => {
    expect(launchWouldCrossLastHand(10_000, Number.POSITIVE_INFINITY)).toBe(false);
  });

  it('is consulted by the start gate before admission', () => {
    const gs = readFileSync(join(process.cwd(), 'src/GameServer.ts'), 'utf8');
    const gate = gs.indexOf('launchWouldCrossLastHand(fieldCount, msUntilLastHand)');
    expect(gate).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(gs.indexOf("'start',\n                `Starting tournament:"));
  });
});
