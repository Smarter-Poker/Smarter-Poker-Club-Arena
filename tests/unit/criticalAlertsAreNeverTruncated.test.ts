/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  A CRITICAL MONEY ALARM CANNOT BE PUSHED OFF THE SCREEN
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 2026-08-31. FinancialAlertService.getUnresolved was one query — unresolved,
 * newest first, `.limit(n)` — and the admin page asked for 100. Production had
 * 472 unresolved rows, so 372 never rendered, and TWO of the nine unresolved
 * CRITICALS were among them: union treasury conservation breaches from
 * 2026-08-21 and 08-24, unseen for ten days underneath four hundred newer
 * warnings.
 *
 * The page's severity tabs then counted client-side over that truncated
 * hundred, so "Critical (7)" was not the number of unresolved criticals, only
 * the number that survived the cut.
 *
 * These tests pin the two properties that failure violated:
 *   1. every unresolved critical is returned, however much newer noise exists;
 *   2. the counts are the DATABASE's, not the loaded page's.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── A supabase mock that actually honours the filters ────────────────────
// The real defect was in WHICH ROWS the query asked for, so a mock that
// ignores filters could not have caught it and cannot guard against it.

type Row = { id: string; severity: string; source: string; message: string; created_at: string };

let ROWS: Row[] = [];
const queries: Array<Record<string, unknown>> = [];

function makeQuery() {
  const state: {
    eqs: Record<string, unknown>;
    neqs: Record<string, unknown>;
    limit?: number;
    head?: boolean;
    desc?: boolean;
  } = { eqs: {}, neqs: {} };

  const run = () => {
    let rows = ROWS.filter((r) => {
      for (const [k, v] of Object.entries(state.eqs)) {
        if (k === 'resolved') continue; // every fixture row is unresolved
        if ((r as any)[k] !== v) return false;
      }
      for (const [k, v] of Object.entries(state.neqs)) {
        if ((r as any)[k] === v) return false;
      }
      return true;
    });
    rows = [...rows].sort((a, b) => b.created_at.localeCompare(a.created_at));
    const count = rows.length;
    if (state.limit != null) rows = rows.slice(0, state.limit);
    queries.push({ ...state.eqs, ...state.neqs, limit: state.limit, head: state.head });
    return state.head ? { count, data: null, error: null } : { data: rows, count, error: null };
  };

  const q: any = {
    select: (_cols: string, opts?: { count?: string; head?: boolean }) => {
      if (opts?.head) state.head = true;
      return q;
    },
    eq: (col: string, val: unknown) => {
      state.eqs[col] = val;
      return q;
    },
    neq: (col: string, val: unknown) => {
      state.neqs[col] = val;
      return q;
    },
    order: () => {
      state.desc = true;
      return q;
    },
    limit: (n: number) => {
      state.limit = n;
      return q;
    },
    // Awaiting the chain at any point runs it — which is how the head-count
    // query is written (no .order/.limit after the filters).
    then: (resolve: (v: unknown) => unknown) => Promise.resolve(run()).then(resolve),
  };
  return q;
}

vi.mock('../../src/lib/supabase', () => ({
  supabase: { from: () => makeQuery(), rpc: vi.fn() },
}));
vi.mock('../../src/core/MasterBus', () => ({
  masterBus: {
    emit: vi.fn(),
    subscribe: vi.fn(() => vi.fn()),
    subscribeDebounced: vi.fn(() => vi.fn()),
  },
}));
vi.mock('../../src/utils/retryAsync', () => ({ retryAsync: (fn: () => any) => fn() }));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: vi.fn() }));

import { FinancialAlertService } from '../../src/services/FinancialAlertService';

/** Production's shape on 2026-08-31: 9 criticals buried under 463 others. */
function productionShape(): Row[] {
  const rows: Row[] = [];
  // The two that were actually invisible: oldest of all, at ranks 463 and 471.
  rows.push({
    id: 'crit-treasury-0821',
    severity: 'critical',
    source: 'fn_union_treasury_selftest',
    message: 'Union treasury conservation breach: bbj_pool_conservation_drift',
    created_at: '2026-08-21T06:23:46.000Z',
  });
  rows.push({
    id: 'crit-treasury-0824',
    severity: 'critical',
    source: 'fn_union_treasury_selftest',
    message: 'Union treasury conservation breach: lapsed_week_unclosed',
    created_at: '2026-08-24T01:37:24.000Z',
  });
  // Seven recent criticals.
  for (let i = 0; i < 7; i++) {
    rows.push({
      id: `crit-recent-${i}`,
      severity: 'critical',
      source: 'fn_rake_bbj_audit',
      message: 'RAKE_BBJ_INVARIANT_VIOLATION',
      created_at: `2026-08-31T13:${String(30 + i).padStart(2, '0')}:00.000Z`,
    });
  }
  // 463 newer warnings — the noise that did the burying.
  for (let i = 0; i < 463; i++) {
    rows.push({
      id: `warn-${i}`,
      severity: 'warning',
      source: 'noise',
      message: 'warning',
      created_at: `2026-08-30T${String(i % 24).padStart(2, '0')}:00:00.000Z`,
    });
  }
  return rows;
}

beforeEach(() => {
  ROWS = productionShape();
  queries.length = 0;
});

describe('getUnresolved', () => {
  it('returns every unresolved critical, however much newer noise exists', async () => {
    const out = await FinancialAlertService.getUnresolved(100);
    const criticals = out.filter((a) => a.severity === 'critical');

    expect(criticals).toHaveLength(9);
    // The exact two rows production was hiding.
    expect(criticals.map((c) => c.id)).toEqual(
      expect.arrayContaining(['crit-treasury-0821', 'crit-treasury-0824'])
    );
  });

  it('still honours the page budget for everything else', async () => {
    const out = await FinancialAlertService.getUnresolved(100);
    // 9 criticals + 91 others = the requested 100.
    expect(out).toHaveLength(100);
    expect(out.filter((a) => a.severity !== 'critical')).toHaveLength(91);
  });

  it('asks for criticals separately, so they never compete for the budget', async () => {
    await FinancialAlertService.getUnresolved(100);
    const critQuery = queries.find((q) => q.severity === 'critical');
    expect(critQuery, 'criticals must be fetched by their own query').toBeTruthy();
    expect(critQuery!.limit).not.toBe(100);
  });

  it('returns all criticals even when they alone exceed the budget', async () => {
    // Going over budget is the correct failure for this one severity.
    const out = await FinancialAlertService.getUnresolved(5);
    expect(out.filter((a) => a.severity === 'critical')).toHaveLength(9);
  });

  it('never drops a critical when there are more unresolved rows than the limit', async () => {
    const out = await FinancialAlertService.getUnresolved(100);
    const returned = new Set(out.map((a) => a.id));
    const everyCritical = ROWS.filter((r) => r.severity === 'critical').map((r) => r.id);
    for (const id of everyCritical) {
      expect(returned.has(id), `critical ${id} was truncated away`).toBe(true);
    }
  });
});

describe('getUnresolvedCounts', () => {
  it('reports the database totals, not the loaded page', async () => {
    const counts = await FinancialAlertService.getUnresolvedCounts();
    expect(counts.total).toBe(472);
    expect(counts.critical).toBe(9);
    expect(counts.warning).toBe(463);
    expect(counts.info).toBe(0);
  });

  it('counts without fetching the rows', async () => {
    await FinancialAlertService.getUnresolvedCounts();
    expect(queries.length).toBeGreaterThan(0);
    expect(queries.every((q) => q.head === true)).toBe(true);
  });
});
