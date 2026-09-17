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
  tournament_id?: string | null;
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
    is_tournament: true,
    // Paging-only scenarios use tournament rows owned by terminal settlement.
    // Positive cash sources are exercised below and always require v3 proof.
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

describe('canonical cash source receipts retain the source page until confirmed', () => {
  const creditedRow = (n = 1): RakeRow => ({
    ...row(n, 100 + n),
    is_tournament: false,
    hand_id: uid(10000 + n),
    player_contributions: { [uid(42)]: 10 },
  });
  const run = (settler = new RakebackSettlerService()) =>
    (settler as unknown as { _runSettlementInner(): Promise<string> })._runSettlementInner();
  const receipt = (id = uid(1)) => ({
    receipt_version: 3,
    receipt_id: uid(900),
    rake_record_id: id,
    earned_at: ts(101),
    hand_id: uid(10001),
    status: 'accrued',
    recorded: true,
    attempt: 1,
    source_fingerprint: 'a'.repeat(32),
    reason: null,
    credits: [
      {
        player_id: uid(42),
        club_id: uid(55),
        rake_credit: 1,
        period_start: '2026-08-03',
        period_end: '2026-08-09',
      },
    ],
  });
  const success = (ids = [uid(1)]) => ({
    data: {
      receipt_version: 3,
      ok: ids.length,
      failed: 0,
      blocked: 0,
      first_error: null,
      receipts: ids.map((id) => receipt(id)),
    },
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
    mockRpc.mockResolvedValue(success());
  });

  it.each([
    ['transport failure', { data: null, error: { message: 'lost response' } }],
    ['legacy unversioned no-op', { data: { ok: 1, failed: 0, first_error: null }, error: null }],
    ['legacy version', { data: { ...success().data, receipt_version: 1 }, error: null }],
    ['missing receipt', { data: null, error: null }],
    ['partial acknowledgement', { data: { ...success().data, receipts: [] }, error: null }],
    ['wrong source', success([uid(2)])],
    ['duplicate source', success([uid(1), uid(1)])],
    [
      'unrecorded source',
      { data: { ...success().data, receipts: [{ ...receipt(), recorded: false }] }, error: null },
    ],
    [
      'durable refusal',
      {
        data: {
          ...success().data,
          ok: 0,
          failed: 1,
          blocked: 1,
          first_error: 'source requires reconciliation',
          receipts: [
            {
              ...receipt(),
              status: 'blocked',
              reason: 'source requires reconciliation',
              credits: [],
            },
          ],
        },
        error: null,
      },
    ],
  ])('holds cash work on %s and never invokes legacy writers', async (_label, response) => {
    mockRpc.mockResolvedValue(response);
    expect(await run()).toBe('halted');
    expect(settlerUpserts()).toHaveLength(0);
    expect(mockRpc.mock.calls.map((call) => call[0])).toEqual([
      'fn_credit_agent_commissions_batch',
    ]);
    expect(
      mockReportError.mock.calls.some(
        (call) => call[1] === 'RakebackSettler.attribution_failures_hold_cursor'
      )
    ).toBe(true);
  });

  it('sends only exact source identities and advances after v3 without legacy stats or period writes', async () => {
    expect(await run()).toBe('idle');
    expect(mockRpc.mock.calls).toEqual([
      [
        'fn_credit_agent_commissions_batch',
        {
          p_items: [{ source_type: 'cash_rake_record', source_id: uid(1) }],
        },
      ],
    ]);
    expect(recorded.some((r) => r.table === 'rake_attributions')).toBe(false);
    expect(settlerUpserts()).toHaveLength(1);
    expect(upsertPayload(settlerUpserts()[0]).high_water_mark_id).toBe(uid(1));
  });

  it('does not hide a positive cash source with missing player-contribution metadata', async () => {
    install({
      settlerState: { high_water_mark: ts(100), high_water_mark_id: uid(0) },
      dataset: [{ ...creditedRow(), player_contributions: null }],
    });
    expect(await run()).toBe('idle');
    expect(rakeFetches()[0].ops.some(([name]) => name === 'not')).toBe(false);
    expect(mockRpc.mock.calls[0][1]).toEqual({
      p_items: [{ source_type: 'cash_rake_record', source_id: uid(1) }],
    });
  });

  it('leaves both tournament markers to terminal settlement while processing a mixed page', async () => {
    install({
      settlerState: { high_water_mark: ts(100), high_water_mark_id: uid(0) },
      dataset: [
        creditedRow(),
        { ...creditedRow(2), is_tournament: true },
        { ...creditedRow(3), tournament_id: uid(77) },
      ],
    });
    expect(await run()).toBe('idle');
    expect(mockRpc.mock.calls).toEqual([
      [
        'fn_credit_agent_commissions_batch',
        {
          p_items: [{ source_type: 'cash_rake_record', source_id: uid(1) }],
        },
      ],
    ]);
    expect(upsertPayload(settlerUpserts()[0]).high_water_mark_id).toBe(uid(3));
  });

  it('holds the same source across a delayed old response and accepts its later canonical receipt', async () => {
    let release!: (value: unknown) => void;
    mockRpc.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        })
    );
    const settler = new RakebackSettlerService();
    const pending = run(settler);
    await vi.waitFor(() => expect(mockRpc).toHaveBeenCalledOnce());
    release({ data: { ok: 1, failed: 0, first_error: null }, error: null });
    expect(await pending).toBe('halted');
    expect(settlerUpserts()).toHaveLength(0);
    expect(await run(settler)).toBe('idle');
    expect(mockRpc.mock.calls[0]).toEqual(mockRpc.mock.calls[1]);
    expect(mockRpc.mock.calls.map((call) => call[0])).toEqual([
      'fn_credit_agent_commissions_batch',
      'fn_credit_agent_commissions_batch',
    ]);
  });

  it('replays exact source IDs after a lost response without calling legacy downstream writers', async () => {
    mockRpc.mockResolvedValueOnce({ data: null, error: { message: 'lost response after commit' } });
    const settler = new RakebackSettlerService();
    expect(await run(settler)).toBe('halted');
    expect(await run(settler)).toBe('idle');
    expect(mockRpc.mock.calls[0]).toEqual(mockRpc.mock.calls[1]);
    expect(settlerUpserts()).toHaveLength(1);
  });

  it('joins an admitted canonical RPC before stop resolves and refuses new work after stop', async () => {
    let release!: (value: unknown) => void;
    mockRpc.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        })
    );
    const settler = new RakebackSettlerService();
    // Unrelated existing weekly/observer work is outside this cash source test.
    // The public launch, actual source read/dispatch/receipt and stop are real.
    for (const method of [
      'runUnionWeeklyRakeback',
      'runRakebackDrain',
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
    await vi.waitFor(() => expect(mockRpc).toHaveBeenCalledOnce());
    let stopped = false;
    const stop = settler.stop();
    void stop.then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    await settler.runSettlement();
    expect(mockRpc).toHaveBeenCalledOnce();
    release(success());
    await Promise.all([running, stop]);
    expect(stopped).toBe(true);
    expect(settlerUpserts()).toHaveLength(1);
    await settler.runSettlement();
    expect(mockRpc).toHaveBeenCalledOnce();
  });

  it('holds the page if a later chunk returns a legacy response across cutover', async () => {
    const dataset = Array.from({ length: 151 }, (_, n) => creditedRow(n + 1));
    install({ settlerState: { high_water_mark: ts(100), high_water_mark_id: uid(0) }, dataset });
    mockRpc.mockImplementation(async (_name, args) =>
      args.p_items.length === 150
        ? success(args.p_items.map((item: { source_id: string }) => item.source_id))
        : { data: { ok: 1, failed: 0, first_error: null }, error: null }
    );
    expect(await run()).toBe('halted');
    expect(settlerUpserts()).toHaveLength(0);
    expect(mockRpc.mock.calls.map((call) => call[0])).toEqual([
      'fn_credit_agent_commissions_batch',
      'fn_credit_agent_commissions_batch',
    ]);
  });

  it('retains memory and durable cursor when the acknowledged checkpoint write fails', async () => {
    const respond = scenario.current.respond as (r: Recorded) => unknown;
    let failed = false;
    scenario.current.respond = (r: Recorded) => {
      if (!failed && r.table === 'daemon_state' && r.ops.some(([name]) => name === 'upsert')) {
        failed = true;
        return { data: null, error: { message: 'checkpoint write unavailable' } };
      }
      return respond(r);
    };
    const settler = new RakebackSettlerService();
    expect(await run(settler)).toBe('halted');
    expect(await run(settler)).toBe('idle');
    expect(mockRpc.mock.calls[0]).toEqual(mockRpc.mock.calls[1]);
    expect(upsertPayload(settlerUpserts()[0])).toEqual(upsertPayload(settlerUpserts()[1]));
  });
});
