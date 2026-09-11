/**
 * A FROZEN SWEEP OWES THE BALANCER A PASS AFTER THE THAW (2026-09-11).
 *
 * Production, 11:50 UTC: 57 RUNNING events with every live table holding one
 * funded player and no table holding two. Each was adopted at 10:56 by the
 * restarted engine, inside the maintenance freeze; its one adoption sweep
 * skipped table balancing because the platform was frozen, and an event that
 * cannot deal produces no further wake. The same happened at every restart
 * before it, so the oldest had been frozen since 2026-09-10 06:40.
 *
 * The rule pinned here: a sweep that skips balancing or expansion because of
 * the freeze arms exactly one pass for the thaw.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { TournamentManager } from './TournamentManager.js';
import { thawPassDelayMs, TournamentManagerEliminations } from './TournamentManagerEliminations.js';
import {
  isMaintenanceFrozen,
  onNextMaintenanceThaw,
  setMaintenanceFrozen,
} from '../maintenance/freezeState.js';

const TOURNAMENT_ID = '7d6f3d3b-0000-4000-8000-000000000001';

function harness(cache: Record<string, unknown> | null = { max_players: 500, table_size: 9 }) {
  const manager = new TournamentManager(TOURNAMENT_ID, {} as never) as any;
  manager.lifecycleEpoch.begin();
  manager.running = true;
  manager.tournamentCache = cache;
  manager.requestUrgentEliminationSweepAfter = vi.fn();
  return manager;
}

afterEach(() => {
  setMaintenanceFrozen(false);
  vi.restoreAllMocks();
});

describe('the thaw pays back what the freeze deferred', () => {
  it('runs a listener once, on the frozen -> thawed edge and never again', () => {
    setMaintenanceFrozen(true);
    const listener = vi.fn();
    onNextMaintenanceThaw(listener);
    setMaintenanceFrozen(true); // a re-announcement is not a thaw
    expect(listener).not.toHaveBeenCalled();
    setMaintenanceFrozen(false);
    expect(listener).toHaveBeenCalledTimes(1);
    setMaintenanceFrozen(false); // an idle clear is not a second thaw
    setMaintenanceFrozen(true);
    setMaintenanceFrozen(false);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('a listener registered while thawed runs on the next microtask, not after a freeze', async () => {
    expect(isMaintenanceFrozen()).toBe(false);
    const listener = vi.fn();
    onNextMaintenanceThaw(listener);
    expect(listener).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('an unsubscribed listener does not run, and a throwing one costs nobody else', () => {
    setMaintenanceFrozen(true);
    const dropped = vi.fn();
    const kept = vi.fn();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    onNextMaintenanceThaw(dropped)();
    onNextMaintenanceThaw(() => {
      throw new Error('boom');
    });
    onNextMaintenanceThaw(kept);
    setMaintenanceFrozen(false);
    expect(dropped).not.toHaveBeenCalled();
    expect(kept).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe('a frozen sweep owes the balancer one pass after the thaw', () => {
  it('arms one pass per freeze, and the thaw asks for exactly one urgent sweep', () => {
    const manager = harness();
    setMaintenanceFrozen(true);
    manager.owePassAfterTheThaw(); // balance stage skipped
    manager.owePassAfterTheThaw(); // expansion stage skipped, same sweep
    manager.owePassAfterTheThaw(); // a second frozen sweep
    expect(manager.requestUrgentEliminationSweepAfter).not.toHaveBeenCalled();
    setMaintenanceFrozen(false);
    expect(manager.requestUrgentEliminationSweepAfter).toHaveBeenCalledTimes(1);
    expect(manager.requestUrgentEliminationSweepAfter).toHaveBeenCalledWith(
      thawPassDelayMs(TOURNAMENT_ID, TournamentManagerEliminations.THAW_PASS_SPREAD_MS)
    );
    // the next freeze can arm again
    setMaintenanceFrozen(true);
    manager.owePassAfterTheThaw();
    setMaintenanceFrozen(false);
    expect(manager.requestUrgentEliminationSweepAfter).toHaveBeenCalledTimes(2);
  });

  it('a field capped at one table has nothing to balance and never arms', () => {
    const spin = harness({ max_players: 3, table_size: 3 });
    const headsUp = harness({ max_players: 2, table_size: 9 });
    setMaintenanceFrozen(true);
    spin.owePassAfterTheThaw();
    headsUp.owePassAfterTheThaw();
    setMaintenanceFrozen(false);
    expect(spin.requestUrgentEliminationSweepAfter).not.toHaveBeenCalled();
    expect(headsUp.requestUrgentEliminationSweepAfter).not.toHaveBeenCalled();
  });

  it('an unknown field shape still arms - an unread cache is not a single table', () => {
    const manager = harness(null);
    setMaintenanceFrozen(true);
    manager.owePassAfterTheThaw();
    setMaintenanceFrozen(false);
    expect(manager.requestUrgentEliminationSweepAfter).toHaveBeenCalledTimes(1);
  });

  it('a lifecycle that ended before the thaw asks for nothing', () => {
    const stopped = harness();
    const replaced = harness();
    setMaintenanceFrozen(true);
    stopped.owePassAfterTheThaw();
    replaced.owePassAfterTheThaw();
    stopped.running = false;
    replaced.lifecycleEpoch.begin(); // a newer generation owns the event now
    setMaintenanceFrozen(false);
    expect(stopped.requestUrgentEliminationSweepAfter).not.toHaveBeenCalled();
    expect(replaced.requestUrgentEliminationSweepAfter).not.toHaveBeenCalled();
  });

  it('spreads the owed passes across the resume-wave window, deterministically', () => {
    const spread = TournamentManagerEliminations.THAW_PASS_SPREAD_MS;
    const ids = [
      '7d6f3d3b-7a1c-4c3f-9f51-0f0a0b0c0d0e',
      '2dbc9bb6-0000-4000-8000-000000000000',
      'ffffffff-ffff-4fff-bfff-ffffffffffff',
      '00000000-0000-4000-8000-000000000000',
    ];
    for (const id of ids) {
      const delay = thawPassDelayMs(id, spread);
      expect(delay).toBeGreaterThanOrEqual(0);
      expect(delay).toBeLessThan(spread);
      expect(thawPassDelayMs(id, spread)).toBe(delay);
    }
    expect(thawPassDelayMs('not-a-uuid', spread)).toBe(0);
    expect(thawPassDelayMs(ids[0], 0)).toBe(0);
  });

  it('both freeze-gated stages of the sweep arm the pass instead of dropping it', () => {
    const src = readFileSync(resolve(__dirname, 'TournamentManagerEliminations.ts'), 'utf8');
    const balance = src.slice(src.indexOf('balanceStage: {'), src.indexOf('expansionStage: {'));
    const expansion = src.slice(
      src.indexOf('expansionStage: {'),
      src.indexOf('handForHandStage: {')
    );
    expect(balance).toContain('if (!isMaintenanceFrozen()) {');
    expect(balance).toMatch(/\} else \{[\s\S]*this\.owePassAfterTheThaw\(\);[\s\S]*\}/);
    expect(expansion).toContain('if (isMaintenanceFrozen()) this.owePassAfterTheThaw();');
    expect(expansion).toContain(
      'if (!isMaintenanceFrozen() && !(await this.checkDynamicTableExpansion())) return;'
    );
  });
});
