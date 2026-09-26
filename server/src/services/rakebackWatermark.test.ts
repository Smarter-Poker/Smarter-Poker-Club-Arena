/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * AUDIT M6 / Q4 — RakebackSettlerService resume cursor
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * The settler paged rake_records with `.gt('created_at', T).limit(10000)` and
 * then set T to the last row's created_at. A timestamp is not a unique position
 * in that table, so two rows sharing one created_at across the LIMIT boundary
 * were lost permanently — row 10000 moved the watermark to T and row 10001
 * (also at T) was excluded by the strict `>` on every later cycle. Nothing
 * downstream could notice: unpaid rakeback leaves no trace.
 *
 * The asymmetry that shapes every assertion below: re-processing a rake record
 * is FREE (agent commission dedupes on (user_id, source_id, source_type),
 * player_stats claims through rakeback_stats_applied, rakeback_periods
 * recomputes from source) while skipping one silently costs a player money. So
 * the cursor is allowed to be conservative and is never allowed to be greedy.
 *
 * The invariants under test:
 *   1. the cursor is a COMPOSITE (created_at, id) — a total order, so the LIMIT
 *      boundary has no interior for a row to hide in
 *   2. the timestamp is carried as the RAW database string — `new Date(iso)`
 *      truncates Postgres microseconds and yields a cursor pointing at an
 *      instant no row occupies
 *   3. a cursor with no id (the first cycle after this deploy) conservatively replays its
 *      timestamp boundary, so unacknowledged ties cannot disappear
 *   4. a failed read never advances the cursor
 *   5. every nonempty batch is drained immediately instead of after another 30 minutes,
 *      under a cap that ANNOUNCES itself when it truncates
 *   6. the two other daemons sharing daemon_state are untouched
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { pacificAccountingWeek } from './pacificAccountingWeek.js';

type Op = [string, unknown[]];
interface Recorded {
  table: string;
  ops: Op[];
}

interface RakeRow {
  id: string;
  created_at: string;
  club_id: string;
  rake_amount: number;
  hand_id: string | null;
  is_tournament: boolean;
  tournament_id?: string | null;
  player_contributions: Record<string, number> | null;
}

interface Scenario {
  settlerState?: { high_water_mark: string; high_water_mark_id: string | null } | null;
  stateReadFails?: boolean;
  stateReadThrows?: boolean;
  stateWriteOutcomes?: Array<'error' | 'throw' | null>;
  fetchOutcomes?: Array<'error' | 'throw' | null>;
  serverPageCap?: number;
  fetchError?: { message: string } | null;
  dataset?: RakeRow[];
  ledger?: Array<{
    id: string;
    hand_id: string;
    player_id: string;
    weighted_rake_credit: number;
    club_id: string;
    rake_record_id: string;
  }>;
  ledgerError?: { message: string };
  periodQueue?: Record<string, unknown> | null;
  periodQueueError?: { message: string };
  /** Per-read view of the durable period request, for readback over time. */
  periodQueueRead?: () => Record<string, unknown> | null;
  sourceReceipt?: unknown;
  sourceWork?: unknown;
  sourceReadError?: { message: string };
  retryReceipts?: Array<Record<string, unknown>>;
}

// vi.hoisted: supabase.ts calls reportError at module scope when the service
// role key is absent (always, under the runner), so the mock factories run
// before any plain `const` in this file is initialised.
const { mockFrom, mockRpc, mockReportError, recorded, scenario } = vi.hoisted(() => {
  const recorded: Recorded[] = [];
  const scenario: { current: Record<string, unknown> } = { current: {} };

  const from = (table: string) => {
    const rec: Recorded = { table, ops: [] };
    recorded.push(rec);
    // Every PostgrestFilterBuilder method returns the builder, and the builder
    // itself is thenable — one proxy models the whole surface, so the test does
    // not have to be updated every time the production query grows a clause.
    const chain: unknown = new Proxy(
      {},
      {
        get(_target, prop) {
          if (typeof prop !== 'string') return undefined;
          if (prop === 'then') {
            return (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
              Promise.resolve()
                .then(() => (scenario.current.respond as (r: Recorded) => unknown)(rec))
                .then(resolve, reject);
          }
          return (...args: unknown[]) => {
            rec.ops.push([prop, args]);
            return chain;
          };
        },
      }
    );
    return chain;
  };

  return {
    mockFrom: vi.fn(from),
    mockRpc: vi.fn(),
    mockReportError: vi.fn(),
    recorded,
    scenario,
  };
});

vi.mock('./supabase.js', () => ({
  supabase: {
    from: (table: string) => mockFrom(table),
    rpc: (...args: unknown[]) => mockRpc(...args),
  },
}));

vi.mock('./errorReporter.js', () => ({
  reportError: (...args: unknown[]) => mockReportError(...args),
  reportWarning: vi.fn(),
}));

import {
  RakebackSettlerService,
  FETCH_LIMIT,
  CREDIT_BATCH_SIZE,
  MAX_DRAIN_BATCHES,
} from './RakebackSettlerService.js';

// ── helpers ──────────────────────────────────────────────────────────────────

/**
 * Fixed-width so lexicographic order equals chronological order, which is what
 * lets the fake evaluate `>` on plain strings the way Postgres evaluates it on
 * timestamptz. The six-digit tail is microseconds — the precision the old
 * `new Date()` round-trip destroyed.
 */
const ts = (micros: number) => `2026-08-06 20:00:00.${String(micros).padStart(6, '0')}+00`;
const uid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function row(n: number, at: number): RakeRow {
  return {
    id: uid(n),
    created_at: ts(at),
    club_id: 'fade0000-0000-0000-0000-000000000001',
    rake_amount: 1,
    hand_id: null,
    is_tournament: false,
    // Empty on purpose: this suite is about WHICH rows are read, not what is
    // done with them, so every row falls through to the no-eligible-credits
    // path that still advances the cursor.
    player_contributions: {},
  };
}

const opArg = (rec: Recorded, name: string, index = 0): unknown =>
  rec.ops.find(([n]) => n === name)?.[1][index];

const rakeFetches = () =>
  recorded.filter(
    (r) => r.table === 'rake_records' && r.ops.some(([n]) => n === 'or' || n === 'gt')
  );

const settlerUpserts = () =>
  recorded.filter(
    (r) =>
      r.table === 'daemon_state' &&
      r.ops.some(
        ([n, a]) =>
          n === 'upsert' && (a[0] as { daemon?: string } | undefined)?.daemon === 'rakeback_settler'
      )
  );

const upsertPayload = (rec: Recorded) =>
  (rec.ops.find(([n]) => n === 'upsert')?.[1][0] ?? {}) as Record<string, unknown>;

/** Evaluate the real query operators; never pre-skip rows on the mock's behalf. */
function applyCursor(dataset: RakeRow[], rec: Recorded, serverCap = Infinity): RakeRow[] {
  const timeFilters = rec.ops.filter(
    ([name, args]) => ['eq', 'gt', 'gte'].includes(name) && args[0] === 'created_at'
  );
  if (timeFilters.length !== 1) throw new Error('source page requires one timestamp range');
  if (rec.ops.some(([name]) => name === 'or')) throw new Error('unexpected non-indexed OR cursor');
  const [operator, [, timestamp]] = timeFilters[0];
  const afterId = rec.ops.find(([name, args]) => name === 'gt' && args[0] === 'id')?.[1][1];
  if (operator === 'eq' && typeof afterId !== 'string')
    throw new Error('timestamp tie page requires a strict id boundary');
  const limit = Math.min(Number(opArg(rec, 'limit') ?? dataset.length), serverCap);
  return dataset
    .filter((r) => r.rake_amount > 0)
    .filter((r) =>
      operator === 'eq'
        ? r.created_at === timestamp
        : operator === 'gt'
          ? r.created_at > String(timestamp)
          : r.created_at >= String(timestamp)
    )
    .filter((r) => afterId === undefined || r.id > String(afterId))
    .sort((a, b) =>
      a.created_at === b.created_at
        ? a.id.localeCompare(b.id)
        : a.created_at.localeCompare(b.created_at)
    )
    .slice(0, limit);
}

function install(s: Scenario) {
  const dataset = s.dataset ?? [];
  let writeAttempt = 0;
  let fetchAttempt = 0;
  scenario.current = {
    durableCursor: s.settlerState ? { ...s.settlerState } : null,
    definition: s,
    receipts: new Map<string, Record<string, unknown>>(),
    respond: (rec: Recorded) => {
      if (rec.table === 'daemon_state') {
        if (rec.ops.some(([n]) => n === 'upsert')) {
          const payload = upsertPayload(rec);
          if (payload.daemon === 'rakeback_settler') {
            const outcome = s.stateWriteOutcomes?.[writeAttempt++];
            if (outcome === 'throw') throw new Error('checkpoint connection lost');
            if (outcome === 'error')
              return { data: null, error: { message: 'checkpoint rejected' } };
            scenario.current.durableCursor = {
              high_water_mark: payload.high_water_mark,
              high_water_mark_id: payload.high_water_mark_id,
            };
          }
          return { data: null, error: null };
        }
        const daemon = rec.ops.find(([n]) => n === 'eq')?.[1][1];
        if (daemon === 'rakeback_settler') {
          if (s.stateReadThrows) throw new Error('checkpoint read connection lost');
          if (s.stateReadFails) return { data: null, error: { message: 'state read exploded' } };
          return { data: scenario.current.durableCursor, error: null };
        }
        // Far-future watermarks park the weekly close and the tournament
        // sentinel so this suite only exercises the settlement read.
        return { data: { high_water_mark: '2999-12-27T00:00:00+00' }, error: null };
      }
      if (rec.table === 'rake_records') {
        const outcome = s.fetchOutcomes?.[fetchAttempt++];
        if (outcome === 'throw') throw new Error('source read connection lost');
        if (outcome === 'error') return { data: null, error: { message: 'source read rejected' } };
        if (s.fetchError) return { data: null, error: s.fetchError };
        return { data: applyCursor(dataset, rec, s.serverPageCap), error: null };
      }
      if (
        rec.table === 'accounting_cash_source_receipts' ||
        rec.table === 'accounting_cash_source_work'
      ) {
        const id = rec.ops.find(([n]) => n === 'eq')?.[1][1];
        const receipts = [
          ...(scenario.current.receipts as Map<string, Record<string, unknown>>).values(),
        ];
        const receipt = receipts.find((r) =>
          rec.table.endsWith('_receipts') ? r.receipt_id === id : r.rake_record_id === id
        );
        const durable = receipt ? { ...receipt, id: receipt.receipt_id, result: receipt } : null;
        const work = receipt
          ? {
              rake_record_id: receipt.rake_record_id,
              receipt_id: receipt.receipt_id,
              status: receipt.status,
              attempts: receipt.attempt,
            }
          : null;
        return {
          data: rec.table.endsWith('_receipts')
            ? 'sourceReceipt' in s
              ? s.sourceReceipt
              : durable
            : 'sourceWork' in s
              ? s.sourceWork
              : work,
          error: s.sourceReadError ?? null,
        };
      }
      if (rec.table === 'accounting_period_recompute_requests') {
        if (s.periodQueueRead) return { data: s.periodQueueRead(), error: null };
        return { data: s.periodQueue ?? null, error: s.periodQueueError ?? null };
      }
      if (rec.table === 'rake_attributions') {
        const after = rec.ops.find(([n, a]) => n === 'gt' && a[0] === 'id')?.[1][1];
        return {
          data: (s.ledger ?? []).filter((r) => !after || r.id > String(after)),
          error: s.ledgerError ?? null,
        };
      }
      return { data: [], error: null };
    },
  };
}

function batchReceipt(receipts: Array<Record<string, unknown>>) {
  const ok = receipts.filter((r) => r.status === 'accrued').length;
  return {
    receipt_version: 3,
    ok,
    failed: receipts.length - ok,
    blocked: receipts.length - ok,
    receipts,
  };
}
function sourceReceipt(source: RakeRow, s: Scenario): Record<string, unknown> {
  const allocation = (s.ledger ?? []).filter((a) => a.rake_record_id === source.id);
  const ready = !!source.hand_id && allocation.length > 0;
  const week = pacificAccountingWeek(source.created_at);
  return {
    receipt_version: 3,
    recorded: true,
    receipt_id: uid(900000 + Number(source.id.slice(-6))),
    rake_record_id: source.id,
    hand_id: source.hand_id,
    earned_at: source.created_at,
    attempt: 1,
    source_fingerprint: 'a'.repeat(32),
    status: ready ? 'accrued' : 'blocked',
    reason: ready ? null : 'cash_source_evidence_missing',
    credits: ready
      ? allocation.map((a) => ({
          player_id: a.player_id,
          club_id: a.club_id,
          rake_credit: a.weighted_rake_credit,
          period_start: week.periodStart,
          period_end: week.periodEnd,
        }))
      : [],
  };
}
function success(name: string, args: Record<string, any>) {
  if (name === 'fn_rakeback_recompute_periods')
    return {
      data: {
        written: 1,
        accounting_version: 2,
        confirmed_players: args.p_user_ids?.length ?? 0,
        status: 'ready',
        club_id: args.p_club_id,
        period_start: args.p_period_start,
        period_end: args.p_period_end,
      },
      error: null,
    };
  const s = scenario.current.definition as Scenario;
  const receipts =
    name === 'fn_retry_cash_accounting_sources'
      ? (s.retryReceipts ?? [])
      : (args.p_items ?? []).map((it: Record<string, unknown>) => {
          const source = (s.dataset ?? []).find((r) => r.id === it.source_id);
          if (!source) throw new Error('unknown fixture source');
          return sourceReceipt(source, s);
        });
  for (const receipt of receipts)
    (scenario.current.receipts as Map<string, Record<string, unknown>>).set(
      receipt.receipt_id as string,
      receipt
    );
  return { data: batchReceipt(receipts), error: null };
}

describe('RakebackSettlerService durable composite cursor', () => {
  const run = (settler = new RakebackSettlerService()) =>
    (settler as unknown as { _runSettlementInner(): Promise<string> })._runSettlementInner();
  const submittedIds = () =>
    mockRpc.mock.calls
      .filter(([name]) => name === 'fn_credit_agent_commissions_batch')
      .flatMap(([, args]) => args.p_items.map((item: { source_id: string }) => item.source_id));
  beforeEach(() => {
    recorded.length = 0;
    mockFrom.mockClear();
    mockRpc.mockReset();
    mockReportError.mockReset();
    mockRpc.mockImplementation(async (name, args) => success(name, args));
  });

  it.each([null, 'not"a,uuid'])(
    'replays the entire boundary timestamp when the stored id is %j',
    async (id) => {
      install({
        settlerState: { high_water_mark: ts(500), high_water_mark_id: id },
        dataset: [row(1, 499), row(2, 500), row(3, 501)],
      });
      expect(await run()).toBe('more');
      expect(rakeFetches()[0].ops).toContainEqual(['gte', ['created_at', ts(500)]]);
      expect(submittedIds()).toEqual([uid(2), uid(3)]);
      expect(scenario.current.durableCursor).toEqual({
        high_water_mark: ts(501),
        high_water_mark_id: uid(3),
      });
    }
  );

  it('keeps raw microseconds in both indexed reads and the durable checkpoint', async () => {
    install({
      settlerState: { high_water_mark: ts(500), high_water_mark_id: uid(1) },
      dataset: [row(1, 500), row(2, 500), row(3, 501)],
    });
    const settler = new RakebackSettlerService();
    expect(await run(settler)).toBe('more');
    expect(rakeFetches()[0].ops).toContainEqual(['eq', ['created_at', ts(500)]]);
    expect(rakeFetches()[0].ops).toContainEqual(['gt', ['id', uid(1)]]);
    expect(scenario.current.durableCursor).toEqual({
      high_water_mark: ts(500),
      high_water_mark_id: uid(2),
    });
    expect(await run(settler)).toBe('more');
    expect(rakeFetches()[2].ops).toContainEqual(['gt', ['created_at', ts(500)]]);
    expect(scenario.current.durableCursor).toEqual({
      high_water_mark: ts(501),
      high_water_mark_id: uid(3),
    });
    expect(upsertPayload(settlerUpserts()[0]).high_water_mark).not.toBe(
      new Date(ts(500)).toISOString()
    );
    expect(submittedIds()).toEqual([uid(2), uid(3)]);
  });

  it('asks for later timestamps only after an empty tie page', async () => {
    install({
      settlerState: { high_water_mark: ts(100), high_water_mark_id: uid(7) },
      dataset: [row(8, 100), row(9, 400)],
    });
    const settler = new RakebackSettlerService();
    expect(await run(settler)).toBe('more');
    expect(rakeFetches()).toHaveLength(1);
    expect(submittedIds()).toEqual([uid(8)]);
    expect(await run(settler)).toBe('more');
    expect(rakeFetches()).toHaveLength(3);
    expect(applyCursor([row(8, 100), row(9, 400)], rakeFetches()[1])).toEqual([]);
    expect(rakeFetches()[2].ops).toContainEqual(['gt', ['created_at', ts(100)]]);
    expect(submittedIds()).toEqual([uid(8), uid(9)]);
    expect(await run(settler)).toBe('idle');
  });

  it('orders every range by timestamp and id', async () => {
    install({
      settlerState: { high_water_mark: ts(100), high_water_mark_id: uid(1) },
      dataset: [],
    });
    expect(await run()).toBe('idle');
    expect(rakeFetches()).toHaveLength(2);
    for (const fetch of rakeFetches())
      expect(fetch.ops.filter(([name]) => name === 'order').map(([, args]) => args[0])).toEqual([
        'created_at',
        'id',
      ]);
  });

  it('finishes a timestamp group larger than two requested pages without repeating its prefix or losing later rows', async () => {
    const ties = Array.from({ length: FETCH_LIMIT * 2 + 7 }, (_, i) => row(i + 1, 100));
    const dataset = [...ties, row(ties.length + 1, 101)];
    install({ settlerState: { high_water_mark: ts(100), high_water_mark_id: uid(0) }, dataset });
    const settler = new RakebackSettlerService();
    expect(await run(settler)).toBe('more');
    expect(await run(settler)).toBe('more');
    expect(await run(settler)).toBe('more');
    expect(submittedIds()).toEqual(ties.map((source) => source.id));
    expect(await run(settler)).toBe('more');
    expect(await run(settler)).toBe('idle');
    expect(submittedIds()).toEqual(dataset.map((source) => source.id));
    expect(new Set(submittedIds()).size).toBe(dataset.length);
    expect(scenario.current.durableCursor).toEqual({
      high_water_mark: ts(101),
      high_water_mark_id: uid(dataset.length),
    });
  });

  it('keeps draining short pages imposed by a lower server cap, including a boundary tie', async () => {
    const dataset = Array.from({ length: 23 }, (_, i) => row(i + 1, i < 17 ? 100 : 101));
    install({
      settlerState: { high_water_mark: ts(100), high_water_mark_id: uid(0) },
      dataset,
      serverPageCap: 4,
    });
    const settler = new RakebackSettlerService();
    let cycles = 0;
    while ((await run(settler)) === 'more') {
      cycles++;
      if (cycles > dataset.length) throw new Error('source drain made no bounded progress');
    }
    expect(cycles).toBe(7);
    expect(submittedIds()).toEqual(dataset.map((source) => source.id));
    expect(new Set(submittedIds()).size).toBe(dataset.length);
    for (const fetch of rakeFetches()) expect(opArg(fetch, 'limit')).toBe(FETCH_LIMIT);
  });

  it.each(['error', 'throw'] as const)(
    'holds both memory and durable position after a last-page checkpoint %s and recovers without new earnings',
    async (failure) => {
      const dataset = [row(1, 100), row(2, 200)];
      install({
        settlerState: { high_water_mark: ts(100), high_water_mark_id: uid(0) },
        dataset,
        stateWriteOutcomes: [null, failure, null],
      });
      const settler = new RakebackSettlerService();
      expect(await run(settler)).toBe('more');
      expect(await run(settler)).toBe('halted');
      expect(scenario.current.durableCursor).toEqual({
        high_water_mark: ts(100),
        high_water_mark_id: uid(1),
      });
      expect(
        mockReportError.mock.calls.some(
          ([, label]) => label === 'RakebackSettler.saveHighWaterMark'
        )
      ).toBe(true);
      expect(await run(settler)).toBe('more');
      expect(scenario.current.durableCursor).toEqual({
        high_water_mark: ts(200),
        high_water_mark_id: uid(2),
      });
      expect(await run(settler)).toBe('idle');
      expect(submittedIds()).toEqual([uid(1), uid(2), uid(2)]);
      const attempts = mockRpc.mock.calls.filter(
        ([name]) => name === 'fn_credit_agent_commissions_batch'
      );
      expect(attempts[1][1]).toEqual(attempts[2][1]);
      expect(settlerUpserts()).toHaveLength(3);
      expect(await run(new RakebackSettlerService())).toBe('idle');
      expect(submittedIds()).toEqual([uid(1), uid(2), uid(2)]);
    }
  );

  it('a restart after a failed first checkpoint replays the same source identity from durable state', async () => {
    install({
      settlerState: { high_water_mark: ts(100), high_water_mark_id: uid(0) },
      dataset: [row(1, 100)],
      stateWriteOutcomes: ['error', null],
    });
    expect(await run()).toBe('halted');
    const restarted = new RakebackSettlerService();
    expect(await run(restarted)).toBe('more');
    expect(await run(restarted)).toBe('idle');
    expect(submittedIds()).toEqual([uid(1), uid(1)]);
    expect(scenario.current.durableCursor).toEqual({
      high_water_mark: ts(100),
      high_water_mark_id: uid(1),
    });
  });

  it.each([{ stateReadFails: true }, { stateReadThrows: true }])(
    'does not fetch or write source after a checkpoint read failure %j',
    async (failure) => {
      install({ ...failure, dataset: [row(1, 10)] });
      expect(await run()).toBe('halted');
      expect(rakeFetches()).toHaveLength(0);
      expect(settlerUpserts()).toHaveLength(0);
      expect(submittedIds()).toEqual([]);
    }
  );

  it.each(['error', 'throw'] as const)(
    'holds the cursor when the timestamp tie query returns %s',
    async (failure) => {
      install({
        settlerState: { high_water_mark: ts(100), high_water_mark_id: uid(1) },
        dataset: [row(2, 100), row(3, 200)],
        fetchOutcomes: [failure],
      });
      const settler = new RakebackSettlerService();
      expect(await run(settler)).toBe('halted');
      expect(rakeFetches()).toHaveLength(1);
      expect(settlerUpserts()).toHaveLength(0);
      expect(submittedIds()).toEqual([]);
      expect(await run(settler)).toBe('more');
      expect(submittedIds()).toEqual([uid(2)]);
    }
  );

  it.each(['error', 'throw'] as const)(
    'holds the cursor when the later-timestamp query returns %s',
    async (failure) => {
      install({
        settlerState: { high_water_mark: ts(100), high_water_mark_id: uid(1) },
        dataset: [row(2, 200)],
        fetchOutcomes: [null, failure],
      });
      const settler = new RakebackSettlerService();
      expect(await run(settler)).toBe('halted');
      expect(rakeFetches()).toHaveLength(2);
      expect(settlerUpserts()).toHaveLength(0);
      expect(await run(settler)).toBe('more');
      expect(await run(settler)).toBe('idle');
      expect(submittedIds()).toEqual([uid(2)]);
    }
  );

  it('does not move the cursor on an empty source range', async () => {
    const state = { high_water_mark: ts(900), high_water_mark_id: uid(9) };
    install({ settlerState: state, dataset: [] });
    expect(await run()).toBe('idle');
    expect(scenario.current.durableCursor).toEqual(state);
    expect(settlerUpserts()).toHaveLength(0);
  });

  it('drains a lower server cap up to the three-batch bound and resumes the remaining rows', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const dataset = Array.from({ length: MAX_DRAIN_BATCHES * 2 + 1 }, (_, i) => row(i + 1, 100));
    install({
      settlerState: { high_water_mark: ts(100), high_water_mark_id: uid(0) },
      dataset,
      serverPageCap: 2,
    });
    const settler = new RakebackSettlerService();
    await settler.runSettlement();
    expect(settlerUpserts()).toHaveLength(MAX_DRAIN_BATCHES);
    expect(submittedIds()).toEqual(
      dataset.slice(0, MAX_DRAIN_BATCHES * 2).map((source) => source.id)
    );
    expect(warn.mock.calls.some(([message]) => String(message).includes('drain cap reached'))).toBe(
      true
    );
    expect(
      warn.mock.calls.some(([message]) => String(message).includes('backlog may remain'))
    ).toBe(true);
    await settler.runSettlement();
    expect(submittedIds()).toEqual(dataset.map((source) => source.id));
    warn.mockRestore();
  });

  it('never writes row ids into the other daemons sharing daemon_state', async () => {
    install({ settlerState: null, dataset: [] });
    await new RakebackSettlerService().runSettlement();
    for (const rec of recorded.filter(
      (r) => r.table === 'daemon_state' && r.ops.some(([name]) => name === 'upsert')
    ))
      if (upsertPayload(rec).daemon !== 'rakeback_settler')
        expect(upsertPayload(rec)).not.toHaveProperty('high_water_mark_id');
  });
});

describe('cash source receipts protect the durable cursor', () => {
  afterEach(() => {
    vi.useRealTimers();
  });
  const creditedRow = () => ({
    ...row(1, 200),
    hand_id: uid(77),
    player_contributions: { [uid(42)]: 10 },
  });
  const ledger = [
    {
      id: uid(100),
      hand_id: uid(77),
      player_id: uid(42),
      club_id: uid(55),
      rake_record_id: uid(1),
      weighted_rake_credit: 1,
    },
  ];
  const setup = (extra: Partial<Scenario> = {}) =>
    install({
      settlerState: { high_water_mark: ts(100), high_water_mark_id: uid(0) },
      dataset: [creditedRow()],
      ledger,
      ...extra,
    });
  const run = (settler = new RakebackSettlerService()) =>
    (settler as unknown as { _runSettlementInner(): Promise<string> })._runSettlementInner();
  beforeEach(() => {
    recorded.length = 0;
    mockFrom.mockClear();
    mockRpc.mockReset();
    mockReportError.mockReset();
    setup();
    mockRpc.mockImplementation(async (name, args) => success(name, args));
  });
  it.each([
    { data: null, error: null },
    { data: {}, error: null },
    { data: { ok: 1, failed: 0 }, error: null },
    {
      data: { ...batchReceipt([sourceReceipt(creditedRow(), { ledger })]), receipt_version: 1 },
      error: null,
    },
    {
      data: batchReceipt([{ ...sourceReceipt(creditedRow(), { ledger }), rake_record_id: uid(2) }]),
      error: null,
    },
    {
      data: batchReceipt([
        sourceReceipt(creditedRow(), { ledger }),
        sourceReceipt(creditedRow(), { ledger }),
      ]),
      error: null,
    },
    {
      data: batchReceipt([{ ...sourceReceipt(creditedRow(), { ledger }), recorded: false }]),
      error: null,
    },
    { data: { receipt_version: 3, ok: 1, failed: 0, blocked: 0, receipts: [] }, error: null },
    { data: { receipt_version: 3, ok: 0, failed: 1, blocked: 0, receipts: [] }, error: null },
    { data: null, error: { message: 'timeout after commit' } },
  ])('holds the cursor for unproven source result %j', async (response) => {
    mockRpc.mockImplementation(async (name, args) =>
      name === 'fn_credit_agent_commissions_batch' ? response : success(name, args)
    );
    expect(await run()).toBe('halted');
    expect(settlerUpserts()).toHaveLength(0);
  });
  it('retries an identical source after a lost batch response', async () => {
    let attempts = 0;
    mockRpc.mockImplementation(async (name, args) =>
      name === 'fn_credit_agent_commissions_batch' && attempts++ === 0
        ? { data: null, error: { message: 'lost response' } }
        : success(name, args)
    );
    const settler = new RakebackSettlerService();
    expect(await run(settler)).toBe('halted');
    expect(await run(settler)).toBe('more');
    const batches = mockRpc.mock.calls.filter((c) => c[0] === 'fn_credit_agent_commissions_batch');
    expect(batches[0][1]).toEqual(batches[1][1]);
    expect(settlerUpserts()).toHaveLength(1);
  });
  it('holds the same source across a delayed old response and accepts its later canonical receipt', async () => {
    let release!: (value: unknown) => void;
    let creditCalls = 0;
    mockRpc.mockImplementation(async (name, args) => {
      if (name === 'fn_credit_agent_commissions_batch' && creditCalls++ === 0)
        return new Promise((resolve) => {
          release = resolve;
        });
      return success(name, args);
    });
    const settler = new RakebackSettlerService();
    const pending = run(settler);
    await vi.waitFor(() => expect(creditCalls).toBe(1));
    expect(settlerUpserts()).toHaveLength(0);
    release({ data: { ok: 1, failed: 0, first_error: null }, error: null });
    expect(await pending).toBe('halted');
    expect(settlerUpserts()).toHaveLength(0);
    expect(await run(settler)).toBe('more');
    const batches = mockRpc.mock.calls.filter(
      ([name]) => name === 'fn_credit_agent_commissions_batch'
    );
    expect(batches).toHaveLength(2);
    expect(batches[0]).toEqual(batches[1]);
    expect(mockRpc.mock.calls.map(([name]) => name)).toEqual([
      'fn_retry_cash_accounting_sources',
      'fn_credit_agent_commissions_batch',
      'fn_retry_cash_accounting_sources',
      'fn_credit_agent_commissions_batch',
      'fn_rakeback_recompute_periods',
    ]);
    expect(settlerUpserts()).toHaveLength(1);
  });
  it('joins an admitted canonical RPC before stop resolves and refuses new work after stop', async () => {
    let release!: (value: unknown) => void;
    let creditArgs!: Record<string, any>;
    mockRpc.mockImplementation(async (name, args) => {
      if (name === 'fn_credit_agent_commissions_batch') {
        creditArgs = args;
        return new Promise((resolve) => {
          release = resolve;
        });
      }
      return success(name, args);
    });
    const settler = new RakebackSettlerService();
    // Keep the public launch, actual source retry/dispatch/receipt and stop real.
    // Only unrelated weekly/observer work is parked for this cash-source case.
    for (const method of [
      'runWeeklyFinancialClose',
      'runTournamentSentinel',
      'runUnionTreasurySentinel',
      'runUnionGovernanceSentinel',
      'runUnionRakeRollupCatchup',
      'runUnionEcoRecord',
      'runTournamentChipConservation',
    ] as const)
      vi.spyOn(settler as any, method).mockResolvedValue(undefined);
    const running = settler.runSettlement();
    await vi.waitFor(() =>
      expect(
        mockRpc.mock.calls.filter(([name]) => name === 'fn_credit_agent_commissions_batch')
      ).toHaveLength(1)
    );
    let stopped = false;
    const stop = settler.stop();
    void stop.then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    expect(settlerUpserts()).toHaveLength(0);
    const admittedCalls = mockRpc.mock.calls.length;
    await settler.runSettlement();
    expect(mockRpc).toHaveBeenCalledTimes(admittedCalls);
    release(success('fn_credit_agent_commissions_batch', creditArgs));
    await Promise.all([running, stop]);
    expect(stopped).toBe(true);
    expect(settlerUpserts()).toHaveLength(1);
    expect(mockRpc.mock.calls.map(([name]) => name)).toEqual([
      'fn_retry_cash_accounting_sources',
      'fn_credit_agent_commissions_batch',
      'fn_rakeback_recompute_periods',
      'fn_retry_cash_accounting_sources',
    ]);
    const drainedCalls = mockRpc.mock.calls.length;
    await settler.runSettlement();
    expect(mockRpc).toHaveBeenCalledTimes(drainedCalls);
  });
  it('holds the page if a later chunk returns a legacy response across cutover', async () => {
    const dataset = Array.from({ length: CREDIT_BATCH_SIZE + 1 }, (_, n) => ({
      ...creditedRow(),
      id: uid(n + 1),
      created_at: ts(200 + n),
      hand_id: uid(10000 + n),
    }));
    setup({
      dataset,
      ledger: dataset.map((source, n) => ({
        ...ledger[0],
        id: uid(20000 + n),
        rake_record_id: source.id,
        hand_id: source.hand_id,
      })),
    });
    mockRpc.mockImplementation(async (name, args) =>
      name === 'fn_credit_agent_commissions_batch' && args.p_items.length === 1
        ? { data: { ok: 1, failed: 0, first_error: null }, error: null }
        : success(name, args)
    );
    expect(await run()).toBe('halted');
    expect(settlerUpserts()).toHaveLength(0);
    expect(scenario.current.durableCursor).toEqual({
      high_water_mark: ts(100),
      high_water_mark_id: uid(0),
    });
    expect(mockRpc.mock.calls.map(([name]) => name)).toEqual([
      'fn_retry_cash_accounting_sources',
      'fn_credit_agent_commissions_batch',
      'fn_credit_agent_commissions_batch',
    ]);
    const batches = mockRpc.mock.calls.filter(
      ([name]) => name === 'fn_credit_agent_commissions_batch'
    );
    expect(batches.map(([, args]) => args.p_items.length)).toEqual([CREDIT_BATCH_SIZE, 1]);
    expect(
      batches.flatMap(([, args]) =>
        args.p_items.map((item: { source_id: string }) => item.source_id)
      )
    ).toEqual(dataset.map((source) => source.id));
  });
  it.each(['error', 'throw'] as const)(
    'recovers the final credited period after checkpoint %s without waiting for a new source',
    async (failure) => {
      // Compare retries at one controlled instant; preserve the full payload assertion.
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-08-06T20:00:01.000Z'));
      setup({ stateWriteOutcomes: [failure, null] });
      const settler = new RakebackSettlerService();
      expect(await run(settler)).toBe('halted');
      expect(scenario.current.durableCursor).toEqual({
        high_water_mark: ts(100),
        high_water_mark_id: uid(0),
      });
      expect(
        mockRpc.mock.calls.filter(([name]) => name === 'fn_rakeback_recompute_periods')
      ).toHaveLength(1);
      expect(await run(settler)).toBe('more');
      expect(scenario.current.durableCursor).toEqual({
        high_water_mark: ts(200),
        high_water_mark_id: uid(1),
      });
      expect(await run(settler)).toBe('idle');
      const batches = mockRpc.mock.calls.filter(
        ([name]) => name === 'fn_credit_agent_commissions_batch'
      );
      const periods = mockRpc.mock.calls.filter(
        ([name]) => name === 'fn_rakeback_recompute_periods'
      );
      expect(batches).toHaveLength(2);
      expect(batches[0][1]).toEqual(batches[1][1]);
      expect(periods).toHaveLength(2);
      expect(periods[0][1]).toEqual(periods[1][1]);
      expect((scenario.current.receipts as Map<string, unknown>).size).toBe(1);
      expect(settlerUpserts()).toHaveLength(2);
      expect(upsertPayload(settlerUpserts()[0])).toEqual(upsertPayload(settlerUpserts()[1]));
    }
  );
  it('advances past a refused hand only after immutable receipt and retry work readback', async () => {
    setup({ ledger: [] });
    expect(await run()).toBe('more');
    expect(settlerUpserts()).toHaveLength(1);
    expect(recorded.some((r) => r.table === 'accounting_cash_source_receipts')).toBe(true);
    expect(recorded.some((r) => r.table === 'accounting_cash_source_work')).toBe(true);
    expect(mockRpc.mock.calls.some((c) => c[0] === 'fn_rakeback_recompute_periods')).toBe(false);
  });
  it.each([
    { sourceReceipt: null },
    { sourceReceipt: {} },
    { sourceWork: null },
    { sourceWork: {} },
    { sourceReadError: { message: 'read timeout' } },
  ])('holds unverified refusal readback %j', async (extra) => {
    setup({ ledger: [], ...extra });
    expect(await run()).toBe('halted');
    expect(settlerUpserts()).toHaveLength(0);
  });
  it('sends missing hand and null contributions to database authority without skipping them', async () => {
    setup({ dataset: [{ ...row(1, 200), player_contributions: null }], ledger: [] });
    expect(await run()).toBe('more');
    expect(
      mockRpc.mock.calls.find((c) => c[0] === 'fn_credit_agent_commissions_batch')![1]
    ).toEqual({ p_items: [{ source_type: 'cash_rake_record', source_id: uid(1) }] });
    expect(
      rakeFetches()[0].ops.some(([op, args]) => op === 'not' && args[0] === 'player_contributions')
    ).toBe(false);
  });
  it('one durable refusal does not stop another earning club from its period refresh', async () => {
    setup({ dataset: [creditedRow(), row(2, 300)] });
    expect(await run()).toBe('more');
    expect(
      mockRpc.mock.calls.find((c) => c[0] === 'fn_rakeback_recompute_periods')![1].p_club_id
    ).toBe(uid(55));
    expect(upsertPayload(settlerUpserts()[0]).high_water_mark_id).toBe(uid(2));
  });
  it('delegates original stats once inside source authority and uses the recorded earning club', async () => {
    expect(await run()).toBe('more');
    expect(mockRpc.mock.calls.map((c) => c[0])).toEqual([
      'fn_retry_cash_accounting_sources',
      'fn_credit_agent_commissions_batch',
      'fn_rakeback_recompute_periods',
    ]);
    expect(recorded.some((r) => r.table === 'rake_attributions')).toBe(false);
    expect(mockRpc.mock.calls[2][1].p_club_id).toBe(uid(55));
  });
  it('drains an older recovered source even when there are no new rake rows', async () => {
    const receipt = sourceReceipt(creditedRow(), { ledger });
    setup({ dataset: [], retryReceipts: [receipt] });
    expect(await run()).toBe('idle');
    expect(settlerUpserts()).toHaveLength(0);
    expect(mockRpc.mock.calls.map((c) => c[0])).toEqual([
      'fn_retry_cash_accounting_sources',
      'fn_rakeback_recompute_periods',
    ]);
  });
  it('a retry RPC transport failure holds the cursor before fetching new source', async () => {
    mockRpc.mockResolvedValue({ data: null, error: { message: 'retry unavailable' } });
    expect(await run()).toBe('halted');
    expect(rakeFetches()).toHaveLength(0);
    expect(settlerUpserts()).toHaveLength(0);
  });
  it.each([{ is_tournament: true }, { tournament_id: uid(777) }])(
    'leaves terminal tournament accounting to its existing writer %j',
    async (flag) => {
      setup({ dataset: [{ ...creditedRow(), ...flag }] });
      expect(await run()).toBe('more');
      expect(mockRpc.mock.calls.map((c) => c[0])).toEqual(['fn_retry_cash_accounting_sources']);
      expect(settlerUpserts()).toHaveLength(1);
    }
  );
  it('leaves both tournament markers to terminal settlement while processing a mixed page', async () => {
    setup({
      dataset: [
        creditedRow(),
        { ...row(2, 201), is_tournament: true },
        { ...row(3, 202), tournament_id: uid(777) },
      ],
    });
    expect(await run()).toBe('more');
    const batches = mockRpc.mock.calls.filter(
      ([name]) => name === 'fn_credit_agent_commissions_batch'
    );
    expect(batches).toEqual([
      [
        'fn_credit_agent_commissions_batch',
        {
          p_items: [{ source_type: 'cash_rake_record', source_id: uid(1) }],
        },
      ],
    ]);
    expect(mockRpc.mock.calls.map(([name]) => name)).toEqual([
      'fn_retry_cash_accounting_sources',
      'fn_credit_agent_commissions_batch',
      'fn_rakeback_recompute_periods',
    ]);
    expect(settlerUpserts()).toHaveLength(1);
    expect(upsertPayload(settlerUpserts()[0]).high_water_mark_id).toBe(uid(3));
  });
  it('assigns early UTC Monday cash to the Pacific week that is still open', async () => {
    install({
      settlerState: { high_water_mark: '2026-09-14T06:00:00Z', high_water_mark_id: uid(0) },
      dataset: [{ ...creditedRow(), created_at: '2026-09-14T06:59:59.999999Z' }],
      ledger: [
        {
          id: uid(100),
          hand_id: uid(77),
          player_id: uid(42),
          weighted_rake_credit: 1,
          club_id: uid(55),
          rake_record_id: uid(1),
        },
      ],
    });
    expect(await run()).toBe('more');
    const period = mockRpc.mock.calls.find(
      (call) => call[0] === 'fn_rakeback_recompute_periods'
    )![1];
    expect(period.p_period_start).toBe('2026-09-07');
    expect(period.p_period_end).toBe('2026-09-13');
  });
  it.each([
    null,
    {},
    { written: '1' },
    { written: -1 },
    { written: 0.5 },
    { written: 2 },
    { written: 0, error: 'missing params' },
    { written: 0, status: 'needs_reconciliation' },
    { written: 0, failed: 1 },
    [{ written: 1 }, { written: 1 }],
  ])('retains the source page for an invalid period receipt %j', async (data) => {
    mockRpc.mockImplementation(async (name, args) =>
      name === 'fn_rakeback_recompute_periods' ? { data, error: null } : success(name, args)
    );
    expect(await run()).toBe('halted');
    expect(settlerUpserts()).toHaveLength(0);
  });
  it.each([
    { accounting_version: 1 },
    { status: 'blocked' },
    { confirmed_players: 0 },
    { club_id: uid(99) },
    { period_start: '2026-08-10' },
    { period_end: '2026-08-16' },
  ])('retains the page when canonical period confirmation mismatches %j', async (mismatch) => {
    mockRpc.mockImplementation(async (name, args) =>
      name === 'fn_rakeback_recompute_periods'
        ? { data: { ...success(name, args).data, ...mismatch }, error: null }
        : success(name, args)
    );
    expect(await run()).toBe('halted');
    expect(settlerUpserts()).toHaveLength(0);
  });
  const deferred = {
    accounting_version: 2,
    club_id: uid(55),
    period_start: '2026-08-03',
    period_end: '2026-08-09',
    written: 0,
    status: 'blocked',
    reason: 'historical_week_before_observed_source_cutover',
    request_id: uid(950),
    requested_at: '2026-09-14T13:45:00.123456Z',
    request_state: 'blocked',
    request_recorded: true,
  };
  const durableQueue = { id: deferred.request_id, status: 'blocked', last_result: deferred };
  const installQueue = (
    periodQueue: Record<string, unknown> | null,
    periodQueueError?: { message: string }
  ) =>
    install({
      settlerState: { high_water_mark: ts(100), high_water_mark_id: uid(0) },
      dataset: [creditedRow()],
      ledger: [
        {
          id: uid(100),
          hand_id: uid(77),
          player_id: uid(42),
          weighted_rake_credit: 1,
          club_id: uid(55),
          rake_record_id: uid(1),
        },
      ],
      periodQueue,
      periodQueueError,
    });
  it('advances only the source cursor when a blocked period has a verified durable request', async () => {
    installQueue(durableQueue);
    mockRpc.mockImplementation(async (name, args) =>
      name === 'fn_rakeback_recompute_periods'
        ? { data: deferred, error: null }
        : success(name, args)
    );
    expect(await run()).toBe('more');
    expect(settlerUpserts()).toHaveLength(1);
    const query = recorded.find((r) => r.table === 'accounting_period_recompute_requests')!;
    expect(query.ops).toContainEqual(['eq', ['id', deferred.request_id]]);
    expect(query.ops).toContainEqual(['eq', ['club_id', uid(55)]]);
    expect(query.ops).toContainEqual(['eq', ['period_start', deferred.period_start]]);
    expect(query.ops).toContainEqual(['eq', ['period_end', deferred.period_end]]);
    expect(query.ops).toContainEqual(['eq', ['requested_at', deferred.requested_at]]);
  });
  it.each([
    null,
    {},
    { ...durableQueue, id: uid(999) },
    { ...durableQueue, status: 'complete' },
    { ...durableQueue, last_result: { ...deferred, reason: 'another reason' } },
  ])('retains the source when deferred request read-back does not confirm it %j', async (row) => {
    installQueue(row);
    mockRpc.mockImplementation(async (name, args) =>
      name === 'fn_rakeback_recompute_periods'
        ? { data: deferred, error: null }
        : success(name, args)
    );
    expect(await run()).toBe('halted');
    expect(settlerUpserts()).toHaveLength(0);
  });
  it('retains the source when durable request read-back fails', async () => {
    installQueue(durableQueue, { message: 'read timeout' });
    mockRpc.mockImplementation(async (name, args) =>
      name === 'fn_rakeback_recompute_periods'
        ? { data: deferred, error: null }
        : success(name, args)
    );
    expect(await run()).toBe('halted');
    expect(settlerUpserts()).toHaveLength(0);
  });
});

/**
 * A TIMEOUT IS NOT A FAILURE (2026-09-26). fn_rakeback_recompute_periods for
 * one live club-week ran ~71 s against a 15 s client: the server committed every
 * time and the settler held its watermark every time (attempts=531). The client
 * now reads the durable request row before deciding, and accepts ONLY a receipt
 * written by this call - never an older one, never a refusal.
 */
describe('a timed-out period recompute reads its durable receipt', () => {
  const T0 = Date.parse('2026-08-06T20:00:01.000Z');
  /** When the fake server's transaction commits, relative to T0 (the live warm cost). */
  const COMMIT_AT = T0 + 71_000;
  const pgInstant = (ms: number) => new Date(ms).toISOString().replace('Z', '456+00:00');
  const clubId = uid(55);
  const credited = () => ({
    ...row(1, 200),
    hand_id: uid(77),
    player_contributions: { [uid(42)]: 10 },
  });
  const week = pacificAccountingWeek(ts(200));
  const readyReceipt = (players: number) => ({
    written: players,
    accounting_version: 2,
    confirmed_players: players,
    status: 'ready',
    club_id: clubId,
    period_start: week.periodStart,
    period_end: week.periodEnd,
  });
  const requestRow = (over: Record<string, unknown>) => ({
    club_id: clubId,
    period_start: week.periodStart,
    period_end: week.periodEnd,
    status: 'pending',
    attempts: 531,
    attempted_at: pgInstant(T0 - 60_000),
    last_result: {},
    ...over,
  });
  const timeout = { message: 'Error: supabase_timeout', details: '', hint: '', code: '' };
  let reads = 0;
  const setup = (periodQueueRead: () => Record<string, unknown> | null) => {
    reads = 0;
    install({
      settlerState: { high_water_mark: ts(100), high_water_mark_id: uid(0) },
      dataset: [credited()],
      ledger: [
        {
          id: uid(100),
          hand_id: uid(77),
          player_id: uid(42),
          club_id: clubId,
          rake_record_id: uid(1),
          weighted_rake_credit: 1,
        },
      ],
      periodQueueRead: () => {
        reads++;
        return periodQueueRead();
      },
    });
  };
  const recomputeTimesOut = (error: Record<string, unknown> | 'throw' = timeout) =>
    mockRpc.mockImplementation(async (name, args) => {
      if (name !== 'fn_rakeback_recompute_periods') return success(name, args);
      if (error === 'throw') throw new Error('supabase_timeout');
      return { data: null, error };
    });
  /** Step the fake clock so every readback pause and its microtasks run. */
  const runFor = async (ms: number) => {
    const settler = new RakebackSettlerService();
    const outcome = (
      settler as unknown as { _runSettlementInner(): Promise<string> }
    )._runSettlementInner();
    for (let t = 0; t < ms; t += 1_000) await vi.advanceTimersByTimeAsync(1_000);
    return outcome;
  };
  const held = () => {
    expect(settlerUpserts()).toHaveLength(0);
    expect(scenario.current.durableCursor).toEqual({
      high_water_mark: ts(100),
      high_water_mark_id: uid(0),
    });
    expect(
      mockReportError.mock.calls.some(
        ([, label]) => label === 'RakebackSettler.period_recompute_failures_hold_cursor'
      )
    ).toBe(true);
  };
  beforeEach(() => {
    recorded.length = 0;
    mockFrom.mockClear();
    mockRpc.mockReset();
    mockReportError.mockReset();
    vi.useFakeTimers();
    vi.setSystemTime(new Date(T0));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([['error', timeout] as const, ['throw', 'throw'] as const])(
    'accepts the receipt this call committed after the client gave up (%s) and advances the watermark',
    async (_kind, error) => {
      setup(() =>
        Date.now() < COMMIT_AT
          ? requestRow({})
          : requestRow({
              attempted_at: pgInstant(COMMIT_AT),
              attempts: 532,
              last_result: readyReceipt(1),
            })
      );
      recomputeTimesOut(error);
      expect(await runFor(90_000)).toBe('more');
      expect(scenario.current.durableCursor).toEqual({
        high_water_mark: ts(200),
        high_water_mark_id: uid(1),
      });
      expect(
        mockReportError.mock.calls.some(([, label]) =>
          String(label).startsWith('RakebackSettler.period_recompute')
        )
      ).toBe(false);
      const readback = recorded.filter((r) => r.table === 'accounting_period_recompute_requests');
      expect(readback.length).toBeGreaterThan(1);
      for (const q of readback) {
        expect(q.ops).toContainEqual(['eq', ['club_id', clubId]]);
        expect(q.ops).toContainEqual(['eq', ['period_start', week.periodStart]]);
        expect(q.ops).toContainEqual(['eq', ['period_end', week.periodEnd]]);
      }
    }
  );

  it("never mistakes an earlier attempt's ready receipt for this call, and holds the watermark", async () => {
    // Exactly the live shape: the row says ready, from a call made before this one.
    setup(() => requestRow({ attempted_at: pgInstant(T0 - 1), last_result: readyReceipt(1) }));
    recomputeTimesOut();
    expect(await runFor(330_000)).toBe('halted');
    held();
    const stopped = reads;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(reads, 'the readback is bounded by the server budget, not a loop').toBe(stopped);
  });

  it('holds the watermark when no receipt row exists by the server deadline', async () => {
    setup(() => null);
    recomputeTimesOut();
    expect(await runFor(330_000)).toBe('halted');
    held();
  });

  it.each([
    [
      'a blocked refusal',
      {
        status: 'blocked',
        last_result: { ...readyReceipt(0), status: 'blocked', written: 0, reason: 'boom' },
      },
    ],
    ['a receipt another writer cleared', { status: 'pending', last_result: {} }],
    [
      'a whole-period result from another caller',
      { status: 'complete', last_result: readyReceipt(1) },
    ],
    ['a receipt for a different player count', { status: 'pending', last_result: readyReceipt(2) }],
  ])('holds the watermark on a fresh but genuine failure receipt: %s', async (_label, over) => {
    setup(() =>
      Date.now() < COMMIT_AT
        ? requestRow({})
        : requestRow({ attempted_at: pgInstant(COMMIT_AT), ...over })
    );
    recomputeTimesOut();
    expect(await runFor(90_000)).toBe('halted');
    held();
  });

  it('does not read back a definite server error, which rolled back', async () => {
    setup(() => requestRow({ attempted_at: pgInstant(COMMIT_AT), last_result: readyReceipt(1) }));
    recomputeTimesOut({ message: 'canceling statement due to statement timeout', code: '57014' });
    expect(await runFor(5_000)).toBe('halted');
    expect(reads).toBe(0);
    held();
  });
});

describe('the catch-up re-arms while backlog remains', () => {
  const drive = async (results: string[]) => {
    const settler = new RakebackSettlerService();
    const inner = vi.spyOn(settler as any, '_runSettlementInner');
    for (const r of results) inner.mockResolvedValueOnce(r);
    for (const method of [
      'runWeeklyFinancialClose',
      'runTournamentSentinel',
      'runUnionTreasurySentinel',
      'runUnionGovernanceSentinel',
      'runUnionRakeRollupCatchup',
      'runUnionEcoRecord',
      'runTournamentChipConservation',
    ] as const)
      vi.spyOn(settler as any, method).mockResolvedValue(undefined);
    const schedule = vi.spyOn(settler as any, 'scheduleCatchUp');
    await settler.runSettlement();
    return { inner, backlog: schedule.mock.calls.map(([backlog]) => backlog) };
  };

  it('arms after a cycle that made progress and then halted with the rest still owed', async () => {
    const { inner, backlog } = await drive(['more', 'halted']);
    expect(inner).toHaveBeenCalledTimes(2);
    expect(backlog).toEqual([true]);
  });

  it('arms when the drain cap is reached', async () => {
    const { backlog } = await drive(Array(MAX_DRAIN_BATCHES).fill('more'));
    expect(backlog).toEqual([true]);
  });

  it('does not arm after a halt with no progress, so a persistent failure waits the interval', async () => {
    expect((await drive(['halted'])).backlog).toEqual([false]);
  });

  it('does not arm once the range is empty', async () => {
    expect((await drive(['more', 'idle'])).backlog).toEqual([false]);
  });
});
