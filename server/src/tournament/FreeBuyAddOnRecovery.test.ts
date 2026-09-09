import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GameServer } from '../GameServer.js';
import { supabase } from '../services/supabase.js';
import { TournamentManagerBase } from './TournamentManagerBase.js';

const TOURNAMENT_ID = 'aaaaaaaa-0000-4000-8000-000000000001';

type WindowRow = {
  addon_period_triggered: boolean;
  addon_period_started_at: string | null;
  addon_period_ends_at: string | null;
  add_on_available: boolean;
  prize_pool_finalized: boolean;
  prize_pool?: number | null;
  status: string;
};

class AddOnRecoveryHarness extends TournamentManagerBase {
  readonly broadcastCall = vi.fn<(eventType: string, payload: unknown) => Promise<boolean>>(
    async () => true
  );

  constructor() {
    super(TOURNAMENT_ID, {} as GameServer);
  }

  activate(cache: Record<string, unknown> = {}): void {
    (this as unknown as { lifecycleEpoch: { begin(): unknown } }).lifecycleEpoch.begin();
    this.running = true;
    this.tournamentCache = {
      add_on_available: true,
      addon_from_start: true,
      late_reg_mins: 60,
      addon_break_minutes: 5,
      start_time: '2026-09-09T13:00:00.000Z',
      ...cache,
    };
  }

  open(): Promise<void> {
    return this.triggerAddOnPeriod();
  }

  drive(rebroadcastAfterThaw = false): Promise<string> {
    return (
      this as unknown as {
        drivePersistedAddOnDeadline(rebroadcast: boolean): Promise<string>;
      }
    ).drivePersistedAddOnDeadline(rebroadcastAfterThaw);
  }

  setTriggered(value: boolean): void {
    this.addOnPeriodTriggered = value;
  }

  protected override broadcast(eventType: string, payload: unknown): Promise<boolean> {
    return this.broadcastCall(eventType, payload);
  }

  protected override startEliminationChecker(): void {}

  protected override async recalculateEliminatedPrizes(): Promise<boolean> {
    return true;
  }
}

function stubSingleRead(row: WindowRow | null, error: { message: string } | null = null) {
  const maybeSingle = vi.fn(async () => ({ data: row, error }));
  const builder: Record<string, ReturnType<typeof vi.fn>> = {};
  builder.select = vi.fn(() => builder);
  builder.eq = vi.fn(() => builder);
  builder.maybeSingle = maybeSingle;
  const from = vi.spyOn(supabase, 'from').mockReturnValue(builder as never);
  return { from, maybeSingle };
}

function stubLostOpenThenDurableRead(initial: WindowRow) {
  const row = { ...initial };
  let readNumber = 0;
  const updates: Array<Record<string, unknown>> = [];

  const from = vi.spyOn(supabase, 'from').mockImplementation((relation: string) => {
    if (relation !== 'tournaments') throw new Error(`unexpected relation ${relation}`);
    let updatePayload: Record<string, unknown> | null = null;
    const builder: Record<string, any> = {};
    builder.select = vi.fn(() => builder);
    builder.update = vi.fn((payload: Record<string, unknown>) => {
      updatePayload = payload;
      updates.push(payload);
      return builder;
    });
    builder.eq = vi.fn(() => builder);
    builder.in = vi.fn(() => builder);
    builder.maybeSingle = vi.fn(async () => {
      if (updatePayload) {
        Object.assign(row, updatePayload);
        return { data: null, error: { message: 'write response timed out' } };
      }
      readNumber += 1;
      if (readNumber === 2) {
        return { data: null, error: { message: 'proof read timed out' } };
      }
      return { data: { ...row }, error: null };
    });
    return builder as never;
  });

  return { from, row, updates, readCount: () => readNumber };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('Free Buy add-on recovery executes the durable receipt contract', () => {
  it('adopts a committed lost-response window after expiry without deriving or writing a replacement', async () => {
    vi.setSystemTime(new Date('2026-09-09T13:30:00.000Z'));
    const database = stubLostOpenThenDurableRead({
      addon_period_triggered: false,
      addon_period_started_at: null,
      addon_period_ends_at: null,
      add_on_available: true,
      prize_pool_finalized: false,
      status: 'REGISTERING',
    });
    const manager = new AddOnRecoveryHarness();
    manager.activate();
    const scheduleClose = vi.fn();
    const scheduleBreak = vi.fn();
    Object.assign(manager, {
      scheduleAddOnPeriodEnd: scheduleClose,
      scheduleAddOnBreak: scheduleBreak,
    });

    await manager.open();
    expect(database.updates).toHaveLength(1);
    expect(database.row).toMatchObject({
      addon_period_triggered: true,
      addon_period_started_at: '2026-09-09T13:30:00.000Z',
      addon_period_ends_at: '2026-09-09T14:35:00.000Z',
    });
    expect(scheduleClose).not.toHaveBeenCalled();

    vi.setSystemTime(new Date('2026-09-09T15:00:00.000Z'));
    await manager.open();

    expect(database.updates).toHaveLength(1);
    expect(scheduleClose).toHaveBeenCalledOnce();
    expect(scheduleClose).toHaveBeenCalledWith('2026-09-09T14:35:00.000Z');
    expect(scheduleBreak).toHaveBeenCalledWith('2026-09-09T14:35:00.000Z');
    expect(manager.broadcastCall).not.toHaveBeenCalled();
  });

  it('refuses a partial persisted receipt without arming a timer', async () => {
    vi.setSystemTime(new Date('2026-09-09T13:30:00.000Z'));
    stubSingleRead({
      addon_period_triggered: true,
      addon_period_started_at: '2026-09-09T13:20:00.000Z',
      addon_period_ends_at: null,
      add_on_available: true,
      prize_pool_finalized: false,
      status: 'RUNNING',
    });
    const manager = new AddOnRecoveryHarness();
    manager.activate();
    const scheduleClose = vi.fn();
    Object.assign(manager, { scheduleAddOnPeriodEnd: scheduleClose });

    await manager.open();

    expect(scheduleClose).not.toHaveBeenCalled();
    expect(manager.broadcastCall).not.toHaveBeenCalled();
  });
});

describe('the persisted add-on deadline is a typed dealer-admission proof', () => {
  it('returns unproven on an unreadable row and retains the causal retry', async () => {
    stubSingleRead(null, { message: 'network unavailable' });
    const manager = new AddOnRecoveryHarness();
    manager.activate();
    manager.setTriggered(true);
    const retry = vi.fn();
    Object.assign(manager, { requestAddOnDeadlineRetry: retry });

    await expect(manager.drive()).resolves.toBe('unproven');
    expect(retry).toHaveBeenCalledWith(5_000);
  });

  it('returns active_rearmed only after arming the exact future deadline', async () => {
    vi.setSystemTime(new Date('2026-09-09T13:30:00.000Z'));
    stubSingleRead({
      addon_period_triggered: true,
      addon_period_started_at: '2026-09-09T13:00:00.000Z',
      addon_period_ends_at: '2026-09-09T14:05:00.000Z',
      add_on_available: true,
      prize_pool_finalized: false,
      prize_pool: 60,
      status: 'RUNNING',
    });
    const manager = new AddOnRecoveryHarness();
    manager.activate();
    manager.setTriggered(true);
    const arm = vi.fn();
    const scheduleBreak = vi.fn();
    Object.assign(manager, { armAddOnPeriodEndCheck: arm, scheduleAddOnBreak: scheduleBreak });

    await expect(manager.drive()).resolves.toBe('active_rearmed');
    expect(arm).toHaveBeenCalledWith(35 * 60_000);
    expect(scheduleBreak).toHaveBeenCalledWith('2026-09-09T14:05:00.000Z');
  });

  it('returns unproven when an expired window cannot be durably finalized', async () => {
    vi.setSystemTime(new Date('2026-09-09T15:00:00.000Z'));
    stubSingleRead({
      addon_period_triggered: true,
      addon_period_started_at: '2026-09-09T13:00:00.000Z',
      addon_period_ends_at: '2026-09-09T14:05:00.000Z',
      add_on_available: true,
      prize_pool_finalized: false,
      prize_pool: 60,
      status: 'RUNNING',
    });
    const manager = new AddOnRecoveryHarness();
    manager.activate();
    manager.setTriggered(true);
    Object.assign(manager, {
      scheduleAddOnBreak: vi.fn(),
      finalizeAfterAddOn: vi.fn(async () => false),
    });

    await expect(manager.drive()).resolves.toBe('unproven');
  });

  it('returns durably_finalized after the expired close commits', async () => {
    vi.setSystemTime(new Date('2026-09-09T15:00:00.000Z'));
    stubSingleRead({
      addon_period_triggered: true,
      addon_period_started_at: '2026-09-09T13:00:00.000Z',
      addon_period_ends_at: '2026-09-09T14:05:00.000Z',
      add_on_available: true,
      prize_pool_finalized: false,
      prize_pool: 60,
      status: 'RUNNING',
    });
    const manager = new AddOnRecoveryHarness();
    manager.activate();
    manager.setTriggered(true);
    Object.assign(manager, {
      scheduleAddOnBreak: vi.fn(),
      finalizeAfterAddOn: vi.fn(async () => true),
    });

    await expect(manager.drive()).resolves.toBe('durably_finalized');
  });
});
