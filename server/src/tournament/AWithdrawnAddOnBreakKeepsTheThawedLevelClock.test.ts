/*
 * 2026-10-05: A WITHDRAWN ADD-ON BREAK GIVES THE LEVEL CLOCK BACK FROM THE
 * THAWED ROW.
 *
 * AnAddOnBreakBegunInsideTheFreezeHasNotBegun.test.ts pins that a break whose
 * start fell inside the maintenance freeze is withdrawn by the thaw re-read.
 * This file pins what the withdrawal does to the LEVEL clock the break had
 * suspended.
 *
 * Before: withdrawAddOnBreakBegunBeforeItsStart re-armed through
 * startBlindTimer(savedBlindTimerRemaining). That remainder was measured
 * inside the freeze against the pre-freeze anchor, so the minutes from the
 * freeze start to the break start were burned, and startBlindTimer persisted
 * the burned anchor with an unfenced detached update. GameServer runs
 * resyncLevelClockAfterMaintenanceThaw straight after the add-on re-read; when
 * its read beat that write, memory followed the thawed anchor and the row was
 * then overwritten with the burned one.
 *
 * These tests drive the real manager: real suspendLevelClock, real
 * startBlindTimer, real resyncLevelClockAfterMaintenanceThaw, against one
 * durable tournaments row. Level 0 is 20 minutes from 11:50:00, the freeze
 * runs 11:53 to 12:00 and fn_thaw_platform moves the anchor to 11:57:00, so
 * the level is due at 12:17:00.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GameServer } from '../GameServer.js';
import { setMaintenanceFrozen } from '../maintenance/freezeState.js';

const brainContext = vi.hoisted(() => ({ refreshAfterClockCommit: vi.fn() }));
vi.mock('../services/TournamentBrainContext.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/TournamentBrainContext.js')>()),
  refreshTournamentBrainContextAfterClockCommit: brainContext.refreshAfterClockCommit,
}));

let TournamentManagerBase: (typeof import('./TournamentManagerBase.js'))['TournamentManagerBase'];
let supabase: (typeof import('../services/supabase.js'))['supabase'];

beforeAll(async () => {
  process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-placeholder-key';
  ({ TournamentManagerBase } = await import('./TournamentManagerBase.js'));
  ({ supabase } = await import('../services/supabase.js'));
});

const at = (clock: string): number => Date.parse(`2026-10-04T${clock}Z`);
const iso = (clock: string): string => new Date(at(clock)).toISOString();
const structure = [
  { smallBlind: 25, bigBlind: 50, durationMinutes: 20 },
  { smallBlind: 50, bigBlind: 100, durationMinutes: 20 },
];

/** The durable row, with a PostgREST-shaped fenced update and a controllable read. */
function durableRow() {
  const row: Record<string, any> = {
    id: 'a0a0a0a0-0000-4000-8000-000000000001',
    status: 'RUNNING',
    current_level: 0,
    on_break: false,
    level_started_at: iso('11:50:00'),
  };
  const anchorWrites: string[] = [];
  /** Reads wait on this gate when set, so a test can order read and write. */
  let readGate: Promise<void> | null = null;
  vi.spyOn(supabase, 'from').mockReturnValue({
    select: () => ({
      eq: () => ({
        maybeSingle: async () => {
          const snapshot = structuredClone(row);
          if (readGate) await readGate;
          return { data: snapshot, error: null };
        },
      }),
    }),
    update: (patch: Record<string, unknown>) => {
      const filters: Array<[string, unknown]> = [];
      const builder: any = {
        eq(column: string, value: unknown) {
          filters.push([column, value]);
          return builder;
        },
        then(resolve: (value: { error: null }) => unknown, reject?: (r: unknown) => unknown) {
          if (filters.every(([column, value]) => row[column] === value)) {
            if (typeof patch.level_started_at === 'string')
              anchorWrites.push(patch.level_started_at);
            Object.assign(row, patch);
          }
          return Promise.resolve({ error: null }).then(resolve, reject);
        },
      };
      return builder;
    },
  } as never);
  return {
    row,
    anchorWrites,
    holdReads(gate: Promise<void> | null) {
      readGate = gate;
    },
  };
}

function harness() {
  class Harness extends TournamentManagerBase {
    readonly levelWakes: number[] = [];
    constructor() {
      super('a0a0a0a0-0000-4000-8000-000000000001', {} as GameServer);
      (this as any).lifecycleEpoch.begin();
      this.running = true;
      this.currentLevel = 0;
      this.tournamentCache = {
        addon_break_minutes: 1,
        blind_structure: structure,
        level_started_at: iso('11:50:00'),
      } as any;
      (this as any).prizePoolFinalized = false;
      (this as any).requestEliminationSweep = () => {};
      (this as any).scheduleAddOnRetry = () => {};
    }
    schedule(endsAt: string): void {
      (this as any).scheduleAddOnBreak(endsAt);
    }
    protected override async broadcast(): Promise<boolean> {
      return true;
    }
    /** Record when the level would go up; publication is pinned elsewhere. */
    protected override async advanceBlindLevel(_structure?: any[]): Promise<void> {
      this.levelWakes.push(Date.now());
    }
    protected override startEliminationChecker(): void {}
    protected override async recalculateEliminatedPrizes(): Promise<boolean> {
      return true;
    }
  }
  return new Harness();
}

async function goTo(clock: string): Promise<void> {
  await vi.advanceTimersByTimeAsync(Math.max(0, at(clock) - Date.now()));
  await vi.advanceTimersByTimeAsync(0);
}

/**
 * 11:50 the level starts (anchor already durable). 11:53 the freeze. 11:59:55
 * the pre-thaw add-on break timer fires inside it and suspends the level
 * clock. 12:00:00 the thaw commits +7 minutes to the level anchor and +5 to
 * the add-on window, then the add-on re-read withdraws the break.
 */
async function withdrawInsideTheThaw(db: ReturnType<typeof durableRow>) {
  const manager = harness();
  vi.setSystemTime(at('11:50:00'));
  (manager as any).blindTimer = (manager as any).setLifecycleTimeout(
    () => manager['advanceBlindLevel']([]),
    20 * 60_000
  );
  (manager as any).blindTimerStartedAt = at('11:50:00');
  manager.schedule(iso('12:00:55'));

  await goTo('11:53:00');
  setMaintenanceFrozen(true);
  await goTo('11:59:55');
  expect((manager as any).addOnBreakActive).toBe(true);
  expect((manager as any).blindTimer).toBeNull();

  await goTo('12:00:00');
  db.row.level_started_at = iso('11:57:00');
  manager.schedule(iso('12:05:55'));
  expect((manager as any).addOnBreakActive).toBe(false);
  return manager;
}

beforeEach(() => {
  vi.useFakeTimers();
  setMaintenanceFrozen(false);
  brainContext.refreshAfterClockCommit.mockReset();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  setMaintenanceFrozen(false);
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('a withdrawn add-on break restores the level clock from the thawed anchor', () => {
  it('never writes the anchor it measured inside the freeze, whichever lands first', async () => {
    const db = durableRow();
    let releaseRead!: () => void;
    // The thaw re-read's level read is issued before any detached write could
    // land and answers after it: the order that left memory and row apart.
    db.holdReads(new Promise<void>((resolve) => (releaseRead = resolve)));
    const manager = await withdrawInsideTheThaw(db);
    const resync = manager.resyncLevelClockAfterMaintenanceThaw();
    await vi.advanceTimersByTimeAsync(0);
    releaseRead();
    await resync;
    await vi.advanceTimersByTimeAsync(0);

    expect(db.anchorWrites).toEqual([]);
    expect(db.row.level_started_at).toBe(iso('11:57:00'));
    expect((manager as any).blindTimerStartedAt).toBe(at('11:57:00'));
  });

  it('runs the level to the thawed deadline, with no frozen minutes burned', async () => {
    const db = durableRow();
    const manager = await withdrawInsideTheThaw(db);
    await manager.resyncLevelClockAfterMaintenanceThaw();
    setMaintenanceFrozen(false);

    // Play resumes on the thawed clock: due 12:17:00, not 12:10:05.
    await goTo('12:04:54');
    expect((manager as any).blindTimerStartedAt).toBe(at('11:57:00'));
    expect(manager.levelWakes).toEqual([]);

    // The real one-minute add-on break (12:04:55 to 12:05:55) then stops the
    // clock for its minute, as every add-on break does: due 12:18:00.
    await goTo('12:17:59');
    expect(manager.levelWakes).toEqual([]);
    await goTo('12:18:00');
    expect(manager.levelWakes).toEqual([at('12:18:00')]);
    // The only anchor ever persisted is the one the real break credited.
    expect(db.anchorWrites).toEqual([iso('11:58:00')]);
  });

  it('leaves the wake to reread the anchor when the thaw read does not land', async () => {
    const db = durableRow();
    const manager = await withdrawInsideTheThaw(db);
    // No resync ran. The provisional wake must not publish from the burned
    // measurement: it is flagged to reread the durable anchor first.
    expect((manager as any).blindTimer).not.toBeNull();
    expect((manager as any).blindClockNeedsThawResync).toBe(true);
    expect(db.anchorWrites).toEqual([]);
  });
});

describe('the level-clock persist is fenced', () => {
  it('does not land on a level the row has moved past', async () => {
    const db = durableRow();
    const manager = harness();
    vi.setSystemTime(at('12:30:00'));
    db.row.current_level = 1;
    db.row.level_started_at = iso('12:29:00');
    // A stale arm of level 0 in this process.
    (manager as any).startBlindTimer(structure, 60_000);
    await vi.advanceTimersByTimeAsync(0);
    expect(db.row.level_started_at).toBe(iso('12:29:00'));
    expect(db.anchorWrites).toEqual([]);
  });
});
