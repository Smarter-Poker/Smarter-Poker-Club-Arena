/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  A DECIDED FIELD DOES NOT HOLD THE CONSOLIDATION LANE (2026-10-01)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Production 2026-10-01 22:29-22:50 UTC, engine 71825702 (#5734 + #5735):
 * the decided-but-RUNNING board marked every decided Spin and Sit & Go
 * consolidating, and consolidation outranked the decided lane. 208 managers
 * were consolidating, 207 queued for the lane's ONE slot, oldest wait 743 s.
 * The fields that really needed that slot dealt nothing: Five-Card Reload
 * 7e7dabf8 and a21f7007 (a table break parked since 22:04), Sunday Deep Stack
 * Satellite $25 d9cc8159 (a held qualifier boundary, no hand since 21:20),
 * and the decided satellite 1e0343b5 printed "recovering the winner" 25 times
 * without one sweep.
 *
 * The law: a decided field (one table, at most one stack with chips) is
 * served from the decided lane even when it is also marked consolidating, so
 * a field with real consolidation work is admitted to the consolidation slot
 * at once, however many decided games are waiting.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({ reportError: vi.fn() }));
vi.mock('../services/errorReporter.js', () => ({ reportError: fixture.reportError }));

const { TournamentEliminationScheduler } = await import('./TournamentEliminationScheduler.js');

const microtasks = async (): Promise<void> => {
  for (let i = 0; i < 6; i++) await Promise.resolve();
};
const flush = async (): Promise<void> => {
  await microtasks();
  await new Promise((resolve) => setTimeout(resolve, 1));
  await microtasks();
};

function held() {
  const releases = new Map<string, Array<() => void>>();
  const started: string[] = [];
  const run = (id: string) => () =>
    new Promise<void>((resolve) => {
      started.push(id);
      const list = releases.get(id) ?? [];
      list.push(resolve);
      releases.set(id, list);
    });
  const release = (id: string) => releases.get(id)?.shift()?.();
  return { run, release, started };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('a decided field does not hold the consolidation lane', () => {
  it('a held MTT takes the consolidation slot ahead of 200 decided games marked consolidating', async () => {
    const scheduler = new TournamentEliminationScheduler({
      maxConcurrent: 4,
      consolidationSlots: 1,
      sweepWarnMs: 0,
      startTimers: false,
    });
    const h = held();
    try {
      // Every slot, the consolidation slot too, is busy when the decided
      // board and the held MTT wake.
      for (let i = 0; i < 4; i++) {
        scheduler.register({ tournamentId: `busy-${i}`, run: h.run(`busy-${i}`) });
      }
      scheduler.register({ tournamentId: 'merging', run: h.run('merging') });
      await flush();
      expect(h.started).toEqual(['busy-0', 'busy-1', 'busy-2', 'busy-3']);
      expect(scheduler.setConsolidating('merging', true)).toBe(true);
      await flush();
      expect(h.started[4]).toBe('merging');

      for (let i = 0; i < 200; i++) {
        const id = `decided-${i}`;
        scheduler.register({ tournamentId: id, run: h.run(id) });
      }
      scheduler.register({ tournamentId: 'held-mtt', run: h.run('held-mtt') });
      await flush();
      // The decided board's wakes, marked in either order.
      for (let i = 0; i < 200; i++) {
        const id = `decided-${i}`;
        if (i % 2 === 0) {
          expect(scheduler.setDecided(id)).toBe(true);
          expect(scheduler.setConsolidating(id, true)).toBe(true);
        } else {
          expect(scheduler.setConsolidating(id, true)).toBe(true);
          expect(scheduler.setDecided(id)).toBe(true);
        }
        scheduler.wake(id);
      }
      expect(scheduler.setConsolidating('held-mtt', true)).toBe(true);
      scheduler.wake('held-mtt');
      await flush();

      expect(h.started).toHaveLength(5);
      expect(scheduler.snapshot()).toMatchObject({ consolidationQueued: 1, decidedQueued: 200 });

      // The consolidation slot's next sweep is the field that has something
      // to merge, not the first of 200 decided games.
      h.release('merging');
      await flush();
      expect(h.started.slice(5)).toEqual(['held-mtt']);

      // A freed general slot goes to the decided lane, as #5735 intends.
      h.release('busy-0');
      await flush();
      expect(h.started[6]).toMatch(/^decided-/);
    } finally {
      scheduler.stop();
    }
  });
});
