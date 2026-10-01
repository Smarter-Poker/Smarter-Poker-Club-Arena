/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  A DECIDED GAME IS NOT WAITING BEHIND LIVE ONES (2026-10-01)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Production, 2026-10-01 19:50-20:10 UTC: the process-wide elimination
 * scheduler held 622 managers, 573 of them queued, oldest waiter 283 s, about
 * 1.9 dispatches a second. 487 RUNNING Spins and Sit & Gos had one player
 * left with chips for more than fifteen minutes, their winners unpaid. Spin
 * 82bcfdfa (4x, 200 pool) dealt its deciding hand at 19:14:03, recorded the
 * two busts at 19:28:45 and paid the winner at 19:50:52: thirty-seven minutes
 * for work that takes seconds, because every admission it needed waited a
 * full queue cycle behind ~570 live games. Over the last forty minutes the
 * median completed Spin was paid 44 minutes after its last hand.
 *
 * The law: a manager whose field is decided (one table, at most one stack
 * with chips) is served ahead of live work, from the general slots, while at
 * least one general slot always remains for live work. Finishing a decided
 * game retires its manager, so this lane shrinks the queue it jumps.
 */
import { readFileSync } from 'node:fs';
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

describe('the decided lane', () => {
  it('admits a decided game at the next free slot, ahead of 200 queued live games', async () => {
    const scheduler = new TournamentEliminationScheduler({
      maxConcurrent: 4,
      sweepWarnMs: 0,
      startTimers: false,
    });
    const h = held();
    try {
      for (let i = 0; i < 200; i++) {
        scheduler.register({ tournamentId: `live-${i}`, run: h.run(`live-${i}`) });
      }
      scheduler.register({ tournamentId: 'decided-spin', run: h.run('decided-spin') });
      await flush();
      expect(h.started).toEqual(['live-0', 'live-1', 'live-2', 'live-3']);
      for (let i = 0; i < 200; i++) scheduler.wake(`live-${i}`);

      expect(scheduler.setDecided('decided-spin')).toBe(true);
      scheduler.wake('decided-spin');
      h.release('live-0');
      await flush();

      expect(h.started[4]).toBe('decided-spin');
      expect(scheduler.snapshot()).toMatchObject({ decided: 1 });
    } finally {
      scheduler.stop();
    }
  });

  it('always leaves one general slot to live work while decided games queue', async () => {
    const scheduler = new TournamentEliminationScheduler({
      maxConcurrent: 4,
      sweepWarnMs: 0,
      startTimers: false,
    });
    const h = held();
    try {
      for (let i = 0; i < 4; i++) {
        scheduler.register({ tournamentId: `busy-${i}`, run: h.run(`busy-${i}`) });
      }
      for (let i = 0; i < 10; i++) {
        scheduler.register({ tournamentId: `decided-${i}`, run: h.run(`decided-${i}`) });
        expect(scheduler.setDecided(`decided-${i}`)).toBe(true);
      }
      scheduler.register({ tournamentId: 'live-mtt', run: h.run('live-mtt') });
      scheduler.wake('live-mtt');
      await flush();
      expect(h.started).toEqual(['busy-0', 'busy-1', 'busy-2', 'busy-3']);

      for (let i = 0; i < 4; i++) {
        h.release(`busy-${i}`);
        await flush();
      }

      expect(h.started.slice(4)).toEqual(['decided-0', 'decided-1', 'decided-2', 'live-mtt']);
      expect(scheduler.snapshot()).toMatchObject({ decidedRunning: 3, decidedQueued: 7 });
    } finally {
      scheduler.stop();
    }
  });

  it('a decided mark ends with the registration that carried it', () => {
    const scheduler = new TournamentEliminationScheduler({ startTimers: false });
    try {
      const unregister = scheduler.register({ tournamentId: 'spin', run: async () => {} });
      expect(scheduler.setDecided('spin')).toBe(true);
      unregister();
      expect(scheduler.setDecided('spin')).toBe(false);
      expect(scheduler.snapshot().decided).toBe(0);
    } finally {
      scheduler.stop();
    }
  });
});

describe('who declares a field decided', () => {
  const base = readFileSync(new URL('./TournamentManagerBase.ts', import.meta.url), 'utf8');
  const server = readFileSync(new URL('../GameServer.ts', import.meta.url), 'utf8');

  it('the deciding hand itself: one table and at most one stack left with chips', () => {
    const wire = base.slice(
      base.indexOf('protected wireEliminationWake('),
      base.indexOf('engine.onPauseReady(')
    );
    expect(wire).toContain('this.declareFieldDecidedIfOneStackRemains(finalStacks);');
    expect(wire.indexOf('declareFieldDecidedIfOneStackRemains')).toBeLessThan(
      wire.indexOf('this.requestEliminationSweep();')
    );
  });

  it('both GameServer recoveries of a decided game wake it through the decided lane', () => {
    expect(server).toContain("requestDecidedEliminationSweep('stalled_decided_survivor')");
    expect(server).toContain("requestDecidedEliminationSweep('seat_first_terminal_stack')");
    expect(server).not.toContain("requestEliminationSweep('stalled_decided_survivor')");
    expect(server).not.toContain("requestEliminationSweep('seat_first_terminal_stack')");
  });
});
