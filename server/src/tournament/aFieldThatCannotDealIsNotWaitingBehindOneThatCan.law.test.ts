/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  A FIELD THAT CANNOT DEAL IS NOT WAITING BEHIND ONE THAT CAN (2026-09-29)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Production, 2026-09-29 04:30-04:40 UTC, engine c0c986ad: the process-wide
 * elimination scheduler held 307 managers, 250-270 of them queued, all four
 * slots busy, the oldest waiter at 309-380 s, and a sweep averaging 5 to 7 s.
 * A per-manager read of the queue put 222 of 296 managers in the urgent lane,
 * so every manager was admitted about once every five minutes whatever it
 * needed. Morning Free Buy 6a18ddaa (12 players on 12 tables) and $100
 * Freeroll c65c414d (18 on 18) each re-armed their five-second balance
 * redrive and were each admitted once per cycle; a table with one player
 * cannot deal, so neither field dealt a hand, and c65c414d merged one table
 * in twelve minutes.
 *
 * The law: a manager whose balance stage leaves a break or seat move
 * outstanding is served from a consolidation lane with its own slot, and the
 * general lanes keep every slot they had.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({ reportError: vi.fn() }));
vi.mock('../services/errorReporter.js', () => ({ reportError: fixture.reportError }));
vi.mock('../maintenance/freezeState.js', () => ({ isMaintenanceFrozen: () => false }));
vi.mock('../services/supabase/client.js', () => ({
  supabase: {
    from: () => {
      throw new Error('no database in this fixture');
    },
    rpc: () => {
      throw new Error('no database in this fixture');
    },
  },
  maintenanceSupabase: {},
}));

const { TournamentEliminationScheduler, DEFAULT_CONSOLIDATION_SLOTS, tournamentEliminationScheduler } =
  await import('./TournamentEliminationScheduler.js');
const { TournamentManagerEliminations } = await import('./TournamentManagerEliminations.js');
const { TournamentSweepWorkCursor } = await import('./TournamentSweepWorkCursor.js');

const flush = async (): Promise<void> => {
  for (let i = 0; i < 6; i++) await Promise.resolve();
};

/** A run that stays in flight until the test releases it. */
function held() {
  const releases = new Map<string, Array<() => void>>();
  const started: string[] = [];
  let active = 0;
  let maxActive = 0;
  const run = (id: string) => () =>
    new Promise<void>((resolve) => {
      started.push(id);
      active++;
      maxActive = Math.max(maxActive, active);
      const list = releases.get(id) ?? [];
      list.push(() => {
        active--;
        resolve();
      });
      releases.set(id, list);
    });
  const release = (id: string) => releases.get(id)?.shift()?.();
  return { run, release, started, get active() { return active; }, get maxActive() { return maxActive; } };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('the consolidation lane', () => {
  it('reserves exactly one slot beside the general cap by default', () => {
    expect(DEFAULT_CONSOLIDATION_SLOTS).toBe(1);
  });

  it('admits a consolidating field at once while every general slot is busy and 200 peers wait', async () => {
    const scheduler = new TournamentEliminationScheduler({
      maxConcurrent: 4,
      sweepWarnMs: 0,
      startTimers: false,
    });
    const h = held();
    try {
      for (let i = 0; i < 200; i++) {
        const id = `sng-${i}`;
        scheduler.register({ tournamentId: id, run: h.run(id) });
      }
      scheduler.register({ tournamentId: 'spread-mtt', run: h.run('spread-mtt') });
      await flush();
      expect(h.started).toEqual(['sng-0', 'sng-1', 'sng-2', 'sng-3']);
      for (let i = 0; i < 200; i++) scheduler.wake(`sng-${i}`);

      // Its first pass was an ordinary one; it found the field spread and
      // asked for its balance redrive.
      expect(scheduler.setConsolidating('spread-mtt', true)).toBe(true);
      await flush();

      expect(h.started).toContain('spread-mtt');
      expect(h.started).toHaveLength(5);
      expect(scheduler.snapshot()).toMatchObject({
        running: 5,
        consolidating: 1,
        consolidationRunning: 1,
      });
    } finally {
      scheduler.stop();
    }
  });

  it('never takes a general slot away: urgent work keeps the whole cap while consolidation runs', async () => {
    const scheduler = new TournamentEliminationScheduler({
      maxConcurrent: 2,
      sweepWarnMs: 0,
      startTimers: false,
    });
    const h = held();
    try {
      scheduler.register({ tournamentId: 'break-a', run: h.run('break-a') });
      scheduler.register({ tournamentId: 'break-b', run: h.run('break-b') });
      await flush();
      h.release('break-a');
      h.release('break-b');
      await flush();
      scheduler.setConsolidating('break-a', true);
      scheduler.setConsolidating('break-b', true);
      for (let i = 0; i < 10; i++) {
        scheduler.register({ tournamentId: `u-${i}`, run: h.run(`u-${i}`) });
      }
      scheduler.wake('break-a');
      scheduler.wake('break-b');
      await flush();

      // One consolidation slot, two general slots, and nothing more.
      expect(h.active).toBe(3);
      const snap = scheduler.snapshot();
      expect(snap.consolidationRunning).toBe(1);
      expect(snap.running - snap.consolidationRunning).toBe(2);
      // The second consolidating field waits for the lane, not for 10 peers.
      expect(snap.consolidationQueued).toBe(1);
      h.release(h.started.find((id) => id.startsWith('break-'))!);
      await flush();
      expect(h.started.filter((id) => id.startsWith('break-'))).toHaveLength(4);
      expect(h.maxActive).toBe(3);
    } finally {
      scheduler.stop();
    }
  });

  it('promotes a place already waiting in the urgent lane without losing it', async () => {
    const scheduler = new TournamentEliminationScheduler({
      maxConcurrent: 1,
      consolidationSlots: 1,
      sweepWarnMs: 0,
      startTimers: false,
    });
    const h = held();
    try {
      scheduler.register({ tournamentId: 'busy', run: h.run('busy') });
      for (let i = 0; i < 20; i++) {
        scheduler.register({ tournamentId: `peer-${i}`, run: h.run(`peer-${i}`) });
      }
      scheduler.register({ tournamentId: 'spread', run: h.run('spread') });
      await flush();
      expect(scheduler.snapshot()).toMatchObject({ queued: 21 });

      scheduler.setConsolidating('spread', true);
      await flush();
      expect(h.started).toEqual(['busy', 'spread']);
      // Logical depth stays one place per tournament; the promoted one left.
      expect(scheduler.snapshot()).toMatchObject({ queued: 20, consolidationQueued: 0 });
    } finally {
      scheduler.stop();
    }
  });

  it('promotes a deferred redrive so the five-second balance retry lands in the lane', async () => {
    vi.useFakeTimers();
    const scheduler = new TournamentEliminationScheduler({
      maxConcurrent: 1,
      sweepWarnMs: 0,
      startTimers: false,
    });
    const h = held();
    try {
      scheduler.register({ tournamentId: 'spread', run: h.run('spread') });
      await flush();
      // Inside its pass: the balancer re-arms, then the stage declares.
      scheduler.wakeUrgentAfter('spread', 5_000);
      scheduler.setConsolidating('spread', true);
      h.release('spread');
      scheduler.register({ tournamentId: 'hog', run: h.run('hog') });
      for (let i = 0; i < 5; i++) scheduler.register({ tournamentId: `p-${i}`, run: h.run(`p-${i}`) });
      await flush();
      expect(h.started).toEqual(['spread', 'hog']);

      await vi.advanceTimersByTimeAsync(5_000);
      expect(h.started).toEqual(['spread', 'hog', 'spread']);
      expect(scheduler.snapshot().consolidationRunning).toBe(1);
    } finally {
      scheduler.stop();
    }
  });

  it('a rerun owed while the pass is live keeps the lane', async () => {
    const scheduler = new TournamentEliminationScheduler({
      maxConcurrent: 1,
      sweepWarnMs: 0,
      startTimers: false,
    });
    const h = held();
    try {
      scheduler.register({ tournamentId: 'spread', run: h.run('spread') });
      await flush();
      scheduler.wake('spread'); // a budget yield asks for its continuation
      scheduler.setConsolidating('spread', true);
      scheduler.register({ tournamentId: 'hog', run: h.run('hog') });
      await flush();
      h.release('spread');
      await flush();
      // The continuation takes the lane's slot before the waiting peer.
      expect(h.started).toEqual(['spread', 'spread', 'hog']);
    } finally {
      scheduler.stop();
    }
  });

  it('a finished consolidation returns later wakes to the general lanes', async () => {
    const scheduler = new TournamentEliminationScheduler({
      maxConcurrent: 1,
      sweepWarnMs: 0,
      startTimers: false,
    });
    const h = held();
    try {
      scheduler.register({ tournamentId: 'mtt', run: h.run('mtt') });
      await flush();
      scheduler.setConsolidating('mtt', true);
      scheduler.setConsolidating('mtt', false);
      scheduler.register({ tournamentId: 'hog', run: h.run('hog') });
      scheduler.wake('hog');
      scheduler.wake('mtt');
      h.release('mtt');
      await flush();
      expect(h.started).toEqual(['mtt', 'hog']);
      expect(scheduler.snapshot()).toMatchObject({ consolidating: 0, consolidationQueued: 0 });
    } finally {
      scheduler.stop();
    }
  });

  it('uses an idle general slot when the ordinary lanes are empty', async () => {
    const scheduler = new TournamentEliminationScheduler({
      maxConcurrent: 2,
      sweepWarnMs: 0,
      startTimers: false,
    });
    const h = held();
    try {
      for (const id of ['a', 'b', 'c']) scheduler.register({ tournamentId: id, run: h.run(id) });
      await flush();
      for (const id of ['a', 'b', 'c']) h.release(id);
      await flush();
      for (const id of ['a', 'b', 'c']) scheduler.setConsolidating(id, true);
      for (const id of ['a', 'b', 'c']) scheduler.wake(id);
      await flush();
      expect(h.active).toBe(3);
      expect(scheduler.snapshot().consolidationRunning).toBe(1);
    } finally {
      scheduler.stop();
    }
  });

  it('forgets the mark with the registration it belonged to', async () => {
    const scheduler = new TournamentEliminationScheduler({
      maxConcurrent: 1,
      sweepWarnMs: 0,
      startTimers: false,
    });
    const h = held();
    try {
      scheduler.register({ tournamentId: 'mtt', run: h.run('mtt') });
      await flush();
      scheduler.setConsolidating('mtt', true);
      h.release('mtt');
      await flush();
      scheduler.register({ tournamentId: 'mtt', run: h.run('mtt') });
      expect(scheduler.snapshot().consolidating).toBe(0);
      expect(scheduler.setConsolidating('nobody', true)).toBe(false);
    } finally {
      scheduler.stop();
    }
  });
});

describe('the balance stage declares the lane', () => {
  const tournamentId = '00000000-0000-4000-8000-0000000000aa';

  function balanceManager(checkTableBalance: (this: any) => Promise<unknown>) {
    const manager = Object.create(TournamentManagerEliminations.prototype) as any;
    Object.assign(manager, {
      tournamentId,
      running: true,
      isProcessingEliminations: false,
      pendingManagerWakes: new Map(),
      pendingManagerWakeGenerations: new Map(),
      tournamentEntryRepricePending: false,
      eliminationSweepCursor: new TournamentSweepWorkCursor(),
      tableEngines: new Map(),
      tournamentCache: { tournament_type: 'MTT', variant: 'nlh' },
      urgentRedrivesRequested: 0,
      consolidationDeclared: false,
      resumeCommittedTerminalCleanup: vi.fn().mockResolvedValue(false),
      checkDynamicTableExpansion: vi.fn().mockResolvedValue(true),
      requestEliminationSweep: vi.fn(),
      eliminationWorkBudgetExpired: () => false,
      checkTableBalance: vi.fn(checkTableBalance),
    });
    manager.eliminationSweepCursor.advanceTo(5); // the balance stage
    return manager;
  }

  it('marks a field whose balancer asked for a redrive, and unmarks it after a clean pass', async () => {
    const setConsolidating = vi
      .spyOn(tournamentEliminationScheduler, 'setConsolidating')
      .mockReturnValue(true);
    vi.spyOn(tournamentEliminationScheduler, 'wakeUrgentAfter').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});

    const manager = balanceManager(async function (this: any) {
      // A park was requested for a one-player table; its completion is owed.
      this.requestUrgentEliminationSweepAfter(5_000);
      return undefined;
    });
    await manager.runEliminationSweep(new AbortController().signal);
    expect(setConsolidating).toHaveBeenLastCalledWith(tournamentId, true);

    manager.checkTableBalance = vi.fn().mockResolvedValue(undefined);
    manager.eliminationSweepCursor.advanceTo(5);
    await manager.runEliminationSweep(new AbortController().signal);
    expect(setConsolidating).toHaveBeenLastCalledWith(tournamentId, false);
    expect(setConsolidating).toHaveBeenCalledTimes(2);
    expect(fixture.reportError).not.toHaveBeenCalled();
  });

  it('a balance stage cut short by the work budget keeps its continuation in the lane', async () => {
    const setConsolidating = vi
      .spyOn(tournamentEliminationScheduler, 'setConsolidating')
      .mockReturnValue(true);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    let spent = false;
    const manager = balanceManager(async () => {
      spent = true;
      return undefined;
    });
    manager.eliminationWorkBudgetExpired = () => spent;
    await manager.runEliminationSweep(new AbortController().signal);
    expect(setConsolidating).toHaveBeenCalledWith(tournamentId, true);
    expect(manager.eliminationSweepCursor.nextStage).toBe(5);
    expect(manager.requestEliminationSweep).toHaveBeenCalled();
  });

  it('a field that is already balanced never touches the lane', async () => {
    const setConsolidating = vi.spyOn(tournamentEliminationScheduler, 'setConsolidating');
    const manager = balanceManager(async () => undefined);
    await manager.runEliminationSweep(new AbortController().signal);
    expect(setConsolidating).not.toHaveBeenCalled();
  });
});
