/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  A TICK THE FREEZE ATE IS STILL OWED (2026-09-21)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `fn_process_weekly_accounting_scope` raises
 * `weekly_rake_source_not_fully_accrued` when any cash rake record inside the
 * week being settled sits above `daemon_state.rakeback_settler.high_water_mark`.
 * That refusal is correct: settling a week on a source that is not fully
 * accrued would post an understated week. So the union cascade can only settle
 * if the settler's watermark is actually keeping up.
 *
 * It was not. Measured live on engine-01 (release 8825af51, uptime 2.7d, no
 * restart):
 *
 *   settlement runs began 09:26, 10:26, 11:27, 12:27, 13:27, 14:27 UTC
 *
 * One run per HOUR, from a service whose interval is thirty MINUTES. The
 * missing ticks were all at ~:56, and the maintenance freeze runs :53 to :00.
 * The interval callback read `isMaintenanceFrozen()` and returned, which is
 * right - settlement moves chips and the platform is meant to be still - but
 * the tick was then gone for good. Half the schedule was being eaten.
 *
 * Consequence measured at 15:26:06Z: watermark 2026-09-21T14:34:09Z, 52
 * minutes stale, 985 rake_records above it. The 15:26 run then cleared all 985
 * in under a minute, which is the proof that capacity was never the problem -
 * MAX_DRAIN_BATCHES x FETCH_LIMIT is far above the ~36 records/minute arriving.
 * A lost tick was the whole defect.
 *
 * These pins are the DEBT: a frozen tick must be remembered and paid on the
 * thaw, exactly once, and never paid by a generation the lifecycle has fenced.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { RakebackSettlerService } from './RakebackSettlerService.js';
import {
  setMaintenanceFrozen,
  isMaintenanceFrozen,
  onMaintenanceThaw,
} from '../maintenance/freezeState.js';

const INTERVAL_MS = 30 * 60 * 1000;

function harness() {
  const service = new RakebackSettlerService();
  const runs: string[] = [];
  // The unit under test is the SCHEDULE, not the drain. Stubbing the run keeps
  // the database out of it while leaving every lifecycle guard real.
  vi.spyOn(service, 'runSettlement').mockImplementation(async () => {
    runs.push('settled');
  });
  return { service, runs };
}

beforeEach(() => {
  vi.useFakeTimers();
  setMaintenanceFrozen(false);
});

afterEach(async () => {
  setMaintenanceFrozen(false);
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('a settlement tick held by the maintenance freeze is still owed', () => {
  it('does not settle while the freeze is on - chips stay still', async () => {
    const { service, runs } = harness();
    service.start();
    expect(runs, 'the startup run is unconditional').toHaveLength(1);

    setMaintenanceFrozen(true);
    vi.advanceTimersByTime(INTERVAL_MS);
    expect(isMaintenanceFrozen()).toBe(true);
    expect(runs, 'no settlement may run inside the freeze').toHaveLength(1);

    await service.stop();
  });

  it('runs the held tick when the freeze lifts, instead of losing it', async () => {
    const { service, runs } = harness();
    service.start();

    setMaintenanceFrozen(true);
    vi.advanceTimersByTime(INTERVAL_MS);
    expect(runs).toHaveLength(1);

    setMaintenanceFrozen(false);
    // THE REGRESSION. Before this fix the tick was discarded and the next
    // settlement was a full interval away, which is what halved the cadence.
    expect(runs, 'the thaw must pay the tick the freeze held').toHaveLength(2);

    await service.stop();
  });

  it('collapses several frozen ticks into exactly one make-up run', async () => {
    const { service, runs } = harness();
    service.start();

    setMaintenanceFrozen(true);
    vi.advanceTimersByTime(INTERVAL_MS * 3);
    expect(runs).toHaveLength(1);

    setMaintenanceFrozen(false);
    // A backlog is drained by the drain loop and its own catch-up, not by
    // replaying ticks. One make-up run, never a thundering herd.
    expect(runs, 'one debt, not one per missed tick').toHaveLength(2);

    await service.stop();
  });

  it('a thaw with no tick held settles nothing', async () => {
    const { service, runs } = harness();
    service.start();
    expect(runs).toHaveLength(1);

    // Freeze and thaw inside a single interval: no tick was ever eaten, so the
    // thaw owes nothing. An edge that fires work it was not owed is a new
    // repair loop wearing a different hat.
    setMaintenanceFrozen(true);
    vi.advanceTimersByTime(1000);
    setMaintenanceFrozen(false);
    expect(runs, 'the thaw is not itself a schedule').toHaveLength(1);

    await service.stop();
  });

  it('an unfrozen interval still settles on its own tick', async () => {
    const { service, runs } = harness();
    service.start();

    vi.advanceTimersByTime(INTERVAL_MS);
    expect(runs, 'the ordinary cadence is untouched').toHaveLength(2);
    vi.advanceTimersByTime(INTERVAL_MS);
    expect(runs).toHaveLength(3);

    await service.stop();
  });

  it('a stopped generation is never revived by a later thaw', async () => {
    const { service, runs } = harness();
    service.start();

    setMaintenanceFrozen(true);
    vi.advanceTimersByTime(INTERVAL_MS);
    expect(runs).toHaveLength(1);

    await service.stop();
    setMaintenanceFrozen(false);
    // stop() fences admission. A listener still holding the old generation
    // would re-open the post-stop race the lifecycle exists to close.
    expect(runs, 'the thaw must not outlive stop()').toHaveLength(1);
  });

  it('start/stop/start leaves exactly one live thaw listener', async () => {
    const { service, runs } = harness();
    service.start();
    await service.stop();
    service.start();
    expect(runs, 'two startup runs so far').toHaveLength(2);

    setMaintenanceFrozen(true);
    vi.advanceTimersByTime(INTERVAL_MS);
    setMaintenanceFrozen(false);
    // If stop() leaked its listener, the stale one would fire too and this
    // would be 4.
    expect(runs, 'one debt paid once, by the live generation only').toHaveLength(3);

    await service.stop();
  });
});

describe('the freeze flag reports its own thaw', () => {
  const FREEZE_SRC = readFileSync(resolve(__dirname, '../maintenance/freezeState.ts'), 'utf8');

  it('fires listeners only on the true->false edge', () => {
    const seen: string[] = [];
    const off = onMaintenanceThaw(() => seen.push('thaw'));

    setMaintenanceFrozen(false);
    expect(seen, 'false -> false is not an edge').toHaveLength(0);
    setMaintenanceFrozen(true);
    expect(seen, 'freezing is not thawing').toHaveLength(0);
    setMaintenanceFrozen(true);
    expect(seen).toHaveLength(0);
    setMaintenanceFrozen(false);
    expect(seen, 'the edge fires exactly once').toHaveLength(1);
    setMaintenanceFrozen(false);
    expect(seen).toHaveLength(1);

    off();
    setMaintenanceFrozen(true);
    setMaintenanceFrozen(false);
    expect(seen, 'unsubscribe really unsubscribes').toHaveLength(1);
  });

  it('a throwing listener cannot hold the platform frozen for the others', () => {
    const seen: string[] = [];
    const offA = onMaintenanceThaw(() => {
      throw new Error('observer exploded');
    });
    const offB = onMaintenanceThaw(() => seen.push('b'));
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    setMaintenanceFrozen(true);
    setMaintenanceFrozen(false);

    expect(seen, 'the second listener still ran').toEqual(['b']);
    expect(isMaintenanceFrozen(), 'the thaw itself completed').toBe(false);
    expect(spy).toHaveBeenCalled();
    offA();
    offB();
  });

  it('the settler no longer drops a frozen tick on the floor', () => {
    const settler = readFileSync(resolve(__dirname, './RakebackSettlerService.ts'), 'utf8');
    // The exact line this fix replaced. If it ever comes back, the cadence
    // halves again and nothing else in this file would notice.
    expect(settler).not.toMatch(/if \(isMaintenanceFrozen\(\)\) return;/);
    expect(settler).toMatch(/this\.tickOwedFromFreeze = true;/);
    expect(settler).toMatch(/onMaintenanceThaw\(/);
    expect(FREEZE_SRC).toMatch(/export function onMaintenanceThaw/);
  });
});
