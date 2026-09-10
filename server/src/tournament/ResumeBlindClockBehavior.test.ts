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
  'protected startBlindTimer(',
  'protected suspendLevelClock(',
  'async resumeFromBreak()',
  'private async beginAddOnBreak(',
].map((signature) => sliceMethod(source, signature).replace(/^(protected|private)\s+/, ''));
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
  opts: { maintenanceFrozen?: boolean } = {}
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
  const actual = new Function(
    'supabase',
    'TournamentManagerBase',
    'reportError',
    'isMaintenanceFrozen',
    runtime
  )(supabase, { LAST_HAND_GRACE_MS: 120000, BREAK_DURATION_MS: 300000 }, vi.fn(), () =>
    Boolean(opts.maintenanceFrozen)
  );
  const state: any = {
    ...actual,
    tournamentId: 'clock-restart',
    tournamentCache: tournament,
    running: true,
    currentLevel: 0,
    onBreak: false,
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
  return { state, writes, timers };
}

afterEach(() => vi.useRealTimers());

describe('the persisted blind clock survives an engine restart during a break', () => {
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
