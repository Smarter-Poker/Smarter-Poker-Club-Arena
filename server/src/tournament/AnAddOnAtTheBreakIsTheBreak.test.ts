/** Owner 2026-10-31: the add-on offer is exactly 60 seconds even within a
 * synchronized break. Closing it never releases that break's own pause. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TournamentManagerBase } from './TournamentManagerBase.js';
import type { GameServer } from '../GameServer.js';
import { supabase } from '../services/supabase.js';
import { setMaintenanceFrozen } from '../maintenance/freezeState.js';

class Harness extends TournamentManagerBase {
  readonly notices: Array<{ event: string; payload: any }> = [];
  constructor(minutes = 1) {
    super('00000000-0000-4000-8000-000000000155', {} as GameServer);
    (this as any).lifecycleEpoch.begin();
    this.running = true;
    this.tournamentEntryWindowClosed = true;
    this.tournamentCache = {
      addon_break_minutes: minutes,
      addon_from_start: false,
      late_reg_mins: 60,
      start_time: new Date().toISOString(),
      addon_cost: 1,
      addon_chips: 10000,
      late_reg_levels: 5,
    } as any;
    (this as any).prizePoolFinalized = false;
    (this as any).requestEliminationSweep = vi.fn();
    (this as any).scheduleAddOnRetry = vi.fn();
    (this as any).scheduleAddOnBreak = vi.fn();
  }
  open() {
    return this.triggerAddOnPeriod();
  }
  onTheBreak(countdownEndsAtMs: number | null) {
    (this as any).onBreak = true;
    (this as any).breakCountdownStarted = countdownEndsAtMs !== null;
    (this as any).synchronizedBreakEndsAtMs = countdownEndsAtMs ?? 0;
  }
  protected override scheduleAddOnPeriodEnd(): void {}
  protected override async broadcast(event: string, payload?: any): Promise<boolean> {
    this.notices.push({ event, payload });
    return true;
  }
  protected override startEliminationChecker(): void {}
  protected override async recalculateEliminatedPrizes(): Promise<boolean> {
    return true;
  }
}

function persistedRow() {
  let saved: any = {
    id: '00000000-0000-4000-8000-000000000155',
    on_break: true,
    break_started_at: new Date().toISOString(),
    break_ends_at: null,
  };
  const writes: any[] = [];
  const chain: any = {
    update: vi.fn((row: any) => {
      writes.push(row);
      saved = {
        ...saved,
        ...row,
        add_on_available: true,
        prize_pool_finalized: false,
        status: 'RUNNING',
      };
      return chain;
    }),
    eq: vi.fn(() => chain),
    in: vi.fn(() => chain),
    is: vi.fn(() => chain),
    select: vi.fn(() => chain),
    maybeSingle: vi.fn(async () => ({ data: saved, error: null })),
  };
  vi.spyOn(supabase, 'from').mockReturnValue(chain);
  return {
    windowWrites: () => writes.filter((w) => 'addon_period_ends_at' in w),
    windowMs: () =>
      Date.parse(saved.addon_period_ends_at) - Date.parse(saved.addon_period_started_at),
    endsAt: () => saved.addon_period_ends_at as string | undefined,
  };
}

const NOW = Date.parse('2026-10-26T03:56:00Z');

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  setMaintenanceFrozen(false);
});

describe('an add-on that comes due during the :55 break is that break', () => {
  it('opens inside a running countdown and closes after 60 seconds while the regular break continues', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const row = persistedRow();
    const m = new Harness(1);
    const breakEnds = Date.parse('2026-10-26T04:00:00Z');
    m.onTheBreak(breakEnds);
    await m.open();
    expect(row.endsAt()).toBe(new Date(NOW + 60_000).toISOString());
    expect(row.windowMs()).toBe(60_000);
    expect(m.notices.find((n) => n.event === 'ADDON_PERIOD_START')?.payload.durationSeconds).toBe(
      60
    );
  });

  it('keeps its full minute when the break ends sooner than that', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const row = persistedRow();
    const m = new Harness(1);
    m.onTheBreak(NOW + 20_000);
    await m.open();
    expect(row.windowMs()).toBe(60_000);
  });

  it('waits out the last hand, then opens when the countdown starts', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const row = persistedRow();
    const m = new Harness(1);
    m.onTheBreak(null);
    await m.open();
    expect(row.windowWrites()).toHaveLength(0);
    expect((m as any).pendingAddOnPeriod).toBe(true);

    (m as any).breakCountdownAnchor = { generation: 0, startedAt: new Date(NOW).toISOString() };
    await m.beginBreakCountdown(TournamentManagerBase.BREAK_DURATION_MS);
    expect((m as any).pendingAddOnPeriod).toBe(false);
    expect(row.windowWrites()).toHaveLength(1);
    expect(row.windowMs()).toBe(60_000);
  });

  it('is one minute when no break is running', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const row = persistedRow();
    const m = new Harness(1);
    await m.open();
    expect(row.windowMs()).toBe(60_000);
  });

  it('never stretches an offer past one real break', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const row = persistedRow();
    const m = new Harness(1);
    m.onTheBreak(
      NOW + TournamentManagerBase.BREAK_DURATION_MS + TournamentManagerBase.LAST_HAND_GRACE_MS + 1
    );
    await m.open();
    expect(row.windowMs()).toBe(60_000);
  });

  it('forgets the break end when the break ends', async () => {
    const m = new Harness(1);
    vi.spyOn(supabase, 'from').mockReturnValue({
      update: () => ({ eq: async () => ({ error: null }) }),
    } as any);
    (m as any).clearPersistedBreak = vi.fn(async () => {});
    m.onTheBreak(Date.now() + 60_000);
    await m.resumeFromBreak();
    expect((m as any).synchronizedBreakEndsAtMs).toBe(0);
    expect((m as any).breakCountdownStarted).toBe(false);
  });
});
