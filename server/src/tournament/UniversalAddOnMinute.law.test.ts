import { afterEach, describe, expect, it, vi } from 'vitest';
import { TournamentManagerBase } from './TournamentManagerBase.js';
import type { GameServer } from '../GameServer.js';
import { supabase } from '../services/supabase.js';
import { setMaintenanceFrozen } from '../maintenance/freezeState.js';

class Harness extends TournamentManagerBase {
  readonly notices: Array<{ event: string; payload: any }> = [];
  constructor(minutes: number, early = false) {
    super('00000000-0000-4000-8000-000000000077', {} as GameServer);
    (this as any).lifecycleEpoch.begin();
    this.running = true;
    this.tournamentEntryWindowClosed = true;
    this.tournamentCache = {
      addon_break_minutes: minutes,
      addon_from_start: early,
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

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  setMaintenanceFrozen(false);
});

describe('the real manager enforces the universal 60-second add-on break', () => {
  it.each([1, 5, 10])('uses 60 seconds despite a legacy %s-minute setting', async (minutes) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-25T12:00:00Z'));
    setMaintenanceFrozen(false);
    let saved: any;
    const chain: any = {
      update: vi.fn((row: any) => {
        saved = { ...row, add_on_available: true, prize_pool_finalized: false, status: 'RUNNING' };
        return chain;
      }),
      eq: vi.fn(() => chain),
      in: vi.fn(() => chain),
      select: vi.fn(() => chain),
      maybeSingle: vi.fn(async () => ({ data: saved, error: null })),
    };
    vi.spyOn(supabase, 'from').mockReturnValue(chain);
    const m = new Harness(minutes);
    await m.open();
    expect(Date.parse(saved.addon_period_ends_at) - Date.parse(saved.addon_period_started_at)).toBe(
      60000
    );
    expect(m.notices.find((n) => n.event === 'ADDON_PERIOD_START')?.payload.durationSeconds).toBe(
      60
    );
    const end = saved.addon_period_ends_at;
    await m.open();
    expect(chain.update).toHaveBeenCalledTimes(1);
    expect(saved.addon_period_ends_at).toBe(end);
  });

  it('cannot open before the committed entry boundary, even with a legacy early flag', async () => {
    const from = vi.spyOn(supabase, 'from');
    const m = new Harness(1, true);
    (m as any).tournamentEntryWindowClosed = false;
    await m.open();
    expect(from).not.toHaveBeenCalled();
    expect(m.notices).toHaveLength(0);
  });

  it('gives legacy Free Buy settings only the same closing minute', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-25T12:00:00Z'));
    setMaintenanceFrozen(false);
    let saved: any;
    const chain: any = {
      update: vi.fn((row: any) => {
        saved = { ...row, add_on_available: true, prize_pool_finalized: false, status: 'RUNNING' };
        return chain;
      }),
      eq: vi.fn(() => chain),
      in: vi.fn(() => chain),
      select: vi.fn(() => chain),
      maybeSingle: vi.fn(async () => ({ data: saved, error: null })),
    };
    vi.spyOn(supabase, 'from').mockReturnValue(chain);
    await new Harness(5, true).open();
    expect(Date.parse(saved.addon_period_ends_at) - Date.parse(saved.addon_period_started_at)).toBe(
      60000
    );
  });
});
