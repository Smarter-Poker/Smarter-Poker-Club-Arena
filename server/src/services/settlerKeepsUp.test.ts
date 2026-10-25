/**
 * THE SETTLER KEEPS UP WITH ONE HOST CLUB (2026-10-25).
 *
 * Measured 2026-10-24 21:00-23:00 UTC with one host club (Midway): the single
 * lane accrued ~7,000 first attempts an hour against 13-15k cash hands
 * arriving. 60% of its busy time was two sequential readback round trips per
 * refusal, a batch of 5 was sized for a per-item cost that had halved, and a
 * retry queue of 61,354 permanently refused sources took the first 30 s of
 * every run. This suite pins the four changes, each against a mocked RPC:
 *   1. a lane's chunks are dealt in order to two workers that run side by
 *      side, never the same record twice, and the cursor waits for both;
 *   2. every refusal of a call is read back with one query per table (not two
 *      per refusal), off the submit path, and the page still halts when any
 *      readback is missing or wrong;
 *   3. a retry drain continues only while it ACCRUES, and a drain that only
 *      re-refused rests for retryRestMs before the queue is asked again;
 *   4. the batch follows the re-measured per-item cost (10 at 150 ms).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { pacificAccountingWeek } from './pacificAccountingWeek.js';

type Ops = Array<[string, unknown[]]>;
const { mockRpc, upserts, page, reads, readOverride } = vi.hoisted(() => ({
  mockRpc: vi.fn(),
  upserts: [] as Array<Record<string, unknown>>,
  page: { rows: [] as Array<Record<string, unknown>> },
  reads: [] as Array<{ table: string; ops: Ops }>,
  readOverride: { current: null as null | ((table: string, ids: string[]) => unknown) },
}));
const durable = new Map<string, Record<string, unknown>>();
/** The durable rows the database would return for `ids` of `table`. */
function durableRows(table: string, ids: string[]): Array<Record<string, unknown>> {
  return ids.flatMap((id): Array<Record<string, unknown>> => {
    const r = [...durable.values()].find((x) =>
      table.endsWith('_receipts') ? x.receipt_id === id : x.rake_record_id === id
    );
    if (!r) return [];
    return table.endsWith('_receipts')
      ? [{ ...r, id: r.receipt_id, result: r }]
      : [
          {
            rake_record_id: r.rake_record_id,
            receipt_id: r.receipt_id,
            status: r.status,
            attempts: r.attempt,
          },
        ];
  });
}

vi.mock('./supabase.js', () => {
  const from = (table: string) => {
    const ops: Ops = [];
    const chain: unknown = new Proxy(
      {},
      {
        get(_t, prop) {
          if (prop === 'then')
            return (resolve: (v: unknown) => unknown) => {
              if (table === 'daemon_state' && ops.some(([n]) => n === 'upsert')) {
                upserts.push(ops.find(([n]) => n === 'upsert')![1][0] as Record<string, unknown>);
                return resolve({ data: null, error: null });
              }
              if (table === 'daemon_state')
                return resolve({
                  data: {
                    high_water_mark: '2026-10-24 20:00:00.000000+00',
                    high_water_mark_id: ZERO,
                  },
                  error: null,
                });
              if (table === 'rake_records') {
                const tie = ops.some(([n, a]) => n === 'eq' && a[0] === 'created_at');
                return resolve({ data: tie ? [] : page.rows, error: null });
              }
              if (
                table === 'accounting_cash_source_receipts' ||
                table === 'accounting_cash_source_work'
              ) {
                reads.push({ table, ops: [...ops] });
                const ids = (ops.find(([n]) => n === 'in')?.[1][1] ?? []) as string[];
                if (readOverride.current) return resolve(readOverride.current(table, ids));
                const rows = durableRows(table, ids);
                return resolve({ data: rows, error: null });
              }
              return resolve({ data: null, error: null });
            };
          return (...args: unknown[]) => {
            ops.push([String(prop), args]);
            return chain;
          };
        },
      }
    );
    return chain;
  };
  return { supabase: { from, rpc: (...a: unknown[]) => mockRpc(...a) } };
});
vi.mock('./errorReporter.js', () => ({ reportError: vi.fn(), reportWarning: vi.fn() }));

const ZERO = '00000000-0000-4000-8000-000000000000';
const {
  RakebackSettlerService,
  laneWorkers,
  CASH_WORKERS_PER_LANE,
  CREDIT_BATCH_SIZE,
  CASH_RETRY_LIMIT,
  retryRestMs,
  CASH_RETRY_REST_BASE_MS,
  CASH_RETRY_REST_MAX_MS,
  confirmCashSourceRefusals,
} = await import('./RakebackSettlerService.js');
const { cashAccountingBatchSize, PER_ITEM_MS, COMMISSION_KEY_HOLD_MS } =
  await import('./cashAccountingBatchBudget.js');

const uid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const HOST = 'fade0000-0000-0000-0000-000000000001';
const at = (n: number) =>
  `2026-10-24 20:00:${String(n % 60).padStart(2, '0')}.${String(n).padStart(6, '0')}+00`;
const week = pacificAccountingWeek(at(1));
const source = (n: number) => ({
  id: uid(n),
  created_at: at(n),
  club_id: HOST,
  hand_id: uid(n + 50_000),
  rake_amount: 1,
  is_tournament: false,
  player_contributions: {},
});
const receiptFor = (id: string, status: 'accrued' | 'blocked', attempt = 1) => {
  const row = page.rows.find((r) => r.id === id);
  return {
    receipt_version: 3,
    recorded: true,
    receipt_id: uid(Number(id.slice(-6)) + 900_000 + attempt * 10_000),
    rake_record_id: id,
    hand_id: null,
    earned_at: String(row?.created_at ?? at(1)),
    attempt,
    source_fingerprint: 'a'.repeat(32),
    status,
    reason: status === 'blocked' ? 'accounting_terms_not_observed' : null,
    credits:
      status === 'accrued'
        ? [
            {
              player_id: uid(42),
              club_id: HOST,
              rake_credit: 1,
              period_start: week.periodStart,
              period_end: week.periodEnd,
            },
          ]
        : [],
  };
};
const batch = (receipts: Array<Record<string, unknown>>) => {
  for (const r of receipts) durable.set(String(r.receipt_id), r);
  const ok = receipts.filter((r) => r.status === 'accrued').length;
  return {
    data: {
      receipt_version: 3,
      ok,
      failed: receipts.length - ok,
      blocked: receipts.length - ok,
      receipts,
    },
    error: null,
  };
};
const run = (settler = new RakebackSettlerService()) =>
  (settler as unknown as { _runSettlementInner(): Promise<string> })._runSettlementInner();
const creditCalls = () =>
  mockRpc.mock.calls.filter(([name]) => name === 'fn_credit_agent_commissions_batch');
const retryCalls = () =>
  mockRpc.mock.calls.filter(([name]) => name === 'fn_retry_cash_accounting_sources');

let retryAnswer: (args: { p_limit: number }) => unknown;
let creditAnswer: (ids: string[]) => Promise<unknown> | unknown;
beforeEach(() => {
  upserts.length = 0;
  reads.length = 0;
  durable.clear();
  readOverride.current = null;
  page.rows = [];
  retryAnswer = () => batch([]);
  creditAnswer = (ids) => batch(ids.map((id) => receiptFor(id, 'accrued')));
  mockRpc.mockReset();
  mockRpc.mockImplementation(async (name: string, args: Record<string, any>) => {
    if (name === 'fn_retry_cash_accounting_sources')
      return retryAnswer(args as { p_limit: number });
    if (name === 'fn_rakeback_settler_read_horizon')
      return { data: { horizon: '2999-12-31 00:00:00.000000+00' }, error: null };
    if (name === 'fn_credit_agent_commissions_batch')
      return creditAnswer(args.p_items.map((i: any) => i.source_id));
    if (name === 'fn_rakeback_recompute_periods')
      return {
        data: {
          written: 1,
          accounting_version: 2,
          confirmed_players: args.p_user_ids.length,
          status: 'ready',
          club_id: args.p_club_id,
          period_start: args.p_period_start,
          period_end: args.p_period_end,
        },
        error: null,
      };
    throw new Error(`unexpected rpc ${name}`);
  });
});

describe('the batch follows the re-measured per-item cost', () => {
  it('is 10 at 150 ms per item, inside the commission-key hold and the client budget', () => {
    expect(PER_ITEM_MS).toBe(150);
    expect(CREDIT_BATCH_SIZE).toBe(10);
    expect(CASH_RETRY_LIMIT).toBe(10);
    expect(CREDIT_BATCH_SIZE * PER_ITEM_MS).toBeLessThanOrEqual(COMMISSION_KEY_HOLD_MS);
    // Had the cost stayed at 290 ms the same budget would still give 5.
    expect(cashAccountingBatchSize(15_000, 290)).toBe(5);
  });
});

describe('two workers inside one host club', () => {
  it('deals chunks in page order, round-robin, never splitting or repeating a chunk', () => {
    const lane = Array.from({ length: 45 }, (_, n) => n);
    const workers = laneWorkers(lane, 10, 2);
    expect(workers).toEqual([
      [lane.slice(0, 10), lane.slice(20, 30), lane.slice(40, 45)],
      [lane.slice(10, 20), lane.slice(30, 40)],
    ]);
    expect(workers.flat(2).sort((a, b) => a - b)).toEqual(lane);
    // A lane of one chunk is one worker; nonsense widths are one worker.
    expect(laneWorkers(lane.slice(0, 7), 10, 2)).toEqual([[lane.slice(0, 7)]]);
    expect(laneWorkers(lane.slice(0, 20), 10, 0)).toHaveLength(1);
    expect(laneWorkers(lane.slice(0, 20), 0, 2)).toHaveLength(2);
    expect(laneWorkers([], 10, 2)).toEqual([]);
    expect(CASH_WORKERS_PER_LANE).toBe(2);
  });

  it('runs two disjoint chunks of one host at once and saves the cursor after both', async () => {
    page.rows = Array.from({ length: 2 * CREDIT_BATCH_SIZE }, (_, n) => source(n + 1));
    const parked: Array<{ ids: string[]; release: (v: unknown) => void }> = [];
    creditAnswer = (ids) => new Promise((release) => parked.push({ ids, release }));
    const running = run();
    await vi.waitFor(() => expect(parked).toHaveLength(2));
    const [a, b] = parked;
    expect(new Set([...a.ids, ...b.ids]).size).toBe(2 * CREDIT_BATCH_SIZE);
    expect(a.ids).toEqual(page.rows.slice(0, CREDIT_BATCH_SIZE).map((r) => r.id));
    b.release(batch(b.ids.map((id) => receiptFor(id, 'accrued'))));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(upserts).toHaveLength(0);
    a.release(batch(a.ids.map((id) => receiptFor(id, 'accrued'))));
    expect(await running).toBe('more');
    expect(upserts).toHaveLength(1);
    expect(upserts[0].high_water_mark_id).toBe(page.rows.at(-1)!.id);
  });

  it('a worker that fails halts the page only after the other worker stopped', async () => {
    page.rows = Array.from({ length: 2 * CREDIT_BATCH_SIZE }, (_, n) => source(n + 1));
    const parked: Array<{ ids: string[]; release: (v: unknown) => void }> = [];
    creditAnswer = (ids) => new Promise((release) => parked.push({ ids, release }));
    const running = run();
    await vi.waitFor(() => expect(parked).toHaveLength(2));
    parked[0].release({ data: null, error: { message: 'timeout after commit' } });
    let settled = false;
    void running.then(() => (settled = true));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(false);
    parked[1].release(batch(parked[1].ids.map((id) => receiptFor(id, 'accrued'))));
    expect(await running).toBe('halted');
    expect(upserts).toHaveLength(0);
  });
});

describe('a refusal is read back in one query per table, off the submit path', () => {
  it('reads every refusal of a call with one `in` per table', async () => {
    page.rows = Array.from({ length: CREDIT_BATCH_SIZE }, (_, n) => source(n + 1));
    creditAnswer = (ids) =>
      batch(ids.map((id, n) => receiptFor(id, n % 2 ? 'blocked' : 'accrued')));
    expect(await run()).toBe('more');
    expect(reads).toHaveLength(2);
    expect(reads.map((r) => r.table).sort()).toEqual([
      'accounting_cash_source_receipts',
      'accounting_cash_source_work',
    ]);
    const work = reads.find((r) => r.table === 'accounting_cash_source_work')!;
    expect(work.ops.find(([n]) => n === 'in')![1][1]).toEqual(
      page.rows.filter((_, n) => n % 2).map((r) => r.id)
    );
    expect(upserts).toHaveLength(1);
  });

  it('an all-accrued call reads nothing back', async () => {
    page.rows = Array.from({ length: 3 }, (_, n) => source(n + 1));
    expect(await run()).toBe('more');
    expect(reads).toHaveLength(0);
  });

  it('the next chunk is submitted before the previous refusals are read back', async () => {
    page.rows = Array.from({ length: 3 * CREDIT_BATCH_SIZE }, (_, n) => source(n + 1));
    creditAnswer = (ids) => batch(ids.map((id) => receiptFor(id, 'blocked')));
    let releaseReads!: () => void;
    const gate = new Promise<void>((r) => (releaseReads = r));
    readOverride.current = (table, ids) =>
      gate.then(() => ({ data: durableRows(table, ids), error: null }));
    const running = run();
    // All three chunks are submitted while no readback has answered yet.
    await vi.waitFor(() => expect(creditCalls()).toHaveLength(3));
    expect(upserts).toHaveLength(0);
    releaseReads();
    expect(await running).toBe('more');
    expect(upserts).toHaveLength(1);
  });

  it.each([
    [
      'a missing work row',
      (table: string) => (table.endsWith('_work') ? { data: [], error: null } : null),
    ],
    ['a read error', () => ({ data: null, error: { message: 'read timeout' } })],
    [
      'a foreign receipt row',
      (table: string, ids: string[]) =>
        table.endsWith('_receipts')
          ? { data: ids.map((id) => ({ id, status: 'accrued' })), error: null }
          : null,
    ],
  ])('holds the page on %s', async (_name, override) => {
    page.rows = Array.from({ length: 2 }, (_, n) => source(n + 1));
    creditAnswer = (ids) => batch(ids.map((id) => receiptFor(id, 'blocked')));
    const base = (table: string, ids: string[]) => ({
      data: durableRows(table, ids),
      error: null,
    });
    readOverride.current = (table, ids) =>
      (override as (t: string, i: string[]) => unknown)(table, ids) ?? base(table, ids);
    expect(await run()).toBe('halted');
    expect(upserts).toHaveLength(0);
  });

  it('verifies each refusal against its own rows, whatever order they come back in', async () => {
    page.rows = [source(1), source(2)];
    const receipts = page.rows.map((r) => receiptFor(String(r.id), 'blocked'));
    batch(receipts);
    readOverride.current = (table, ids) => ({
      data: durableRows(table, [...ids].reverse()),
      error: null,
    });
    await expect(confirmCashSourceRefusals(receipts as any)).resolves.toBeUndefined();
    // Swap one receipt's work row for the other's: refused.
    readOverride.current = (table, ids) =>
      table.endsWith('_work')
        ? {
            data: ids.map((id, n) => ({
              rake_record_id: id,
              receipt_id: receipts[1 - n].receipt_id,
              status: 'blocked',
              attempts: 1,
            })),
            error: null,
          }
        : { data: receipts.map((r) => ({ ...r, id: r.receipt_id, result: r })), error: null };
    await expect(confirmCashSourceRefusals(receipts as any)).rejects.toThrow();
  });
});

describe('a retry drain that only re-refused rests', () => {
  const refusals = (n: number, attempt = 5) =>
    Array.from({ length: n }, (_, i) => {
      page.rows.push(source(10_000 + i));
      return receiptFor(uid(10_000 + i), 'blocked', attempt);
    });

  it('backs off 1 min, doubling, to the 30-minute interval', () => {
    expect(retryRestMs(0)).toBe(0);
    expect(retryRestMs(1)).toBe(CASH_RETRY_REST_BASE_MS);
    expect(retryRestMs(2)).toBe(2 * CASH_RETRY_REST_BASE_MS);
    expect(retryRestMs(6)).toBe(CASH_RETRY_REST_MAX_MS);
    expect(retryRestMs(60)).toBe(CASH_RETRY_REST_MAX_MS);
    expect(retryRestMs(Number.NaN)).toBe(0);
    expect(CASH_RETRY_REST_MAX_MS).toBe(30 * 60 * 1000);
  });

  it('a full call of nothing but refusals ends the drain at one call and rests', async () => {
    const queue = refusals(5 * CASH_RETRY_LIMIT);
    retryAnswer = ({ p_limit }) => batch(queue.splice(0, p_limit));
    const settler = new RakebackSettlerService();
    // Only the retry: the fresh page is empty.
    const fresh = page.rows;
    page.rows = [];
    expect(await run(settler)).toBe('idle');
    expect(retryCalls()).toHaveLength(1);
    // Resting: the next run does not ask the queue at all.
    expect(await run(settler)).toBe('idle');
    expect(retryCalls()).toHaveLength(1);
    page.rows = fresh;
  });

  it('a resting queue never delays fresh records', async () => {
    const queue = refusals(5 * CASH_RETRY_LIMIT);
    retryAnswer = ({ p_limit }) => batch(queue.splice(0, p_limit));
    const settler = new RakebackSettlerService();
    page.rows = [];
    await run(settler);
    page.rows = [source(1), source(2)];
    expect(await run(settler)).toBe('more');
    expect(retryCalls()).toHaveLength(1);
    expect(creditCalls()).toHaveLength(1);
    expect(upserts).toHaveLength(1);
  });

  it('asks again after the rest, and an accrual ends the backoff', async () => {
    const queue = refusals(5 * CASH_RETRY_LIMIT);
    retryAnswer = ({ p_limit }) => batch(queue.splice(0, p_limit));
    const settler = new RakebackSettlerService();
    page.rows = [];
    let clock = Date.parse('2026-10-25T05:00:00Z');
    const now = vi.spyOn(Date, 'now').mockImplementation(() => clock);
    try {
      await run(settler);
      expect(retryCalls()).toHaveLength(1);
      clock += CASH_RETRY_REST_BASE_MS - 1;
      await run(settler);
      expect(retryCalls()).toHaveLength(1);
      clock += 2;
      await run(settler);
      // Second fruitless drain in a row: now it rests two minutes.
      expect(retryCalls()).toHaveLength(2);
      clock += CASH_RETRY_REST_BASE_MS + 1;
      await run(settler);
      expect(retryCalls()).toHaveLength(2);
      clock += CASH_RETRY_REST_BASE_MS;
      // The evidence was repaired: the queue now accrues, and keeps draining.
      page.rows = Array.from({ length: 3 * CASH_RETRY_LIMIT }, (_, n) => source(20_000 + n));
      const accruing = page.rows.map((r) => receiptFor(String(r.id), 'accrued', 6));
      page.rows = [];
      retryAnswer = ({ p_limit }) => batch(accruing.splice(0, p_limit));
      await run(settler);
      expect(retryCalls()).toHaveLength(2 + 4);
      // Backoff reset: the next run asks at once.
      await run(settler);
      expect(retryCalls()).toHaveLength(2 + 4 + 1);
    } finally {
      now.mockRestore();
    }
  });

  it('a mixed call that accrued something keeps draining', async () => {
    const mixed = Array.from({ length: 3 * CASH_RETRY_LIMIT }, (_, i) => {
      page.rows.push(source(30_000 + i));
      return receiptFor(uid(30_000 + i), i % CASH_RETRY_LIMIT === 0 ? 'accrued' : 'blocked', 3);
    });
    retryAnswer = ({ p_limit }) => batch(mixed.splice(0, p_limit));
    page.rows = [];
    await run();
    expect(retryCalls()).toHaveLength(4);
  });
});
