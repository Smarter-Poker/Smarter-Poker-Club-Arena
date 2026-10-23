import { afterEach, describe, expect, it, vi } from 'vitest';
import { TournamentManagerBase } from './TournamentManagerBase.js';
import { ServerTableEngine } from '../engine/ServerTableEngine.js';
import type { GameServer } from '../GameServer.js';
import { supabase } from '../services/supabase.js';
import { setMaintenanceFrozen } from '../maintenance/freezeState.js';
class Harness extends TournamentManagerBase {
  notices: string[] = [];
  constructor() {
    super('00000000-0000-4000-8000-000000000077', {} as GameServer);
    (this as any).lifecycleEpoch.begin();
    this.running = true;
    this.tournamentCache = {
      addon_break_minutes: 1,
      addon_from_start: false,
      addon_cost: 35,
      addon_chips: 30000,
      late_reg_levels: 9,
    } as any;
    (this as any).requestEliminationSweep = vi.fn();
    (this as any).scheduleAddOnRetry = vi.fn();
    (this as any).advanceHandForHandBarrier = vi.fn();
  }
  add(id: string, e: ServerTableEngine) {
    this.tableEngines.set(id, e);
    this.wireEliminationWake(e);
  }
  open() {
    return this.triggerAddOnPeriod();
  }
  pending() {
    return (this as any).addOnDrainPending;
  }
  protected override scheduleAddOnPeriodEnd(): void {}
  protected override suspendLevelClock(): void {}
  protected override startBlindTimer(): void {}
  protected override async broadcast(event: string): Promise<boolean> {
    this.notices.push(event);
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
describe('the paid add-on minute starts after every current hand', () => {
  it('waits on the actual dealer park edge then grants the full 60 seconds', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-23T01:30:00Z'));
    setMaintenanceFrozen(false);
    let saved: any;
    const chain: any = {
      update: vi.fn((r: any) => {
        saved = { ...r, add_on_available: true, prize_pool_finalized: false, status: 'RUNNING' };
        return chain;
      }),
      eq: () => chain,
      in: () => chain,
      select: () => chain,
      maybeSingle: async () => ({ data: saved, error: null }),
    };
    vi.spyOn(supabase, 'from').mockReturnValue(chain);
    const m = new Harness();
    const a = new ServerTableEngine('a');
    const b = new ServerTableEngine('b');
    (a as any).running = true;
    (b as any).running = true;
    m.add('a', a);
    m.add('b', b);
    await m.open();
    expect(m.pending()).toBe(true);
    expect(chain.update).not.toHaveBeenCalled();
    expect(a.requiresExplicitPauseResume()).toBe(true);
    expect(b.requiresExplicitPauseResume()).toBe(true);
    const parkedA = (a as any).awaitPauseGate();
    await Promise.resolve();
    expect(chain.update).not.toHaveBeenCalled();
    expect(m.pending()).toBe(true);
    vi.setSystemTime(new Date('2026-10-23T01:31:10Z'));
    const parkedB = (b as any).awaitPauseGate();
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(chain.update).toHaveBeenCalledTimes(1);
    expect(saved.addon_period_started_at).toBe('2026-10-23T01:31:10.000Z');
    expect(Date.parse(saved.addon_period_ends_at) - Date.parse(saved.addon_period_started_at)).toBe(
      60000
    );
    expect(m.notices).toContain('ADDON_PERIOD_START');
    expect(m.pending()).toBe(false);
    expect(a.isParkedBetweenHands()).toBe(true);
    expect(b.isParkedBetweenHands()).toBe(true);
    expect((a as any).dealHoldUntilMs).toBe(Date.parse(saved.addon_period_ends_at));
    (a as any).running = false;
    (b as any).running = false;
    a.resumeDealing();
    b.resumeDealing();
    await Promise.all([parkedA, parkedB]);
  });
});
