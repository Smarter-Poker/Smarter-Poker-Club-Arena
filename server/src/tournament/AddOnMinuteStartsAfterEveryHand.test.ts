import { afterEach, describe, expect, it, vi } from 'vitest';
import { TournamentManagerBase } from './TournamentManagerBase.js';
import { ServerTableEngine } from '../engine/ServerTableEngine.js';
import type { GameServer } from '../GameServer.js';
import { supabase } from '../services/supabase.js';
import { setMaintenanceFrozen } from '../maintenance/freezeState.js';
class Harness extends TournamentManagerBase {
  notices: string[] = [];
  constructor(fromStart = false) {
    super('00000000-0000-4000-8000-000000000077', {} as GameServer);
    (this as any).lifecycleEpoch.begin();
    this.running = true;
    this.tournamentEntryWindowClosed = true;
    this.tournamentCache = {
      addon_break_minutes: 7,
      addon_from_start: fromStart,
      start_time: new Date().toISOString(),
      late_reg_mins: 1,
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
  close(end: string) {
    return (this as any).beginAddOnBreak(Date.parse(end));
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

describe('FreeBuy final add-on minute', () => {
  it('recovers an old early window by draining every hand before its closing minute', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-23T01:30:00Z'));
    let saved: any = {
      addon_from_start: true,
      add_on_available: true,
      prize_pool_finalized: false,
      status: 'RUNNING',
    };
    const writes: any[] = [];
    const chain: any = {
      update: vi.fn((r: any) => {
        writes.push(r);
        Object.assign(saved, r);
        return chain;
      }),
      eq: () => chain,
      is: () => chain,
      in: () => chain,
      select: () => chain,
      maybeSingle: async () => ({ data: { ...saved }, error: null }),
      then: (resolve: any) => Promise.resolve({ error: null }).then(resolve),
    };
    vi.spyOn(supabase, 'from').mockReturnValue(chain);
    const m = new Harness(true);
    const a = new ServerTableEngine('a');
    const b = new ServerTableEngine('b');
    (a as any).running = true;
    (b as any).running = true;
    m.add('a', a);
    m.add('b', b);
    // This already-open legacy window may exist across deployment; new
    // windows cannot be opened at seating anymore.
    Object.assign(saved, {
      addon_period_triggered: true,
      addon_period_started_at: '2026-10-23T01:30:00.000Z',
      addon_period_ends_at: '2026-10-23T01:32:00.000Z',
    });
    Object.assign((m as any).tournamentCache, saved);
    (m as any).addOnPeriodTriggered = true;
    vi.setSystemTime(new Date('2026-10-23T01:31:00Z'));
    await m.close(saved.addon_period_ends_at);
    expect(saved.addon_period_started_at).toBeNull();
    expect(saved.addon_period_ends_at).toBeNull();
    expect((m as any).isFreeBuyClosingDrain(saved)).toBe(true);
    expect(m.pending()).toBe(true);
    const parkedA = (a as any).awaitPauseGate();
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(saved.addon_period_ends_at).toBeNull();
    vi.setSystemTime(new Date('2026-10-23T01:32:10Z'));
    const parkedB = (b as any).awaitPauseGate();
    for (let i = 0; i < 40; i++) await Promise.resolve();
    expect(saved.addon_period_started_at).toBe('2026-10-23T01:32:10.000Z');
    expect(saved.addon_period_ends_at).toBe('2026-10-23T01:33:10.000Z');
    expect(m.pending()).toBe(false);
    expect(a.isParkedBetweenHands()).toBe(true);
    expect(b.isParkedBetweenHands()).toBe(true);
    expect(m.notices.filter((n) => n === 'ADDON_PERIOD_START')).toHaveLength(1);
    const count = writes.length;
    await m.close(saved.addon_period_ends_at);
    expect(writes).toHaveLength(count);
    (a as any).running = false;
    (b as any).running = false;
    a.resumeDealing();
    b.resumeDealing();
    await Promise.all([parkedA, parkedB]);
  });
});

describe('a recovered FreeBuy closing drain', () => {
  it('inherits the durable hold, recovers a lost open reply, and never renews the committed minute', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-23T02:00:00Z'));
    const marker: any = {
      addon_from_start: true,
      addon_period_triggered: true,
      addon_period_started_at: null,
      addon_period_ends_at: null,
      add_on_available: true,
      prize_pool_finalized: false,
      status: 'RUNNING',
    };
    let reads = 0;
    const chain: any = {
      update: vi.fn((r: any) => {
        Object.assign(marker, r);
        return chain;
      }),
      eq: () => chain,
      is: () => chain,
      select: () => chain,
      maybeSingle: async () => ({ data: { ...marker }, error: null }),
      then: (resolve: any) =>
        Promise.resolve({ error: { message: 'lost response' } }).then(resolve),
    };
    vi.spyOn(supabase, 'from').mockImplementation(() => {
      reads++;
      return chain;
    });
    const m = new Harness(true);
    Object.assign((m as any).tournamentCache, marker);
    (m as any).addOnPeriodTriggered = true;
    (m as any).addOnDrainPending = (m as any).isFreeBuyClosingDrain(marker);
    const e = new ServerTableEngine('recovered');
    (e as any).running = true;
    (m as any).prepareManagedTableEngineForPlay(e);
    expect(e.requiresExplicitPauseResume()).toBe(true);
    m.add('recovered', e);
    (m as any).lifecycleOperation = Promise.resolve();
    const parked = (e as any).awaitPauseGate();
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(chain.update).not.toHaveBeenCalled();
    expect(marker.addon_period_ends_at).toBeNull();
    // The real resume continuation reaches this only after ALL dealers and
    // synchronized-break authorities have been reconstructed.
    await (m as any).continueFreeBuyClosingDrain(true);
    (m as any).lifecycleOperation = null;
    for (let i = 0; i < 40; i++) await Promise.resolve();
    expect(marker.addon_period_started_at).toBe('2026-10-23T02:00:00.000Z');
    expect(marker.addon_period_ends_at).toBe('2026-10-23T02:01:00.000Z');
    expect(chain.update).toHaveBeenCalledTimes(1);
    expect(reads).toBeGreaterThanOrEqual(3);
    vi.setSystemTime(new Date('2026-10-23T02:00:15Z'));
    await m.close(marker.addon_period_ends_at);
    expect(marker.addon_period_ends_at).toBe('2026-10-23T02:01:00.000Z');
    expect(chain.update).toHaveBeenCalledTimes(1);
    (e as any).running = false;
    e.resumeDealing();
    await parked;
  });
});
