/**
 * The add-on break serves the whole field (2026-10-26).
 *
 * Measured on the first 60-second break after every funded horse was told to
 * add on: Sunrise Bounty, 104 of 186 seated horses bought before the deadline,
 * every reply a success. Twelve purchases at a time, four in flight, then a
 * ~4.5 s wait for the next admission. While the break holds the tables, the
 * remaining field is offered in one pass through a bounded pool instead.
 */
import { afterEach, expect, it, vi } from 'vitest';
import { TournamentManagerBase } from './TournamentManagerBase.js';
import type { GameServer } from '../GameServer.js';
import { supabase } from '../services/supabase.js';
import { setMaintenanceFrozen } from '../maintenance/freezeState.js';

const eventId = '00000000-0000-4000-8000-000000000188';

class Harness extends TournamentManagerBase {
  constructor(windowMs: number, held: 'addon_break' | 'synchronized_break' | 'none') {
    super(eventId, {} as GameServer);
    (this as any).lifecycleEpoch.begin();
    this.running = true;
    this.addOnPeriodTriggered = true;
    (this as any).addOnBreakActive = held === 'addon_break';
    (this as any).onBreak = held === 'synchronized_break';
    this.tournamentCache = {
      add_on_available: true,
      addon_from_start: false,
      addon_break_minutes: 1,
      addon_period_ends_at: new Date(Date.now() + windowMs).toISOString(),
    } as any;
  }
  protected override async broadcast(): Promise<boolean> {
    return true;
  }
  protected override startEliminationChecker(): void {}
  protected override async recalculateEliminatedPrizes(): Promise<boolean> {
    return true;
  }
  protected override requestUrgentEliminationSweepAfter(): void {}
  async offer() {
    // The ordinary five-second admission budget: the held-field pass must not
    // be cut short by it.
    this.eliminationSweepDeadlineAt = Date.now() + 5000;
    await this.tryTournamentAddOns();
    return this.lastAddOnOfferPass;
  }
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  setMaintenanceFrozen(false);
});

function field(count: number, rpcMs = 300) {
  const ids = Array.from(
    { length: count },
    (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`
  );
  const receipts = new Set<string>();
  const load = { inFlight: 0, max: 0, calls: 0 };
  vi.spyOn(supabase, 'from').mockImplementation((table: string) => {
    let batch = ids;
    const c: any = {
      select: () => c,
      eq: () => c,
      gt: () => c,
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
              ? ids.map((user_id) => ({ user_id, add_on: receipts.has(user_id) }))
              : table === 'tables'
                ? [{ id: 'table' }]
                : table === 'table_seats'
                  ? ids.map((user_id) => ({ user_id }))
                  : batch.map((id) => ({ id })),
        }).then(resolve),
    };
    return c;
  });
  vi.spyOn(supabase, 'rpc').mockImplementation((async (_name: string, args: any) => {
    load.calls++;
    load.inFlight++;
    load.max = Math.max(load.max, load.inFlight);
    await new Promise((resolve) => setTimeout(resolve, rpcMs));
    load.inFlight--;
    expect(receipts.has(args.p_user_id)).toBe(false);
    receipts.add(args.p_user_id);
    return { data: { success: true }, error: null } as any;
  }) as any);
  return { ids, receipts, load };
}

it('offers a 186-horse field in one pass inside the 60-second add-on break', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-26T13:48:55Z'));
  const began = Date.now();
  const f = field(186);
  const m = new Harness(60_000, 'addon_break');
  const pass = m.offer();
  await vi.runAllTimersAsync();
  const result = await pass;
  expect(f.receipts.size).toBe(186);
  expect(f.load.calls).toBe(186);
  expect(f.load.max).toBe(TournamentManagerBase.ADD_ON_BREAK_CONCURRENCY);
  expect(Date.now() - began).toBeLessThan(10_000);
  expect(result).toEqual({ offered: 186, more: false });
});

it('serves the field the same way inside a :55 break the add-on opened in', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-26T13:56:00Z'));
  const f = field(120);
  const m = new Harness(240_000, 'synchronized_break');
  const pass = m.offer();
  await vi.runAllTimersAsync();
  await pass;
  expect(f.receipts.size).toBe(120);
});

it('stops at the persisted deadline and keeps the rest pending', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-26T13:48:55Z'));
  const f = field(400);
  const m = new Harness(3_000, 'addon_break');
  const pass = m.offer();
  await vi.runAllTimersAsync();
  const result = await pass;
  expect(f.receipts.size).toBeGreaterThan(0);
  expect(f.receipts.size).toBeLessThan(400);
  // Requests already in flight at the deadline finish; no new one starts.
  expect(f.load.calls).toBeLessThanOrEqual(
    Math.ceil(3_000 / 300) * TournamentManagerBase.ADD_ON_BREAK_CONCURRENCY
  );
  expect(result.more).toBe(true);
});

it('hands a very large field to the next admission after one bounded pass', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-26T13:48:55Z'));
  const f = field(1000, 400);
  const m = new Harness(600_000, 'addon_break');
  const began = Date.now();
  const first = m.offer();
  await vi.runAllTimersAsync();
  const result = await first;
  expect(Date.now() - began).toBeLessThan(TournamentManagerBase.ADD_ON_BREAK_PASS_MS + 1_000);
  expect(result.more).toBe(true);
  // 20 s at eight in flight and 400 ms each is 400 purchases a pass.
  expect(f.receipts.size).toBe(400);
  for (let i = 0; i < 2; i++) {
    const next = m.offer();
    await vi.runAllTimersAsync();
    await next;
  }
  expect(f.receipts.size).toBe(1000);
  expect(f.load.calls).toBe(1000);
});

it('keeps the ordinary bounded batch while play is running', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-26T13:30:00Z'));
  const f = field(100);
  const m = new Harness(600_000, 'none');
  const pass = m.offer();
  await vi.runAllTimersAsync();
  await pass;
  expect(f.load.max).toBe(4);
  expect(f.receipts.size).toBe(TournamentManagerBase.SWEEP_MUTATION_BATCH_SIZE);
});

it('the freeze stops the pool before its next request', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-26T13:48:55Z'));
  const f = field(100);
  const m = new Harness(60_000, 'addon_break');
  const pass = m.offer();
  await vi.advanceTimersByTimeAsync(0);
  expect(f.load.calls).toBe(TournamentManagerBase.ADD_ON_BREAK_CONCURRENCY);
  setMaintenanceFrozen(true);
  await vi.runAllTimersAsync();
  await pass;
  expect(f.load.calls).toBe(TournamentManagerBase.ADD_ON_BREAK_CONCURRENCY);
});
