import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { setMaintenanceFrozen } from '../maintenance/freezeState.js';

// The Horse tournament context reads the committed clock through its own
// lifecycle; these tests pin when the manager asks it to.
const brainContext = vi.hoisted(() => ({ refreshAfterClockCommit: vi.fn() }));
vi.mock('../services/TournamentBrainContext.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/TournamentBrainContext.js')>()),
  refreshTournamentBrainContextAfterClockCommit: brainContext.refreshAfterClockCommit,
}));

let TournamentManagerBase: (typeof import('./TournamentManagerBase.js'))['TournamentManagerBase'];
let supabase: (typeof import('../services/supabase.js'))['supabase'];
let tableStateHub: (typeof import('../transport/TableStateHub.js'))['tableStateHub'];

beforeAll(async () => {
  process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-placeholder-key';
  ({ TournamentManagerBase } = await import('./TournamentManagerBase.js'));
  ({ supabase } = await import('../services/supabase.js'));
  ({ tableStateHub } = await import('../transport/TableStateHub.js'));
});
beforeEach(() => {
  setMaintenanceFrozen(false);
  brainContext.refreshAfterClockCommit.mockReset();
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-10T12:01:00.000Z'));
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(tableStateHub, 'emitEvent').mockImplementation(() => {});
});
afterEach(() => {
  setMaintenanceFrozen(false);
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const structure = [
  { smallBlind: 25, bigBlind: 50, durationMinutes: 10 },
  { smallBlind: 50, bigBlind: 100, durationMinutes: 10 },
  { smallBlind: 100, bigBlind: 200, durationMinutes: 10 },
];

/**
 * A Spin-shaped event (no synchronized break) whose level 0 began at 12:00
 * and is due at 12:10. The level wake is a real (fake-timer) setTimeout, so
 * advancing the clock fires it exactly where a live process would.
 */
function fixture() {
  const row: Record<string, any> = {
    current_level: 0,
    level_started_at: '2026-09-10T12:00:00.000Z',
    on_break: false,
    blind_structure: structure,
    prize_pool_finalized: true,
  };
  const state: any = Object.assign(Object.create(TournamentManagerBase.prototype), {
    tournamentId: 'thaw-level-clock',
    tournamentLeaseGeneration: 'active-generation',
    tournamentCache: structuredClone(row),
    running: true,
    currentLevel: 0,
    onBreak: false,
    addOnBreakActive: false,
    blindTimer: null,
    blindTimerStartedAt: 0,
    lastObservedHandCompletedAtMs: Date.parse('2026-09-10T12:00:30.000Z'),
    stalledLevelHoldAnnouncedFor: new Set<number>(),
    askForConsolidationIfSpread: vi.fn(),
    tableEngines: new Map([['table-one', {}]]),
    lifecycleEpoch: { current: () => 1, isCurrent: () => state.running },
    lifecycleIsCurrent: () => state.running,
    assertLifecycleCurrent: () => {
      if (!state.running) throw new Error('stale manager');
    },
    reconcileTournamentEntryWindow: vi.fn().mockResolvedValue(undefined),
    requestUrgentEliminationSweepAfter: vi.fn(),
    broadcast: vi.fn().mockResolvedValue(undefined),
    trackLifecycleJob: (promise: Promise<unknown>) => promise,
    setLifecycleTimeout: (callback: () => unknown, delay: number) => setTimeout(callback, delay),
    clearLifecycleTimeout: (timer: ReturnType<typeof setTimeout>) => clearTimeout(timer),
  });
  const read = vi.fn(async () => ({
    data: { id: state.tournamentId, status: 'RUNNING', ...structuredClone(row) },
    error: null as { message: string } | null,
  }));
  vi.spyOn(supabase, 'from').mockReturnValue({
    select: () => ({ eq: () => ({ maybeSingle: read }) }),
    update: (patch: Record<string, unknown>) => ({
      eq: async () => {
        Object.assign(row, patch);
        return { error: null };
      },
    }),
  } as never);
  const rpc = vi
    .spyOn(supabase as unknown as { rpc: (name: string, args: any) => Promise<any> }, 'rpc')
    .mockImplementation(async (_name: string, args: any) => {
      if (row.current_level !== args.p_next_level)
        Object.assign(row, {
          current_level: args.p_next_level,
          level_started_at: new Date().toISOString(),
          blind_level_state: {
            index: args.p_next_level,
            small_blind: args.p_small_blind,
            big_blind: args.p_big_blind,
            ante: args.p_ante,
          },
        });
      return {
        data: {
          ok: true,
          tournament_id: state.tournamentId,
          current_level: row.current_level,
          level_started_at: row.level_started_at,
          blind_level_state: structuredClone(row.blind_level_state),
        },
        error: null,
      } as never;
    });
  // Level 0 has nine of its ten minutes left: the wake is due at 12:10.
  state.startBlindTimer(structure, 9 * 60_000);
  return { row, state, read, rpc };
}

/** 12:02 to 12:09: seven frozen minutes. The level was not due inside them. */
async function freezeAndThaw(row: Record<string, any>) {
  await vi.advanceTimersByTimeAsync(60_000);
  setMaintenanceFrozen(true);
  await vi.advanceTimersByTimeAsync(7 * 60_000);
  // fn_thaw_platform gives the level its seven minutes back.
  row.level_started_at = '2026-09-10T12:07:00.000Z';
}

/** The tables deal again after the thaw, so the level is not a stalled one. */
function handLandsAfterThaw(state: any) {
  state.lastObservedHandCompletedAtMs = Date.now() + 30_000;
}

describe('a level clock that runs through the maintenance freeze', () => {
  it('goes up where the thawed anchor says, not the frozen minutes early', async () => {
    const { row, state, read, rpc } = fixture();
    expect(state.blindTimerStartedAt).toBe(Date.parse('2026-09-10T12:00:00.000Z'));
    await freezeAndThaw(row);
    expect(rpc).not.toHaveBeenCalled();

    // GameServer's thaw hook, after the thaw commits and before release.
    const refreshesBefore = brainContext.refreshAfterClockCommit.mock.calls.length;
    await state.resyncLevelClockAfterMaintenanceThaw();
    setMaintenanceFrozen(false);
    handLandsAfterThaw(state);

    // 12:10 is the pre-freeze deadline. The level still has seven minutes.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(rpc).not.toHaveBeenCalled();
    expect(state.currentLevel).toBe(0);
    expect(read).toHaveBeenCalledOnce();
    expect(state.blindTimerStartedAt).toBe(Date.parse('2026-09-10T12:07:00.000Z'));
    expect(state.tournamentCache.level_started_at).toBe('2026-09-10T12:07:00.000Z');
    expect(brainContext.refreshAfterClockCommit).toHaveBeenCalledTimes(refreshesBefore + 1);
    expect(brainContext.refreshAfterClockCommit).toHaveBeenLastCalledWith('thaw-level-clock');
    await vi.advanceTimersByTimeAsync(7 * 60_000 - 1);
    expect(rpc).not.toHaveBeenCalled();
    expect(state.currentLevel).toBe(0);

    // 12:17 is the durable deadline: ten minutes after the thawed anchor.
    await vi.advanceTimersByTimeAsync(1);
    expect(rpc).toHaveBeenCalledOnce();
    expect(state.currentLevel).toBe(1);
    expect(row.level_started_at).toBe('2026-09-10T12:17:00.000Z');
  });

  it('rereads the anchor itself when the old wake fires before the thaw read lands', async () => {
    const { row, state, read, rpc } = fixture();
    await freezeAndThaw(row);
    let land: () => void = () => {};
    read.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          land = () =>
            resolve({
              data: { id: state.tournamentId, status: 'RUNNING', ...structuredClone(row) },
              error: null,
            });
        })
    );
    const resync = state.resyncLevelClockAfterMaintenanceThaw();
    setMaintenanceFrozen(false);
    handLandsAfterThaw(state);

    // The pre-freeze wake fires at 12:10 while the thaw read is still out.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(rpc).not.toHaveBeenCalled();
    expect(read).toHaveBeenCalledTimes(2);
    expect(state.blindTimerStartedAt).toBe(Date.parse('2026-09-10T12:07:00.000Z'));

    // The slow read lands on a clock the wake has already re-armed.
    land();
    await resync;
    await vi.advanceTimersByTimeAsync(7 * 60_000 - 1);
    expect(rpc).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(rpc).toHaveBeenCalledOnce();
    expect(state.currentLevel).toBe(1);
  });

  it('leaves the wake to reread a durable row that does not match this clock', async () => {
    const { row, state, read, rpc } = fixture();
    await freezeAndThaw(row);
    read.mockImplementationOnce(async () => ({
      data: {
        id: state.tournamentId,
        status: 'RUNNING',
        ...structuredClone(row),
        current_level: 2,
      },
      error: null,
    }));
    await state.resyncLevelClockAfterMaintenanceThaw();
    setMaintenanceFrozen(false);
    handLandsAfterThaw(state);
    // Nothing adopted from a mismatched row.
    expect(state.blindTimerStartedAt).toBe(Date.parse('2026-09-10T12:00:00.000Z'));

    // The old wake still fires at 12:10, but it rereads before it publishes.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(read).toHaveBeenCalledTimes(2);
    expect(rpc).not.toHaveBeenCalled();
    expect(state.blindTimerStartedAt).toBe(Date.parse('2026-09-10T12:07:00.000Z'));
    await vi.advanceTimersByTimeAsync(7 * 60_000);
    expect(rpc).toHaveBeenCalledOnce();
  });

  it('adopts the anchor of a level that came due inside the freeze', async () => {
    const { row, state, read, rpc } = fixture();
    await vi.advanceTimersByTimeAsync(60_000);
    setMaintenanceFrozen(true);
    // 12:02 to 12:12: the level comes due at 12:10 and is held.
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(rpc).not.toHaveBeenCalled();
    row.level_started_at = '2026-09-10T12:10:00.000Z';
    await state.resyncLevelClockAfterMaintenanceThaw();
    setMaintenanceFrozen(false);
    handLandsAfterThaw(state);
    expect(read).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(8 * 60_000 - 1);
    expect(rpc).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(rpc).toHaveBeenCalledOnce();
  });

  it('reads nothing for a clock the break suspended, and still refreshes the context', async () => {
    const { state, read } = fixture();
    // The arm above persisted its anchor; only the thaw's refresh is under test.
    await vi.advanceTimersByTimeAsync(0);
    brainContext.refreshAfterClockCommit.mockReset();
    state.onBreak = true;
    await state.resyncLevelClockAfterMaintenanceThaw();
    expect(read).not.toHaveBeenCalled();
    expect(brainContext.refreshAfterClockCommit).toHaveBeenCalledOnce();

    state.onBreak = false;
    state.running = false;
    brainContext.refreshAfterClockCommit.mockReset();
    await state.resyncLevelClockAfterMaintenanceThaw();
    expect(read).not.toHaveBeenCalled();
    expect(brainContext.refreshAfterClockCommit).not.toHaveBeenCalled();
  });

  it('is driven by the GameServer thaw after the database thaw commits', () => {
    const gameServer = readFileSync(join(process.cwd(), 'src/GameServer.ts'), 'utf8');
    const thaw = gameServer.indexOf('const release = await runMaintenanceThawV3(');
    const resync = gameServer.indexOf('await manager.resyncLevelClockAfterMaintenanceThaw()');
    const released = gameServer.indexOf('return release;', thaw);
    expect(thaw).toBeGreaterThan(0);
    expect(resync).toBeGreaterThan(thaw);
    expect(resync).toBeLessThan(released);
    expect(gameServer.slice(resync, released)).toContain(
      "reportError(error, 'GameServer.level_clock_thaw_resync_failed')"
    );
  });
});
