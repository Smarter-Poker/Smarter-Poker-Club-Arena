import { createHash } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { TournamentManagerBase } from './TournamentManagerBase.js';
import type { GameServer } from '../GameServer.js';
import { supabase } from '../services/supabase.js';
import { setMaintenanceFrozen } from '../maintenance/freezeState.js';
const eventId = '00000000-0000-4000-8000-000000000077';
class Harness extends TournamentManagerBase {
  delays: number[] = [];
  constructor() {
    super(eventId, {} as GameServer);
    (this as any).lifecycleEpoch.begin();
    this.running = true;
    this.addOnPeriodTriggered = true;
    (this as any).addOnBreakActive = true;
    this.tournamentEntryWindowClosed = true;
    this.tournamentCache = {
      add_on_available: true,
      addon_from_start: false,
      addon_period_ends_at: new Date(Date.now() + 60000).toISOString(),
    } as any;
  }
  protected override async broadcast(): Promise<boolean> {
    return true;
  }
  protected override startEliminationChecker(): void {}
  protected override async recalculateEliminatedPrizes(): Promise<boolean> {
    return true;
  }
  async offer() {
    this.eliminationSweepDeadlineAt = Date.now() + 5000;
    this.lastAddOnOfferAt = Date.now();
    await this.tryTournamentAddOns();
    this.scheduleAddOnRetry();
    return Math.max(0, this.lastAddOnOfferAt + TournamentManagerBase.ADD_ON_RETRY_MS - Date.now());
  }
  protected override requestUrgentEliminationSweepAfter(delay: number) {
    this.delays.push(delay);
  }
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  setMaintenanceFrozen(false);
});
function field(count: number, fail?: string) {
  const ids = Array.from(
    { length: count },
    (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`
  );
  const receipts = new Set<string>();
  const calls: string[] = [];
  const load = { inFlight: 0, max: 0 };
  vi.spyOn(supabase, 'from').mockImplementation((table: string) => {
    let batch = ids;
    const c: any = {
      select: () => c,
      eq: () => c,
      // Every fixture player holds chips, so the zero-stack filter keeps them all.
      gt: () => c,
      order: () => c,
      limit: () => c,
      is: () => c,
      in: (_column: string, values: string[]) => {
        if (table === 'profiles') batch = values;
        return c;
      },
      then: (resolve: any) =>
        Promise.resolve({
          error: null,
          data:
            table === 'tournament_players'
              ? ids.map((user_id) => ({ id: user_id, user_id, add_on: receipts.has(user_id) }))
              : table === 'tables'
                ? [{ id: 'table' }]
                : table === 'table_seats'
                  ? ids.map((user_id) => ({ id: user_id, user_id }))
                  : batch.map((id) => ({ id })),
        }).then(resolve),
    };
    return c;
  });
  vi.spyOn(supabase, 'rpc').mockImplementation((async (_name: string, args: any) => {
    const id = args.p_user_id;
    calls.push(id);
    load.inFlight++;
    load.max = Math.max(load.max, load.inFlight);
    await new Promise((resolve) => setTimeout(resolve, 300));
    load.inFlight--;
    if (id === fail) return { data: null, error: { message: 'unknown acknowledgement' } } as any;
    expect(receipts.has(id)).toBe(false);
    receipts.add(id);
    return { data: { success: true }, error: null } as any;
  }) as any);
  const selected = ids.filter(
    (id) =>
      createHash('sha256').update(`${id}|${eventId}|addon-participation`).digest().readUInt32BE(0) %
        1000 <
      740
  );
  return { ids, receipts, calls, selected, load };
}
it('serves a 500-player field in bounded admissions inside sixty seconds', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-23T06:30:00Z'));
  const began = Date.now(),
    f = field(500),
    m = new Harness();
  for (let i = 0; i < 40 && Date.now() < began + 60000; i++) {
    const offered = m.offer();
    await vi.runAllTimersAsync();
    const delay = await offered;
    if (f.receipts.size === f.selected.length) break;
    vi.setSystemTime(Date.now() + delay);
  }
  expect(f.receipts.size).toBe(f.selected.length);
  expect([...f.receipts].sort()).toEqual(f.selected.sort());
  expect(f.calls.length).toBe(f.receipts.size);
  expect(Date.now() - began).toBeLessThan(40000);
  expect(f.load.max).toBe(TournamentManagerBase.ADD_ON_BREAK_CONCURRENCY);
});
it('an ambiguous early player does not starve later identities', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-23T06:30:00Z'));
  const f = field(100, '00000000-0000-4000-8000-000000000000'),
    m = new Harness();
  for (let i = 0; i < 10; i++) {
    const offered = m.offer();
    await vi.runAllTimersAsync();
    await offered;
  }
  expect(f.receipts.size).toBe(f.selected.filter((id) => id !== f.ids[0]).length);
  expect(f.receipts.has(f.ids[0])).toBe(false);
});

it('maintenance stops the next group and waits for all requests already dispatched', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-23T06:30:00Z'));
  const f = field(100),
    m = new Harness();
  const offered = m.offer();
  await vi.advanceTimersByTimeAsync(0);
  expect(f.calls).toHaveLength(TournamentManagerBase.ADD_ON_BREAK_CONCURRENCY);
  setMaintenanceFrozen(true);
  await vi.runAllTimersAsync();
  await offered;
  expect(f.calls).toHaveLength(TournamentManagerBase.ADD_ON_BREAK_CONCURRENCY);
  expect(f.load.inFlight).toBe(0);
  expect(m.delays).not.toContain(0);
});

it('the authoritative entry close starts the FreeBuy closing drain immediately', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-23T06:30:00Z'));
  const m = new Harness();
  Object.assign((m as any).tournamentCache, {
    addon_from_start: true,
    addon_break_minutes: 1,
    addon_period_started_at: '2026-10-23T05:30:00Z',
    addon_period_ends_at: '2026-10-23T06:36:00Z',
  });
  vi.spyOn(supabase, 'rpc').mockResolvedValue({
    data: {
      ok: true,
      entry_closed: true,
      finalization_deferred: true,
      reason: 'addon_required',
    },
    error: null,
  } as any);
  const drain = vi.spyOn(m as any, 'continueFreeBuyClosingDrain').mockResolvedValue(undefined);
  await (m as any).reconcileTournamentEntryWindow('engine.entry_window_deadline');
  expect(drain).toHaveBeenCalledTimes(1);
});
