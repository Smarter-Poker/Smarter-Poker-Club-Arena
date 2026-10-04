/*
 * 2026-10-04: AN ADD-ON BREAK BEGUN INSIDE THE FREEZE HAS NOT BEGUN.
 *
 * The add-on break is the last minute of the durable add-on window and its
 * start is a wall-clock timer. fn_thaw_platform moves the window forward by
 * the frozen duration, so a break whose pre-thaw start fell inside the
 * maintenance freeze starts, after the thaw, that much later. The timer fired
 * inside the freeze anyway, the manager adopted the pause, and the thaw re-read
 * re-armed only the START timer. The adopted break stayed active until the
 * shifted END.
 *
 * Production, $100 Freeroll e51546f6 (2026-10-04): break start 11:59:11 before
 * the thaw, window end 12:05:55 after it. Last hand 11:54:07, next hand
 * 12:06:12 on all 44 tables, with no break announced, while every other event
 * resumed at 12:01.
 *
 * These tests drive the real manager scheduling and real table engines through
 * that shape, with a thaw of exactly five minutes at 12:00:00.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GameServer } from '../GameServer.js';
import { ServerTableEngine } from '../engine/ServerTableEngine.js';
import { isMaintenanceFrozen, setMaintenanceFrozen } from '../maintenance/freezeState.js';
import { TournamentManagerBase } from './TournamentManagerBase.js';

const at = (clock: string): number => Date.parse(`2026-10-04T${clock}Z`);
const iso = (clock: string): string => new Date(at(clock)).toISOString();

class AddOnBreakHarness extends TournamentManagerBase {
  readonly broadcasts: string[] = [];
  readonly levelClockStarts: Array<number | undefined> = [];

  constructor() {
    super('e51546f6-0000-4000-8000-000000000001', {} as GameServer);
    (this as any).lifecycleEpoch.begin();
    this.running = true;
    this.tournamentCache = { addon_break_minutes: 1, blind_structure: [] } as any;
    (this as any).prizePoolFinalized = false;
    (this as any).requestEliminationSweep = () => {};
    (this as any).scheduleAddOnRetry = () => {};
  }

  add(id: string, engine: ServerTableEngine): void {
    this.tableEngines.set(id, engine);
  }

  /** What resume() and the thaw re-read both call with the durable deadline. */
  schedule(endsAt: string): void {
    (this as any).scheduleAddOnBreak(endsAt);
  }

  synchronizedBreak(on: boolean): void {
    this.onBreak = on;
  }

  get breakActive(): boolean {
    return (this as any).addOnBreakActive === true;
  }

  get startTimerArmed(): boolean {
    return (this as any).addOnBreakStartTimer !== null;
  }

  protected override async broadcast(event: string): Promise<boolean> {
    this.broadcasts.push(event);
    return true;
  }
  protected override startBlindTimer(_structure: any[], remainingOverrideMs?: number): void {
    this.levelClockStarts.push(remainingOverrideMs);
  }
  protected override suspendLevelClock(): void {
    this.savedBlindTimerRemaining = 240_000;
  }
  protected override startEliminationChecker(): void {}
  protected override async recalculateEliminatedPrizes(): Promise<boolean> {
    return true;
  }
}

function table(id: string) {
  const engine = new ServerTableEngine(id);
  const state = engine as any;
  state.running = true;
  /** The engine's own answer to "may the next hand be dealt". */
  const held = (): boolean => state.isNextHandPaused() === true;
  return { engine, state, held };
}

function field() {
  const manager = new AddOnBreakHarness();
  const a = table('81818181-8181-4181-8181-818181818181');
  const b = table('82828282-8282-4282-8282-828282828282');
  manager.add('a', a.engine);
  manager.add('b', b.engine);
  return { manager, a, b };
}

/** Run the fake clock forward to a wall-clock instant, firing what is due. */
async function goTo(clock: string): Promise<void> {
  await vi.advanceTimersByTimeAsync(Math.max(0, at(clock) - Date.now()));
  await vi.advanceTimersByTimeAsync(0);
}

beforeEach(() => {
  vi.useFakeTimers();
  setMaintenanceFrozen(false);
});
afterEach(() => {
  setMaintenanceFrozen(false);
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('an add-on break whose start fell inside the maintenance freeze', () => {
  it('is withdrawn by the thaw re-read and its tables deal until the shifted start', async () => {
    const { manager, a, b } = field();
    vi.setSystemTime(at('11:52:00'));
    manager.schedule(iso('12:00:55'));
    expect(manager.startTimerArmed).toBe(true);

    // :53 announcement. This event takes no synchronized break, so nothing but
    // the maintenance break and the add-on break can hold its tables.
    setMaintenanceFrozen(true);
    a.engine.pauseForMaintenance(600_000);
    b.engine.pauseForMaintenance(600_000);

    // 11:59:55, inside the freeze: the pre-thaw timer fires and the pause is
    // adopted without an announcement.
    await goTo('11:59:55');
    expect(manager.breakActive).toBe(true);
    expect(manager.broadcasts).not.toContain('addon_break');
    expect(a.state.dealHoldUntilMs).toBe(at('12:00:55'));
    expect(a.state.handForHandPaused).toBe(true);

    // 12:00:00, the thaw: fn_thaw_platform committed +5 minutes and the
    // manager re-reads the row while the freeze flag is still raised.
    await goTo('12:00:00');
    expect(isMaintenanceFrozen()).toBe(true);
    manager.schedule(iso('12:05:55'));

    expect(manager.breakActive).toBe(false);
    expect(manager.isOnBreak()).toBe(false);
    expect(manager.startTimerArmed).toBe(true);
    for (const t of [a, b]) {
      expect(t.state.dealHoldUntilMs).toBe(0);
      expect(t.state.handForHandPaused).toBe(false);
      // The maintenance break is still the owner of the table until it resumes.
      expect(t.held()).toBe(true);
    }
    // The level clock the withdrawn break suspended is running again.
    expect(manager.levelClockStarts).toEqual([240_000]);

    setMaintenanceFrozen(false);
    a.engine.resumeFromMaintenance();
    b.engine.resumeFromMaintenance();
    expect(a.held()).toBe(false);
    expect(b.held()).toBe(false);

    // Four minutes of play later the break is still not on.
    await goTo('12:04:00');
    expect(manager.breakActive).toBe(false);
    expect(a.held()).toBe(false);

    // 12:04:55: the real break, one minute, announced.
    await goTo('12:04:55');
    expect(manager.breakActive).toBe(true);
    expect(manager.broadcasts).toContain('addon_break');
    expect(a.state.dealHoldUntilMs).toBe(at('12:05:55'));
    expect(a.held()).toBe(true);

    await goTo('12:05:55');
    expect(manager.breakActive).toBe(false);
    expect(a.state.handForHandPaused).toBe(false);
  });

  it('leaves the synchronized break as the only holder when one is running', async () => {
    const { manager, a } = field();
    vi.setSystemTime(at('11:52:00'));
    manager.schedule(iso('12:00:55'));
    setMaintenanceFrozen(true);
    manager.synchronizedBreak(true);
    a.engine.pauseAfterHand(420_000, { beforeNextHand: true, untilResumed: true });

    await goTo('11:59:55');
    expect(manager.breakActive).toBe(true);

    await goTo('12:00:00');
    manager.schedule(iso('12:05:55'));

    expect(manager.breakActive).toBe(false);
    expect(a.state.dealHoldUntilMs).toBe(0);
    // The synchronized break armed this pause and is still on: it is not lifted
    // here, and the level clock it suspended is not restarted from under it.
    expect(a.engine.requiresExplicitPauseResume()).toBe(true);
    expect(manager.isOnBreak()).toBe(true);
    expect(manager.levelClockStarts).toEqual([]);
  });

  it('never shortens a later hold another authority placed on the table', async () => {
    const { manager, a } = field();
    vi.setSystemTime(at('11:52:00'));
    manager.schedule(iso('12:00:55'));
    setMaintenanceFrozen(true);
    await goTo('11:59:55');
    a.engine.holdDealingUntil(at('12:02:00'));

    await goTo('12:00:00');
    manager.schedule(iso('12:05:55'));

    expect(manager.breakActive).toBe(false);
    expect(a.state.dealHoldUntilMs).toBe(at('12:02:00'));
  });
});

describe('an add-on break that began before the freeze', () => {
  it('keeps its pause through the thaw and ends at the shifted deadline', async () => {
    const { manager, a } = field();
    // Start 11:54:30, end 11:55:30: thirty seconds were played out before the
    // :55 freeze, thirty remain.
    vi.setSystemTime(at('11:52:00'));
    manager.schedule(iso('11:55:30'));
    setMaintenanceFrozen(true);
    await goTo('11:54:30');
    expect(manager.breakActive).toBe(true);

    // The end timer fires inside the freeze and must not release.
    await goTo('11:55:30');
    expect(manager.breakActive).toBe(true);

    // Thaw: the window now ends 12:00:30, so the break started at 11:59:30.
    await goTo('12:00:00');
    manager.schedule(iso('12:00:30'));
    await goTo('12:00:00');
    expect(manager.breakActive).toBe(true);
    expect(a.state.dealHoldUntilMs).toBe(at('12:00:30'));

    setMaintenanceFrozen(false);
    await goTo('12:00:30');
    expect(manager.breakActive).toBe(false);
    expect(a.state.dealHoldUntilMs).toBeLessThanOrEqual(Date.now());
  });
});
