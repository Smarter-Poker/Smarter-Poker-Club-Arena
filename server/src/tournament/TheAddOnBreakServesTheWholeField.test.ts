/**
 * The add-on break serves the whole field (2026-10-26).
 *
 * Measured on the first 60-second break after every funded horse was told to
 * add on: Sunrise Bounty, 104 of 186 seated horses bought before the deadline,
 * every reply a success. Twelve purchases at a time, four in flight, then a
 * ~4.5 s wait for the next admission. While the break holds the tables, the
 * remaining field is offered in one pass through a bounded pool instead.
 */
import { createHash } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { TournamentManagerBase } from './TournamentManagerBase.js';
import { ELIMINATION_SWEEP_STUCK_MS } from './eliminationLock.js';
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
  stopForTest() {
    this.running = false;
  }
  abortForTest() {
    const controller = new AbortController();
    controller.abort();
    this.eliminationSweepSignal = controller.signal;
  }
  async offer(budgetMs = 5000) {
    // The ordinary five-second admission budget: the held-field pass must not
    // be cut short by it.
    this.eliminationSweepDeadlineAt = Date.now() + budgetMs;
    await this.tryTournamentAddOns();
    return this.lastAddOnOfferPass;
  }
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  setMaintenanceFrozen(false);
});

function selected(id: string): boolean {
  return (
    createHash('sha256').update(`${id}|${eventId}|addon-participation`).digest().readUInt32BE(0) %
      1000 <
    740
  );
}

function field(
  count: number,
  rpcMs = 300,
  readMs = 0,
  serialized = false,
  selectedOnly = true,
  failPage?: string
) {
  // Keep the original throughput load: count means this many willing horses,
  // independent of the participation rate. The mixed-field test covers declines.
  const ids: string[] = [];
  for (let i = 0; ids.length < count; i++) {
    const id = `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
    if (!selectedOnly || selected(id)) ids.push(id);
  }
  const receipts = new Set<string>();
  const load = { inFlight: 0, max: 0, calls: 0, reads: 0 };
  let databaseTail = Promise.resolve();
  vi.spyOn(supabase, 'from').mockImplementation((table: string) => {
    let batch = ids;
    let cursor: string | null = null;
    let pageSize = 1000;
    const tableIds = Array.from(
      { length: Math.ceil(ids.length / 9) },
      (_, i) => `table-${String(i).padStart(6, '0')}`
    );
    let selectedTables = tableIds;
    const c: any = {
      select: () => c,
      eq: () => c,
      order: () => c,
      limit: (value: number) => {
        pageSize = value;
        return c;
      },
      gt: (column: string, value: string) => {
        if (column === 'id') cursor = value;
        return c;
      },
      is: () => c,
      in: (_column: string, values: string[]) => {
        if (table === 'profiles') batch = values;
        if (table === 'table_seats') selectedTables = values;
        return c;
      },
      then: async (resolve: any) => {
        load.reads++;
        if (cursor && table === failPage)
          return resolve({ data: null, error: { message: 'later page unavailable' } });
        if (readMs) await new Promise((done) => setTimeout(done, readMs));
        const rows =
          table === 'tournament_players'
            ? ids.map((user_id) => ({ id: user_id, user_id, add_on: receipts.has(user_id) }))
            : table === 'tables'
              ? tableIds.map((id) => ({ id }))
              : table === 'table_seats'
                ? ids
                    .filter((_, i) => selectedTables.includes(tableIds[Math.floor(i / 9)]))
                    .map((user_id) => ({ id: user_id, user_id }))
                : batch.map((id) => ({ id }));
        return Promise.resolve({
          error: null,
          data: rows
            .filter((row) => cursor === null || row.id > cursor)
            .sort((a, b) => a.id.localeCompare(b.id))
            .slice(0, Math.min(pageSize, 1000)),
        }).then(resolve);
      },
    };
    return c;
  });
  vi.spyOn(supabase, 'rpc').mockImplementation((async (_name: string, args: any) => {
    load.calls++;
    load.inFlight++;
    load.max = Math.max(load.max, load.inFlight);
    const purchase = () => new Promise<void>((resolve) => setTimeout(resolve, rpcMs));
    if (serialized) {
      databaseTail = databaseTail.then(purchase);
      await databaseTail;
    } else await purchase();
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

it('caps a captured large-field operation at the existing sweep lifetime', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-26T13:48:55Z'));
  const f = field(2400, 400);
  const m = new Harness(600_000, 'addon_break');
  const began = Date.now();
  const first = m.offer();
  await vi.runAllTimersAsync();
  const result = await first;
  expect(Date.now() - began).toBeLessThan(ELIMINATION_SWEEP_STUCK_MS + 1_000);
  expect(result.more).toBe(true);
  // 60 s at eight in flight and 400 ms each is 1,200 purchases.
  expect(f.receipts.size).toBe(1200);
  for (let i = 0; i < 1; i++) {
    const next = m.offer();
    await vi.runAllTimersAsync();
    await next;
  }
  expect(f.receipts.size).toBe(2400);
  expect(f.load.calls).toBe(2400);
});

it('refuses every purchase while play is running', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-26T13:30:00Z'));
  const f = field(100);
  const m = new Harness(600_000, 'none');
  const pass = m.offer();
  await vi.runAllTimersAsync();
  await pass;
  expect(f.load.max).toBe(0);
  expect(f.receipts.size).toBe(0);
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

it('serves a held field when eligibility reads outlast the ordinary work budget', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-26T13:48:55Z'));
  const f = field(186, 300, 1_600);
  const m = new Harness(60_000, 'addon_break');
  const pass = m.offer();
  await vi.runAllTimersAsync();
  await pass;
  expect(f.receipts.size).toBe(186);
  expect(f.load.calls).toBe(186);
});

it.each(['stop', 'abort', 'freeze', 'offer_deadline', 'pass_deadline'] as const)(
  'never starts purchases when %s ends a slow held-field snapshot',
  async (reason) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-26T13:48:55Z'));
    const f = field(186, 300, reason === 'pass_deadline' ? 6_000 : 1_600);
    const m = new Harness(reason === 'offer_deadline' ? 3_000 : 60_000, 'addon_break');
    if (reason === 'stop') setTimeout(() => m.stopForTest(), 3_000);
    if (reason === 'abort') setTimeout(() => m.abortForTest(), 3_000);
    if (reason === 'freeze') setTimeout(() => setMaintenanceFrozen(true), 3_000);
    const pass = m.offer();
    await vi.runAllTimersAsync();
    await pass;
    expect(f.load.calls).toBe(0);
    expect(f.receipts.size).toBe(0);
  }
);

it('serves a held field even if its ordinary budget was already spent', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-26T13:48:55Z'));
  const f = field(186);
  const m = new Harness(60_000, 'addon_break');
  const pass = m.offer(-1);
  await vi.runAllTimersAsync();
  await pass;
  expect(f.receipts.size).toBe(186);
});

it('still yields slow eligibility reads while the field is playing', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-26T13:48:55Z'));
  const f = field(186, 300, 1_600);
  const m = new Harness(60_000, 'none');
  const pass = m.offer();
  await vi.runAllTimersAsync();
  await pass;
  expect(f.load.calls).toBe(0);
});

it('keeps 124 serialized canonical purchases on the captured owner until complete', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-27T02:30:42.886Z'));
  const f = field(124, 250, 800, true);
  const m = new Harness(60_000, 'addon_break');
  const began = Date.now();
  const pass = m.offer();
  await vi.runAllTimersAsync();
  const result = await pass;
  expect(f.receipts.size).toBe(124);
  expect(f.load.calls).toBe(124);
  expect(f.load.reads).toBe(4);
  expect(f.load.max).toBe(8);
  expect(result).toEqual({ offered: 124, more: false });
  expect(Date.now() - began).toBeLessThan(60_000);
});

it.each(['stop', 'abort', 'freeze'] as const)(
  '%s still ends a captured purchase pool after the preparation budget',
  async (reason) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-27T02:30:42.886Z'));
    const f = field(124, 250, 800, true);
    const m = new Harness(60_000, 'addon_break');
    setTimeout(() => {
      if (reason === 'stop') m.stopForTest();
      if (reason === 'abort') m.abortForTest();
      if (reason === 'freeze') setMaintenanceFrozen(true);
    }, 22_000);
    const pass = m.offer();
    await vi.runAllTimersAsync();
    await pass;
    expect(f.load.calls).toBeGreaterThan(0);
    expect(f.load.calls).toBeLessThan(124);
    expect(f.load.reads).toBe(4);
  }
);

it('reuses an ambiguous purchase identity without duplicating its committed receipt', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-27T02:30:42.886Z'));
  const f = field(1);
  const m = new Harness(60_000, 'addon_break');
  const rpc = vi.mocked(supabase.rpc);
  let committed = false;
  const keys: string[] = [];
  rpc.mockImplementation((async (_name: string, args: any) => {
    keys.push(`${args.p_tournament_id}:${args.p_rebuy_type}:${args.p_user_id}`);
    if (!committed) {
      committed = true;
      throw new Error('reply lost after commit');
    }
    return { data: { success: true, idempotent: true }, error: null } as any;
  }) as any);
  const first = m.offer();
  await vi.runAllTimersAsync();
  expect(await first).toEqual({ offered: 0, more: true });
  const second = m.offer();
  await vi.runAllTimersAsync();
  expect(await second).toEqual({ offered: 1, more: false });
  expect(keys).toHaveLength(2);
  expect(new Set(keys).size).toBe(1);
  expect(f.load.reads).toBe(8);
});

it('only purchases the selected 74% cohort and never rerolls the rest on another offer', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-27T02:30:42.886Z'));
  const f = field(500, 10, 0, false, false);
  const expected = f.ids.filter(selected).sort();
  expect(expected.length).toBeGreaterThan(350);
  expect(expected.length).toBeLessThan(390);
  const m = new Harness(60_000, 'addon_break');
  for (let offer = 0; offer < 2; offer++) {
    const pass = m.offer();
    await vi.runAllTimersAsync();
    await pass;
    expect([...f.receipts].sort()).toEqual(expected);
    expect(f.load.calls).toBe(expected.length);
  }
});

it.each([1000, 1001, 1801, 9001])(
  'offers all %s willing players across roster, table and seat pages',
  async (count) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-26T13:48:55Z'));
    const f = field(count, 0);
    const m = new Harness(60_000, 'addon_break');
    const pending = m.offer();
    await vi.runAllTimersAsync();
    const result = await pending;
    expect(f.receipts.size).toBe(count);
    expect(f.load.calls).toBe(count);
    expect([...f.receipts].sort()).toEqual(f.ids.slice().sort());
    expect(result).toEqual({ offered: count, more: false });
  }
);

it.each(['tournament_players', 'tables', 'table_seats'])(
  'does not buy from an incomplete %s snapshot',
  async (table) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-26T13:48:55Z'));
    const f = field(table === 'tables' ? 9001 : 1801, 0, 0, false, true, table);
    const m = new Harness(60_000, 'addon_break');
    const pending = m.offer();
    await vi.runAllTimersAsync();
    await pending;
    expect(f.load.calls).toBe(0);
    expect(f.receipts.size).toBe(0);
  }
);
