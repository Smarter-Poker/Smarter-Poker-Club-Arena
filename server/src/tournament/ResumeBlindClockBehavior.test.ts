import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { sliceBetween, sliceMethod } from '../testHelpers/sourceWindow.js';

const source = readFileSync(
  path.join(process.cwd(), 'src/tournament/TournamentManagerBase.ts'),
  'utf8'
);
const restore = sliceBetween(
  source,
  '      // Restore blind level',
  "      /* Rebuild the add-on's two non-money timers"
);
const methods = [
  'private scheduleBlindLevelWake(',
  'private scheduleBlindClockStart(',
  'protected startBlindTimer(',
  'protected suspendLevelClock(',
  'protected async waitForMaintenanceThaw(',
  'async resumeFromBreak()',
  'private async beginAddOnBreak(',
].map((signature) => sliceMethod(source, signature).replace(/^(protected|private)\s+/, ''));

/** A numeric static as the source declares it, so the harness runs on the real value. */
function staticNumber(name: string): number {
  const match = new RegExp(`static readonly ${name} = ([0-9_]+);`).exec(source);
  if (!match) throw new Error(`TournamentManagerBase.${name} is not a numeric literal any more`);
  return Number(match[1].replace(/_/g, ''));
}
const runtime = ts.transpileModule(
  'return { async restore(tournament: any) { const lifecycle = 1;\n' +
    restore +
    '\n},\n' +
    methods.join(',\n') +
    '\n};',
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }
).outputText;

function fixture(overrides: Record<string, unknown> = {}) {
  return {
    current_level: 0,
    blind_structure: [{ durationMinutes: 10 }],
    level_started_at: '2026-09-09T12:50:00.000Z',
    on_break: true,
    break_started_at: '2026-09-09T12:55:00.000Z',
    break_ends_at: '2026-09-09T13:00:00.000Z',
    ...overrides,
  };
}

function harness(
  tournament: ReturnType<typeof fixture>,
  opts: { maintenanceFrozen?: boolean | (() => boolean) } = {}
) {
  const writes: Record<string, unknown>[] = [];
  const timers = new Set<{ callback: () => unknown; delay: number; unref: () => void }>();
  const supabase = {
    from: () => ({
      update: (patch: Record<string, unknown>) => ({
        eq: () => {
          writes.push(patch);
          Object.assign(tournament, patch);
          return Promise.resolve({ error: null });
        },
      }),
    }),
  };
  const reportError = vi.fn();
  const maintenanceFrozen = () =>
    typeof opts.maintenanceFrozen === 'function'
      ? opts.maintenanceFrozen()
      : Boolean(opts.maintenanceFrozen);
  const actual = new Function(
    'supabase',
    'TournamentManagerBase',
    'reportError',
    'isMaintenanceFrozen',
    runtime
  )(
    supabase,
    {
      LAST_HAND_GRACE_MS: 120000,
      BREAK_DURATION_MS: 300000,
      MAINTENANCE_THAW_POLL_MS: staticNumber('MAINTENANCE_THAW_POLL_MS'),
      MAINTENANCE_THAW_WAIT_CEILING_MS: staticNumber('MAINTENANCE_THAW_WAIT_CEILING_MS'),
    },
    reportError,
    maintenanceFrozen
  );
  const state: any = {
    ...actual,
    tournamentId: 'clock-restart',
    tournamentCache: tournament,
    running: true,
    currentLevel: 0,
    onBreak: false,
    blindStartTimer: null,
    isOnBreak() {
      return this.onBreak || this.addOnBreakActive;
    },
    blindTimer: null,
    blindTimerStartedAt: 0,
    savedBlindTimerRemaining: 0,
    prizePoolFinalized: true,
    addOnBreakActive: false,
    tableEngines: new Map(),
    resolveBlindLevel: (structure: any[]) => structure[0],
    levelDurationMs: () => 600000,
    startEliminationChecker: vi.fn(),
    captureLifecycleToken: () => 1,
    lifecycleIsCurrent: () => true,
    armAddOnBreakEnd: vi.fn(),
    requestEliminationSweep: vi.fn(),
    scheduleAddOnRetry: vi.fn(),
    reconcileTournamentEntryWindow: vi.fn(async () => {}),
    assertLifecycleCurrent: vi.fn(),
    clearPersistedBreak: vi.fn(async () => {
      tournament.on_break = false;
    }),
    trackLifecycleJob: (promise: Promise<unknown>) => promise,
    advanceBlindLevel: vi.fn(async () => {}),
    advanceHandForHandBarrier: vi.fn(),
    broadcast: vi.fn(async () => {}),
    setLifecycleTimeout: (callback: () => unknown, delay: number) => {
      const timer = { callback, delay, unref: () => {} };
      timers.add(timer);
      return timer;
    },
    clearLifecycleTimeout: (timer: any) => timers.delete(timer),
  };
  return { state, writes, timers, reportError };
}

afterEach(() => vi.useRealTimers());

describe('the persisted blind clock survives an engine restart during a break', () => {
  it.each([2400000, 2400001, 86400000])(
    'does not grant a fresh level after an anchor is %i milliseconds old',
    async (elapsedMs) => {
      vi.useFakeTimers();
      const now = Date.parse('2026-09-10T12:00:00.000Z');
      vi.setSystemTime(now);
      const tournament = fixture({
        on_break: false,
        level_started_at: new Date(now - elapsedMs).toISOString(),
      });
      const { state } = harness(tournament);
      await state.restore(tournament);
      expect(state.blindTimer.delay).toBe(1000);
      expect(state.currentLevel).toBe(0);
      await state.blindTimer.callback();
      expect(state.advanceBlindLevel).toHaveBeenCalledTimes(1);
    }
  );

  it('keeps an already overdue level due while restoring a recorded break', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-09T12:57:00.000Z'));
    const tournament = fixture({ level_started_at: '2026-09-09T11:50:00.000Z' });
    const { state, writes } = harness(tournament);
    await state.restore(tournament);
    expect(state.savedBlindTimerRemaining).toBe(1000);
    expect(state.blindTimer).toBeNull();
    expect(writes).toEqual([]);
  });

  it('preserves five minutes of play and its durable anchor without arming a level timer', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-09T12:57:00.000Z'));
    const tournament = fixture();
    const { state, writes } = harness(tournament);
    await state.restore(tournament);
    expect(state.savedBlindTimerRemaining).toBe(300000);
    expect(state.blindTimer).toBeNull();
    expect(writes).toEqual([]);
    expect(tournament.level_started_at).toBe('2026-09-09T12:50:00.000Z');
  });

  it('keeps the same remainder through a second restart and resumes one timer at break end', async () => {
    vi.useFakeTimers();
    const tournament = fixture();
    vi.setSystemTime(new Date('2026-09-09T12:57:00.000Z'));
    await harness(tournament).state.restore(tournament);
    vi.setSystemTime(new Date('2026-09-09T12:58:00.000Z'));
    const second = harness(tournament);
    await second.state.restore(tournament);
    expect(second.state.savedBlindTimerRemaining).toBe(300000);
    expect(second.writes).toEqual([]);
    vi.setSystemTime(new Date('2026-09-09T13:00:00.000Z'));
    await second.state.resumeFromBreak();
    expect(second.state.blindTimer.delay).toBe(300000);
    expect(second.state.savedBlindTimerRemaining).toBe(0);
    expect(second.writes).toEqual([{ level_started_at: '2026-09-09T12:55:00.000Z' }]);
  });

  it('ends a break whose countdown was never written with the maintenance break (2026-09-10)', async () => {
    // A deploy cutover lands inside the break before the old engine writes
    // the tournament countdown. With the maintenance break holding the fleet,
    // every table had finished its hand by :55, so the adopted break ends at
    // :00 with the cash tables - not at :02 on the last-hand grace.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-09T12:57:00.000Z'));
    const tournament = fixture({ break_ends_at: null });
    const held = harness(tournament, { maintenanceFrozen: true });
    await held.state.restore(tournament);
    expect(held.state.onBreak).toBe(true);
    expect([...held.timers].map((timer) => timer.delay)).toContain(180000);

    const unheld = harness(fixture({ break_ends_at: null }));
    await unheld.state.restore(fixture({ break_ends_at: null }));
    expect([...unheld.timers].map((timer) => timer.delay)).toContain(300000);
  });

  it('keeps the remainder during the existing last-hand grace fallback', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-09T12:56:00.000Z'));
    const tournament = fixture({ break_ends_at: null });
    const { state, writes } = harness(tournament);
    await state.restore(tournament);
    expect(state.savedBlindTimerRemaining).toBe(300000);
    expect(state.blindTimer).toBeNull();
    expect(writes).toEqual([]);
  });

  it('excludes the recorded break but counts elapsed time after its deadline', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-09T13:02:00.000Z'));
    const tournament = fixture();
    const { state } = harness(tournament);
    await state.restore(tournament);
    expect(state.onBreak).toBe(false);
    expect(state.blindTimer.delay).toBe(180000);
  });

  it('re-arms when entry reconciliation spans the break deadline', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-09T12:59:58.000Z'));
    const tournament = fixture();
    const { state, writes } = harness(tournament);
    state.reconcileTournamentEntryWindow = async () => {
      vi.setSystemTime(new Date('2026-09-09T13:00:02.000Z'));
    };
    await state.restore(tournament);
    expect(state.onBreak).toBe(false);
    expect(state.blindTimer.delay).toBe(300000);
    expect(state.savedBlindTimerRemaining).toBe(0);
    expect(writes.length).toBe(1);
  });

  it('preserves ordinary mid-level recovery without crediting an old break', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-09T12:57:00.000Z'));
    const tournament = fixture({ on_break: false });
    const { state } = harness(tournament);
    await state.restore(tournament);
    expect(state.blindTimer.delay).toBe(180000);
  });

  it('preserves the paused remainder when an add-on break starts during reconciliation', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-09T12:59:00.000Z'));
    const tournament = fixture();
    const { state } = harness(tournament);
    state.prizePoolFinalized = false;
    state.reconcileTournamentEntryWindow = () => state.beginAddOnBreak(Date.now() + 120000);
    await state.restore(tournament);
    expect(state.savedBlindTimerRemaining).toBe(300000);
    expect(state.blindTimer).toBeNull();
    expect(state.addOnBreakOwnsLevelClock).toBe(false);
  });

  it('hands the saved clock to an add-on break when reconciliation crosses the break end', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-09T12:59:58.000Z'));
    const tournament = fixture();
    const { state } = harness(tournament);
    state.prizePoolFinalized = false;
    state.reconcileTournamentEntryWindow = async () => {
      await state.beginAddOnBreak(Date.now() + 120000);
      vi.setSystemTime(new Date('2026-09-09T13:00:02.000Z'));
    };
    await state.restore(tournament);
    expect(state.savedBlindTimerRemaining).toBe(300000);
    expect(state.blindTimer).toBeNull();
    expect(state.onBreak).toBe(false);
    expect(state.addOnBreakOwnsLevelClock).toBe(true);
  });
});

/*
 * 2026-09-10: A RUNNING TOURNAMENT COMES OFF ITS BREAK AFTER THE THAW.
 *
 * The tournament countdown now ends on the hour with the maintenance break,
 * the same instant MaintenanceBreak.end() starts fn_thaw_platform. The thaw's
 * first call snapshots every RUNNING tournament with on_break = false and
 * moves its level_started_at forward by the frozen minutes. A tournament that
 * came off its break (on_break = false, then a freshly persisted
 * level_started_at) before that snapshot would be credited for a clock that
 * was suspended through the freeze, and the next engine to adopt it would
 * hand its level that much extra time. So resumeFromBreak waits while the
 * freeze is on - MaintenanceBreak.end() lifts it only after the thaw.
 */
describe('a running tournament comes off its break only after the maintenance thaw', () => {
  const ceilingMs = staticNumber('MAINTENANCE_THAW_WAIT_CEILING_MS');
  const pollMs = staticNumber('MAINTENANCE_THAW_POLL_MS');

  function table() {
    return { pauseAfterHand: vi.fn(), resumeDealing: vi.fn() };
  }

  it('waits for the thaw when an adopted break ends at :00 while the platform is still frozen', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-09T12:57:00.000Z'));
    let frozen = true;
    const tournament = fixture();
    const { state, writes, timers } = harness(tournament, { maintenanceFrozen: () => frozen });
    const engine = table();
    state.tableEngines = new Map([['t1', engine]]);
    // A replacement engine adopts the break at :57, inside the freeze.
    await state.restore(tournament);
    expect(state.onBreak).toBe(true);
    const rebreak = [...timers].find((timer) => timer.delay === 180000);
    expect(rebreak).toBeDefined();

    // :00. The adopted countdown ends while the thaw is still running.
    vi.setSystemTime(new Date('2026-09-09T13:00:00.000Z'));
    const resuming = rebreak!.callback() as Promise<void>;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(state.onBreak).toBe(true);
    expect(tournament.on_break).toBe(true);
    expect(state.clearPersistedBreak).not.toHaveBeenCalled();
    expect(state.broadcast).not.toHaveBeenCalled();
    expect(engine.resumeDealing).not.toHaveBeenCalled();
    expect(state.blindTimer).toBeNull();
    expect(writes).toEqual([]);

    // MaintenanceBreak.end(): the thaw has committed, the freeze lifts.
    frozen = false;
    await vi.advanceTimersByTimeAsync(pollMs);
    await resuming;
    expect(state.onBreak).toBe(false);
    expect(tournament.on_break).toBe(false);
    expect(state.broadcast).toHaveBeenCalledWith('break_ended', expect.anything());
    expect(engine.resumeDealing).toHaveBeenCalledOnce();
    // The level clock resumes with exactly what it had at :55, anchored now.
    expect(state.blindTimer.delay).toBe(300000);
    expect(writes).toEqual([{ level_started_at: new Date(Date.now() - 300000).toISOString() }]);
    // A final survivor on each table cannot create another hand-completion
    // event. Thaw itself must wake the consolidation work paused by the break.
    expect(state.requestEliminationSweep).toHaveBeenCalledWith('break_ended');
  });

  it('reports a slow thaw once and preserves the clock until the freeze actually lifts', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-09T13:00:00.000Z'));
    const tournament = fixture();
    let frozen = true;
    const { state, reportError, writes } = harness(tournament, { maintenanceFrozen: () => frozen });
    const engine = table();
    state.tableEngines = new Map([['t1', engine]]);
    state.onBreak = true;
    state.savedBlindTimerRemaining = 300000;

    const resuming = state.resumeFromBreak();
    await vi.advanceTimersByTimeAsync(ceilingMs - pollMs);
    expect(state.onBreak).toBe(true);
    expect(reportError).not.toHaveBeenCalled();
    expect(engine.resumeDealing).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(ceilingMs + pollMs);
    expect(reportError).toHaveBeenCalledOnce();
    const [error, context] = reportError.mock.calls[0];
    expect(context).toBe('TournamentManagerBase.resumeFromBreak_thaw_wait_ceiling');
    expect(String((error as Error).message)).toContain('clock-restart');
    expect(state.onBreak).toBe(true);
    expect(state.clearPersistedBreak).not.toHaveBeenCalled();
    expect(engine.resumeDealing).not.toHaveBeenCalled();
    expect(writes).toEqual([]);

    frozen = false;
    await vi.advanceTimersByTimeAsync(pollMs);
    await resuming;
    expect(state.onBreak).toBe(false);
    expect(state.clearPersistedBreak).toHaveBeenCalledOnce();
    expect(engine.resumeDealing).toHaveBeenCalledOnce();
    expect(state.blindTimer.delay).toBe(300000);
    expect(reportError).toHaveBeenCalledOnce();
  });

  it('leaves the break for its next owner when this lifecycle ends during the wait', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-09T13:00:00.000Z'));
    const tournament = fixture();
    const { state, writes, reportError } = harness(tournament, { maintenanceFrozen: true });
    const engine = table();
    state.tableEngines = new Map([['t1', engine]]);
    state.onBreak = true;
    let current = true;
    state.lifecycleIsCurrent = () => current;

    const resuming = state.resumeFromBreak();
    await vi.advanceTimersByTimeAsync(1_000);
    // stop() fenced the manager: a deploy cutover, or a lost lease.
    current = false;
    await vi.advanceTimersByTimeAsync(pollMs);
    await resuming;
    expect(state.onBreak).toBe(true);
    expect(tournament.on_break).toBe(true);
    expect(state.clearPersistedBreak).not.toHaveBeenCalled();
    expect(engine.resumeDealing).not.toHaveBeenCalled();
    expect(writes).toEqual([]);
    expect(reportError).not.toHaveBeenCalled();
  });

  it('takes the event off its break once when two resumes wait on the same thaw', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-09T13:00:00.000Z'));
    let frozen = true;
    const tournament = fixture();
    const { state } = harness(tournament, { maintenanceFrozen: () => frozen });
    const engine = table();
    state.tableEngines = new Map([['t1', engine]]);
    state.onBreak = true;
    state.savedBlindTimerRemaining = 300000;

    // The shared resume timer and the adoption timer can both land at :00.
    const first = state.resumeFromBreak();
    const second = state.resumeFromBreak();
    await vi.advanceTimersByTimeAsync(2_000);
    frozen = false;
    await vi.advanceTimersByTimeAsync(pollMs);
    await Promise.all([first, second]);
    expect(state.clearPersistedBreak).toHaveBeenCalledOnce();
    expect(state.broadcast).toHaveBeenCalledOnce();
    expect(engine.resumeDealing).toHaveBeenCalledOnce();
  });

  it('does not wait at all when the platform is not frozen, or for a stopped tournament', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-09T13:00:00.000Z'));
    const live = harness(fixture());
    live.state.onBreak = true;
    await live.state.resumeFromBreak();
    expect(live.state.onBreak).toBe(false);
    expect(live.state.clearPersistedBreak).toHaveBeenCalledOnce();

    // A tournament that stopped on its break only clears its flags, exactly
    // as before, frozen or not.
    const tournament = fixture();
    const stopped = harness(tournament, { maintenanceFrozen: true });
    const engine = table();
    stopped.state.tableEngines = new Map([['t1', engine]]);
    stopped.state.onBreak = true;
    stopped.state.running = false;
    await stopped.state.resumeFromBreak();
    expect(stopped.state.clearPersistedBreak).toHaveBeenCalledOnce();
    expect(tournament.on_break).toBe(false);
    expect(engine.resumeDealing).not.toHaveBeenCalled();
    expect(stopped.state.blindTimer).toBeNull();
  });
});

describe('a prepared timed event owes the complete first level at its booked start', () => {
  it('does not activate the blind clock when an earlier synchronized break ends', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-09T13:00:00.000Z'));
    const tournament = fixture({
      started_at: '2026-09-09T14:00:00.000Z',
      start_time: '2026-09-09T15:00:00.000Z',
      level_started_at: null,
    });
    const { state, writes } = harness(tournament);
    state.onBreak = true;
    state.savedBlindTimerRemaining = 600000;
    await state.resumeFromBreak();
    expect(state.onBreak).toBe(false);
    expect(state.blindTimer).toBeNull();
    expect(state.blindTimerStartedAt).toBe(0);
    expect(writes).toEqual([]);
    expect(state.advanceBlindLevel).not.toHaveBeenCalled();
    const waiting = state.blindStartTimer;
    expect(waiting.delay).toBe(3600000);
    vi.setSystemTime(new Date('2026-09-09T14:00:00.000Z'));
    await waiting.callback();
    expect(state.blindTimer.delay).toBe(600000);
    expect(writes).toEqual([{ level_started_at: '2026-09-09T14:00:00.000Z' }]);
    const firstLevel = state.blindTimer;
    vi.setSystemTime(new Date('2026-09-09T14:01:00.000Z'));
    await waiting.callback();
    expect(state.blindTimer).toBe(firstLevel);
    expect(writes).toHaveLength(1);
  });

  it('does not activate a replacement manager clock before the admitted start', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-09T13:03:00.000Z'));
    const tournament = fixture({
      started_at: '2026-09-09T14:00:00.000Z',
      level_started_at: null,
      on_break: false,
    });
    const { state, writes } = harness(tournament);
    await state.restore(tournament);
    expect(state.blindTimer).toBeNull();
    expect(writes).toEqual([]);
  });
});

describe('the delayed first-level wake has one owner through a pause', () => {
  it.each(['synchronized', 'add-on'])(
    'does not arm at the booked boundary during a %s break',
    async (kind) => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-09-09T13:59:00.000Z'));
      const tournament = fixture({
        started_at: '2026-09-09T14:00:00.000Z',
        level_started_at: null,
      });
      const { state, writes } = harness(tournament);
      state.startBlindTimer(tournament.blind_structure);
      const original = state.blindStartTimer;
      if (kind === 'synchronized') state.onBreak = true;
      else state.addOnBreakActive = true;
      state.suspendLevelClock();
      vi.setSystemTime(new Date('2026-09-09T14:00:00.000Z'));
      await original.callback(); // already delivered before cancellation
      expect(state.blindTimer).toBeNull();
      expect(writes).toEqual([]);
      expect(state.savedBlindTimerRemaining).toBe(600000);
      state.onBreak = true;
      state.addOnBreakActive = false;
      vi.setSystemTime(new Date('2026-09-09T14:03:00.000Z'));
      await state.resumeFromBreak();
      const firstLevel = state.blindTimer;
      expect(firstLevel.delay).toBe(600000);
      expect(writes).toEqual([{ level_started_at: '2026-09-09T14:03:00.000Z' }]);
      await original.callback();
      expect(state.blindTimer).toBe(firstLevel);
      expect(writes).toHaveLength(1);
    }
  );

  it('replaces an earlier waiting callback without allowing it to reset the active level', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-09T13:59:00.000Z'));
    const tournament = fixture({ started_at: '2026-09-09T14:00:00.000Z', level_started_at: null });
    const { state, writes } = harness(tournament);
    state.startBlindTimer(tournament.blind_structure);
    const original = state.blindStartTimer;
    state.startBlindTimer(tournament.blind_structure, 1000);
    const current = state.blindStartTimer;
    vi.setSystemTime(new Date('2026-09-09T14:00:00.000Z'));
    await current.callback();
    expect(state.blindTimer.delay).toBe(600000);
    const active = state.blindTimer;
    await original.callback();
    expect(state.blindTimer).toBe(active);
    expect(writes).toHaveLength(1);
  });
});
