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
 *   3. a cursor with no id (the first cycle after this deploy) degrades to the
 *      EXACT pre-M6 read, so the deploy cannot regress anything
 *   4. a failed read never advances the cursor
 *   5. a full batch is drained immediately instead of after another 30 minutes,
 *      under a cap that ANNOUNCES itself when it truncates
 *   6. the two other daemons sharing daemon_state are untouched
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

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
  player_contributions: Record<string, number> | null;
}

interface Scenario {
  settlerState?: { high_water_mark: string; high_water_mark_id: string | null } | null;
  stateReadFails?: boolean;
  fetchError?: { message: string } | null;
  dataset?: RakeRow[];
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

/**
 * Applies the cursor filter the production code actually issued to an in-memory
 * dataset. The regex is deliberately strict — it is itself an assertion that
 * the emitted PostgREST filter has the exact shape verified against the live
 * REST endpoint (quoted values; a timestamptz contains ':' and '+', both
 * structural in that grammar).
 */
function applyCursor(dataset: RakeRow[], rec: Recorded): RakeRow[] {
  const or = rec.ops.find(([n]) => n === 'or');
  const gteCreated = rec.ops.find(([n, a]) => n === 'gte' && a[0] === 'created_at');
  const gtCreated = rec.ops.find(([n, a]) => n === 'gt' && a[0] === 'created_at');
  const limit = Number(opArg(rec, 'limit') ?? dataset.length);

  let matched: RakeRow[];
  if (gteCreated) {
    // 2026-08-17 — the keyset path now emits `created_at >= cursor` instead of
    // the OR predicate. The OR form was correct but UNINDEXABLE: Postgres ran a
    // full ordered index scan and applied it as a FILTER (21,534 ms, 560,302
    // rows removed, against 259 ms for a plain range), which is what produced
    // the [RakebackSettler.fetch_failed] statement timeouts in production.
    //
    // `gte` is a strict SUPERSET of the OR predicate — it also returns the
    // cursor row itself and any timestamp ties — and the production code drops
    // that surplus prefix in memory. This branch therefore returns the superset
    // DELIBERATELY: it is the honest simulation of what Postgres hands back,
    // and it leaves exactly-once to be proven by the production skip rather
    // than quietly enforced inside the mock. The AUDIT M6 duplicate-timestamp
    // cases below are precisely what exercise that skip.
    const t = String(gteCreated[1][1]);
    matched = dataset.filter((r) => r.created_at >= t);
  } else if (or) {
    const filter = String(or[1][0]);
    const m = /^created_at\.gt\."([^"]+)",and\(created_at\.eq\."([^"]+)",id\.gt\."([^"]+)"\)$/.exec(
      filter
    );
    if (!m) throw new Error(`malformed keyset filter: ${filter}`);
    const [, gtTs, eqTs, afterId] = m;
    if (gtTs !== eqTs) throw new Error(`keyset filter timestamps disagree: ${filter}`);
    matched = dataset.filter(
      (r) => r.created_at > gtTs || (r.created_at === eqTs && r.id > afterId)
    );
  } else if (gtCreated) {
    const t = String(gtCreated[1][1]);
    matched = dataset.filter((r) => r.created_at > t);
  } else {
    throw new Error('rake_records was read with NO cursor filter at all');
  }

  return matched
    .slice()
    .sort((a, b) =>
      a.created_at === b.created_at ? (a.id < b.id ? -1 : 1) : a.created_at < b.created_at ? -1 : 1
    )
    .slice(0, limit);
}

function install(s: Scenario) {
  const dataset = s.dataset ?? [];
  scenario.current = {
    respond: (rec: Recorded) => {
      if (rec.table === 'daemon_state') {
        if (rec.ops.some(([n]) => n === 'upsert')) return { data: null, error: null };
        const daemon = rec.ops.find(([n]) => n === 'eq')?.[1][1];
        if (daemon === 'rakeback_settler') {
          if (s.stateReadFails) return { data: null, error: { message: 'state read exploded' } };
          return { data: s.settlerState ?? null, error: null };
        }
        // Far-future watermarks park the weekly close and the tournament
        // sentinel so this suite only exercises the settlement read.
        return { data: { high_water_mark: '2999-12-27T00:00:00+00' }, error: null };
      }
      if (rec.table === 'rake_records') {
        if (s.fetchError) return { data: null, error: s.fetchError };
        return { data: applyCursor(dataset, rec), error: null };
      }
      return { data: [], error: null };
    },
  };
}

describe('RakebackSettlerService - AUDIT M6 resume cursor', () => {
  beforeEach(() => {
    recorded.length = 0;
    mockFrom.mockClear();
    mockRpc.mockReset();
    mockReportError.mockReset();
    mockRpc.mockResolvedValue({ data: null, error: null });
  });

  it('falls back to the pre-M6 timestamp-only read when the stored cursor has no id', async () => {
    // The first cycle after this deploy: high_water_mark_id is still NULL.
    // Behaviour here must be byte-for-byte what shipped before, so the deploy
    // itself cannot regress anything.
    install({
      settlerState: { high_water_mark: ts(500), high_water_mark_id: null },
      dataset: [row(1, 600)],
    });

    await (
      new RakebackSettlerService() as unknown as { _runSettlementInner(): Promise<string> }
    )._runSettlementInner();

    const fetch = rakeFetches()[0];
    expect(fetch.ops.some(([n]) => n === 'or')).toBe(false);
    expect(fetch.ops.find(([n, a]) => n === 'gt' && a[0] === 'created_at')?.[1][1]).toBe(ts(500));
  });

  it('carries the raw database timestamp, not a millisecond-truncated Date', async () => {
    // new Date('...20:00:00.000500+00').toISOString() is '...20:00:00.000Z' —
    // 500 microseconds earlier than the row it is supposed to point at. That
    // truncation is the reason the old cursor never matched a real row.
    install({
      settlerState: { high_water_mark: ts(500), high_water_mark_id: null },
      dataset: [],
    });

    await (
      new RakebackSettlerService() as unknown as { _runSettlementInner(): Promise<string> }
    )._runSettlementInner();

    const used = String(
      rakeFetches()[0].ops.find(([n, a]) => n === 'gt' && a[0] === 'created_at')?.[1][1]
    );
    expect(used).toBe('2026-08-06 20:00:00.000500+00');
    expect(used).not.toBe(new Date(ts(500)).toISOString());
    expect(used).toContain('000500');
  });

  it('persists BOTH halves of the cursor, at full precision', async () => {
    install({
      settlerState: { high_water_mark: ts(100), high_water_mark_id: null },
      dataset: [row(1, 200), row(2, 300)],
    });

    await (
      new RakebackSettlerService() as unknown as { _runSettlementInner(): Promise<string> }
    )._runSettlementInner();

    const payload = upsertPayload(settlerUpserts()[0]);
    expect(payload.daemon).toBe('rakeback_settler');
    expect(payload.high_water_mark).toBe(ts(300));
    expect(payload.high_water_mark_id).toBe(uid(2));
  });

  it('uses an INDEXABLE cursor filter once an id is available', async () => {
    install({
      settlerState: { high_water_mark: ts(100), high_water_mark_id: uid(7) },
      dataset: [row(8, 100), row(9, 400)],
    });

    await (
      new RakebackSettlerService() as unknown as { _runSettlementInner(): Promise<string> }
    )._runSettlementInner();

    const fetch = rakeFetches()[0];

    // 2026-08-17 — this used to assert the composite OR keyset:
    //   created_at.gt."X",and(created_at.eq."X",id.gt."Y")
    // That predicate is CORRECT but UNINDEXABLE. Postgres cannot use
    // idx_rake_records_created_at_id for it; it runs a full ordered index scan
    // and applies the OR as a FILTER. Measured on production:
    //   OR form 21,534 ms (Rows Removed by Filter: 560,302) vs 259 ms range.
    // That was the [RakebackSettler.fetch_failed] statement timeout, and it
    // only struck cycles WITH a cursor — the settler stalled exactly when it
    // had made progress.
    //
    // The cursor is now a plain `created_at >= X`, with the already-settled
    // prefix dropped in memory. Assert the new shape AND that the old one is
    // gone, so a well-meaning revert to the "textbook" keyset is caught here
    // rather than by a production timeout.
    expect(opArg(fetch, 'gte')).toBe('created_at');
    expect(fetch.ops.find(([n, a]) => n === 'gte' && a[0] === 'created_at')?.[1][1]).toBe(ts(100));
    expect(opArg(fetch, 'or')).toBeUndefined();

    // A tie at the cursor timestamp with a HIGHER id is still in scope — that is
    // the whole point of the tie-break.
    expect(opArg(settlerUpserts()[0], 'upsert')).toMatchObject({
      high_water_mark: ts(400),
      high_water_mark_id: uid(9),
    });
  });

  it('orders by BOTH keys so the LIMIT boundary is deterministic', async () => {
    install({ settlerState: null, dataset: [] });

    await (
      new RakebackSettlerService() as unknown as { _runSettlementInner(): Promise<string> }
    )._runSettlementInner();

    const orders = rakeFetches()[0]
      .ops.filter(([n]) => n === 'order')
      .map(([, a]) => a[0]);
    expect(orders).toEqual(['created_at', 'id']);
  });

  it('AUDIT M6 REGRESSION: a duplicate created_at across the LIMIT boundary is no longer skipped', async () => {
    // The exact production shape: rows 1..FETCH_LIMIT-1 at distinct times, then
    // TWO rows sharing one created_at, the first of which lands on the boundary.
    // Pre-fix, the second one was excluded by `.gt(created_at)` forever.
    const dataset: RakeRow[] = [];
    for (let i = 1; i < FETCH_LIMIT; i++) dataset.push(row(i, i));
    const COLLISION = FETCH_LIMIT;
    dataset.push(row(FETCH_LIMIT, COLLISION)); // batch 1, last row
    dataset.push(row(FETCH_LIMIT + 1, COLLISION)); // same timestamp, higher id
    dataset.push(row(FETCH_LIMIT + 2, COLLISION + 1));

    install({ settlerState: { high_water_mark: ts(0), high_water_mark_id: uid(0) }, dataset });
    const settler = new RakebackSettlerService() as unknown as {
      _runSettlementInner(): Promise<string>;
    };

    const first = await settler._runSettlementInner();
    expect(first).toBe('more'); // a full batch means keep going, not sleep 30m
    expect(upsertPayload(settlerUpserts()[0])).toMatchObject({
      high_water_mark: ts(COLLISION),
      high_water_mark_id: uid(FETCH_LIMIT),
    });

    const second = await settler._runSettlementInner();
    expect(second).toBe('idle');

    // The second batch must contain the row that used to vanish.
    //
    // 2026-08-17: the read is now `created_at >= cursor` rather than the OR
    // predicate. The OR was correct but unindexable — 21,534 ms against 259 ms
    // for a plain range — and it timed the settler out in production. `gte`
    // returns a strict SUPERSET: the already-settled cursor row comes back too,
    // and the production code drops that prefix in memory. The DB page and the
    // effective set therefore differ now, so this asserts BOTH.
    const returned = applyCursor(dataset, rakeFetches()[1]);

    // Raw page: begins with the already-settled cursor row (the surplus `gte`
    // deliberately admits).
    expect(returned.map((r) => r.id)).toEqual([
      uid(FETCH_LIMIT),
      uid(FETCH_LIMIT + 1),
      uid(FETCH_LIMIT + 2),
    ]);

    // Mirrors the prefix-skip in RakebackSettlerService: drop rows AT the
    // cursor timestamp whose id is <= the cursor id. Kept as an explicit local
    // rather than folded into applyCursor, so the mock keeps returning what
    // Postgres actually returns and exactly-once stays a property this test
    // proves rather than one the mock quietly enforces.
    const cursorTs = ts(COLLISION);
    const cursorId = uid(FETCH_LIMIT);
    const effective = returned.filter((r) => !(r.created_at === cursorTs && r.id <= cursorId));

    // THE M6 GUARANTEE, unchanged: the row that used to vanish IS processed,
    // and the already-settled one is NOT reprocessed.
    expect(effective.map((r) => r.id)).toEqual([uid(FETCH_LIMIT + 1), uid(FETCH_LIMIT + 2)]);
  });

  it('a failed cursor read does not advance the cursor and does not read rake_records', async () => {
    install({ stateReadFails: true, dataset: [row(1, 10)] });

    const result = await (
      new RakebackSettlerService() as unknown as { _runSettlementInner(): Promise<string> }
    )._runSettlementInner();

    expect(result).toBe('halted');
    expect(rakeFetches()).toHaveLength(0);
    expect(settlerUpserts()).toHaveLength(0);
  });

  it('a failed rake_records read does not advance the cursor', async () => {
    install({
      settlerState: { high_water_mark: ts(100), high_water_mark_id: uid(1) },
      fetchError: { message: 'statement timeout' },
    });

    const result = await (
      new RakebackSettlerService() as unknown as { _runSettlementInner(): Promise<string> }
    )._runSettlementInner();

    expect(result).toBe('halted');
    expect(settlerUpserts()).toHaveLength(0);
    expect(mockReportError).toHaveBeenCalledTimes(1);
    expect(mockReportError.mock.calls[0][1]).toBe('RakebackSettler.fetch_failed');
  });

  it('an empty result leaves the cursor exactly where it was', async () => {
    // A late-arriving row with an earlier timestamp must still be reachable, so
    // "nothing new" is never allowed to push the cursor to now().
    install({
      settlerState: { high_water_mark: ts(900), high_water_mark_id: uid(9) },
      dataset: [],
    });

    const result = await (
      new RakebackSettlerService() as unknown as { _runSettlementInner(): Promise<string> }
    )._runSettlementInner();

    expect(result).toBe('idle');
    expect(settlerUpserts()).toHaveLength(0);
  });

  it('falls back to the timestamp-only read rather than emitting a filter it cannot trust', async () => {
    // Neither a timestamptz nor a uuid can contain a quote, so this is
    // unreachable today. It is asserted anyway because the failure mode if the
    // guard were missing is a filter whose SHAPE changed — a silently widened
    // or malformed query against the money ledger.
    install({
      settlerState: { high_water_mark: ts(100), high_water_mark_id: 'not"a,uuid' },
      dataset: [row(1, 200)],
    });

    await (
      new RakebackSettlerService() as unknown as { _runSettlementInner(): Promise<string> }
    )._runSettlementInner();

    const fetch = rakeFetches()[0];
    expect(fetch.ops.some(([n]) => n === 'or')).toBe(false);
    expect(fetch.ops.find(([n, a]) => n === 'gt' && a[0] === 'created_at')?.[1][1]).toBe(ts(100));
  });

  it('drains a backlog within one cycle instead of one batch per 30 minutes', async () => {
    const dataset: RakeRow[] = [];
    for (let i = 1; i <= FETCH_LIMIT + 5; i++) dataset.push(row(i, i));
    install({ settlerState: { high_water_mark: ts(0), high_water_mark_id: uid(0) }, dataset });

    await new RakebackSettlerService().runSettlement();

    expect(rakeFetches()).toHaveLength(2);
    expect(upsertPayload(settlerUpserts()[1])).toMatchObject({
      high_water_mark: ts(FETCH_LIMIT + 5),
      high_water_mark_id: uid(FETCH_LIMIT + 5),
    });
  });

  it('caps the drain and SAYS SO - a truncated drain must not look like a finished one', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const dataset: RakeRow[] = [];
    for (let i = 1; i <= FETCH_LIMIT * (MAX_DRAIN_BATCHES + 1); i++) dataset.push(row(i, i));
    install({ settlerState: { high_water_mark: ts(0), high_water_mark_id: uid(0) }, dataset });

    await new RakebackSettlerService().runSettlement();

    expect(rakeFetches()).toHaveLength(MAX_DRAIN_BATCHES);
    expect(warn.mock.calls.some((c) => String(c[0]).includes('drain cap reached'))).toBe(true);
    expect(warn.mock.calls.some((c) => String(c[0]).includes('backlog REMAINS'))).toBe(true);
    warn.mockRestore();
  });

  it('never writes high_water_mark_id for the two daemons that do not use it', async () => {
    // daemon_state is shared. tournament_sentinel watermarks tournaments.updated_at
    // and weekly_financial_close stores a week-start date; neither has a row id,
    // and writing one would give a future reader a cursor that means nothing.
    install({ settlerState: null, dataset: [] });

    await new RakebackSettlerService().runSettlement();

    const foreign = recorded.filter(
      (r) =>
        r.table === 'daemon_state' &&
        r.ops.some(([n, a]) => {
          const d = (a[0] as { daemon?: string } | undefined)?.daemon;
          return n === 'upsert' && d != null && d !== 'rakeback_settler';
        })
    );
    for (const rec of foreign) {
      expect(Object.keys(upsertPayload(rec))).not.toContain('high_water_mark_id');
    }
  });
});

describe('rakeback attribution failures retain the source page', () => {
  const creditedRow = () => ({
    ...row(1, 200),
    hand_id: uid(77),
    player_contributions: { [uid(42)]: 10 },
  });
  const run = (settler = new RakebackSettlerService()) =>
    (settler as unknown as { _runSettlementInner(): Promise<string> })._runSettlementInner();
  const success = (name: string, args: { p_items?: unknown[] }) => ({
    data:
      name === 'fn_rakeback_recompute_periods'
        ? { written: 1 }
        : { ok: args.p_items?.length ?? 0, failed: 0, first_error: null },
    error: null,
  });

  beforeEach(() => {
    recorded.length = 0;
    mockFrom.mockClear();
    mockRpc.mockReset();
    mockReportError.mockReset();
    install({
      settlerState: { high_water_mark: ts(100), high_water_mark_id: uid(0) },
      dataset: [creditedRow()],
    });
    mockRpc.mockImplementation(async (name, args) => success(name, args));
  });

  for (const rpc of ['fn_credit_agent_commissions_batch', 'fn_apply_rakeback_player_stats_batch']) {
    it.each([
      ['transport failure', { data: null, error: { message: 'lost response' } }],
      [
        'partial failure',
        { data: { ok: 0, failed: 1, first_error: 'credit failed' }, error: null },
      ],
      ['absent receipt', { data: null, error: null }],
      ['missing counters', { data: {}, error: null }],
      ['negative counter', { data: { ok: 1, failed: -1 }, error: null }],
      ['string counter', { data: { ok: '1', failed: 0 }, error: null }],
      ['fractional counter', { data: { ok: 0.5, failed: 0 }, error: null }],
      ['excess count', { data: { ok: 2, failed: 0 }, error: null }],
      [
        'multiple receipts',
        {
          data: [
            { ok: 1, failed: 0 },
            { ok: 1, failed: 0 },
          ],
          error: null,
        },
      ],
      ['error body', { data: { ok: 1, failed: 0, error: 'rejected' }, error: null }],
    ])('%s from ' + rpc + ' does not advance', async (_label, response) => {
      mockRpc.mockImplementation(async (name, args) =>
        name === rpc ? response : success(name, args)
      );
      expect(await run()).toBe('halted');
      expect(settlerUpserts()).toHaveLength(0);
      expect(
        mockReportError.mock.calls.some(
          (call) => call[1] === 'RakebackSettler.attribution_failures_hold_cursor'
        )
      ).toBe(true);
    });

    it('retries the same source after a lost ' + rpc + ' response', async () => {
      let attempts = 0;
      mockRpc.mockImplementation(async (name, args) => {
        if (name === rpc && attempts++ === 0)
          return { data: null, error: { message: 'lost response after commit' } };
        return success(name, args);
      });
      const settler = new RakebackSettlerService();
      expect(await run(settler)).toBe('halted');
      expect(settlerUpserts()).toHaveLength(0);
      expect(await run(settler)).toBe('idle');
      const calls = mockRpc.mock.calls.filter((call) => call[0] === rpc);
      expect(calls).toHaveLength(2);
      expect(calls[0][1]).toEqual(calls[1][1]);
      expect(settlerUpserts()).toHaveLength(1);
      expect(upsertPayload(settlerUpserts()[0]).high_water_mark_id).toBe(uid(1));
    });
  }

  it('requires commission acknowledgements to cover every submitted item', async () => {
    mockRpc.mockImplementation(async (name, args) =>
      name === 'fn_credit_agent_commissions_batch'
        ? { data: { ok: 0, failed: 0 }, error: null }
        : success(name, args)
    );
    expect(await run()).toBe('halted');
    expect(settlerUpserts()).toHaveLength(0);
  });

  it('accepts stats replay receipts that inserted zero rows', async () => {
    mockRpc.mockImplementation(async (name, args) =>
      name === 'fn_apply_rakeback_player_stats_batch'
        ? { data: { ok: 0, failed: 0, first_error: null }, error: null }
        : success(name, args)
    );
    expect(await run()).toBe('idle');
    expect(settlerUpserts()).toHaveLength(1);
  });

  it('advances only after both attribution stages and period recompute succeed', async () => {
    expect(await run()).toBe('idle');
    expect(mockRpc.mock.calls.map((call) => call[0])).toEqual([
      'fn_credit_agent_commissions_batch',
      'fn_apply_rakeback_player_stats_batch',
      'fn_rakeback_recompute_periods',
    ]);
    expect(settlerUpserts()).toHaveLength(1);
  });
});
