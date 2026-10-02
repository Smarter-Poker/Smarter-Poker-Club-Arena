/**
 * THE SETTLER CLEARS EACH HOST CLUB'S CASH IN ITS OWN LANE (2026-10-02).
 * See MAX_CASH_LANES in RakebackSettlerService.ts for the measurement.
 *
 * Two parts: the split itself, and one settler page across two host clubs -
 * both lanes' batches are in flight before either answers, and the durable
 * cursor is written only after every lane has stopped.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { pacificAccountingWeek } from './pacificAccountingWeek.js';

const { mockRpc, upserts, page } = vi.hoisted(() => ({
  mockRpc: vi.fn(),
  upserts: [] as Array<Record<string, unknown>>,
  page: { rows: [] as Array<Record<string, unknown>> },
}));

vi.mock('./supabase.js', () => {
  const from = (table: string) => {
    const ops: Array<[string, unknown[]]> = [];
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
                    high_water_mark: '2026-10-02 20:00:00.000000+00',
                    high_water_mark_id: ZERO,
                  },
                  error: null,
                });
              if (table === 'rake_records') {
                // The tie page (eq created_at) is empty; the next range is the page.
                const tie = ops.some(([n, a]) => n === 'eq' && a[0] === 'created_at');
                return resolve({ data: tie ? [] : page.rows, error: null });
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
const { cashSourceLanes, MAX_CASH_LANES, RakebackSettlerService } =
  await import('./RakebackSettlerService.js');

const r = (id: string, club: string | null) => ({ id, club_id: club });

describe('cashSourceLanes', () => {
  it('one host club is one lane, in page order - the settler behaves as before', () => {
    const rows = [r('1', 'A'), r('2', 'A'), r('3', 'A')];
    expect(cashSourceLanes(rows)).toEqual([rows]);
  });

  it('two host clubs are two lanes, each in page order', () => {
    const rows = [r('1', 'A'), r('2', 'B'), r('3', 'A'), r('4', 'B')];
    expect(cashSourceLanes(rows)).toEqual([
      [r('1', 'A'), r('3', 'A')],
      [r('2', 'B'), r('4', 'B')],
    ]);
  });

  it('never more than the lane cap; a club is never split across lanes', () => {
    const clubs = Array.from({ length: MAX_CASH_LANES + 3 }, (_, n) => `C${n}`);
    const rows = clubs.flatMap((c, n) => [r(`${n}a`, c), r(`${n}b`, c)]);
    const lanes = cashSourceLanes(rows);
    expect(lanes).toHaveLength(MAX_CASH_LANES);
    expect(lanes.flat()).toHaveLength(rows.length);
    for (const c of clubs) {
      expect(lanes.filter((lane) => lane.some((row) => row.club_id === c))).toHaveLength(1);
    }
  });

  it('an empty page has no lanes; a bad cap still yields one lane', () => {
    expect(cashSourceLanes([])).toEqual([]);
    const rows = [r('1', 'A'), r('2', 'B')];
    expect(cashSourceLanes(rows, 0)).toEqual([rows]);
    expect(cashSourceLanes(rows, Number.NaN)).toEqual([rows]);
  });

  it('rows without a host club share one lane', () => {
    const rows = [r('1', null), r('2', 'A'), r('3', null)];
    expect(cashSourceLanes(rows)).toEqual([[r('1', null), r('3', null)], [r('2', 'A')]]);
  });
});

describe('a settler page across two host clubs', () => {
  const uid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const HOST_A = 'fade0000-0000-0000-0000-000000000001';
  const HOST_B = '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3';
  const AT_A = '2026-10-02 20:00:01.000000+00';
  const AT_B = '2026-10-02 20:00:02.000000+00';
  const week = pacificAccountingWeek(AT_A);
  const source = (id: string, at: string, club: string) => ({
    id,
    created_at: at,
    club_id: club,
    hand_id: uid(Number(id.slice(-4)) + 500),
    rake_amount: 1,
    is_tournament: false,
    player_contributions: {},
  });
  const accrued = (id: string, at: string, club: string) => ({
    receipt_version: 3,
    recorded: true,
    receipt_id: uid(Number(id.slice(-4)) + 900),
    rake_record_id: id,
    hand_id: null,
    earned_at: at,
    attempt: 1,
    source_fingerprint: 'a'.repeat(32),
    status: 'accrued',
    reason: null,
    credits: [
      {
        player_id: uid(42),
        club_id: club,
        rake_credit: 1,
        period_start: week.periodStart,
        period_end: week.periodEnd,
      },
    ],
  });
  const batch = (receipts: unknown[]) => ({
    data: { receipt_version: 3, ok: receipts.length, failed: 0, blocked: 0, receipts },
    error: null,
  });
  const run = () =>
    (
      new RakebackSettlerService() as unknown as { _runSettlementInner(): Promise<string> }
    )._runSettlementInner();

  let parked: Array<{ ids: string[]; release: (v: unknown) => void }>;
  beforeEach(() => {
    upserts.length = 0;
    page.rows = [source(uid(1), AT_A, HOST_A), source(uid(2), AT_B, HOST_B)];
    parked = [];
    mockRpc.mockReset();
    mockRpc.mockImplementation(async (name: string, args: Record<string, any>) => {
      if (name === 'fn_retry_cash_accounting_sources') return batch([]);
      if (name === 'fn_rakeback_settler_read_horizon')
        return { data: { horizon: '2999-12-31 00:00:00.000000+00' }, error: null };
      if (name === 'fn_credit_agent_commissions_batch')
        return new Promise((release) =>
          parked.push({ ids: args.p_items.map((i: any) => i.source_id), release })
        );
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
  const answer = (n: number) => {
    const [id] = parked[n].ids;
    const row = page.rows.find((x) => x.id === id)!;
    parked[n].release(batch([accrued(id, String(row.created_at), String(row.club_id))]));
  };

  it('runs both hosts side by side and saves the cursor only after both', async () => {
    const running = run();
    // Both hosts' batches are in flight before either answers.
    await vi.waitFor(() => expect(parked).toHaveLength(2));
    expect(parked.map((p) => p.ids)).toEqual([[uid(1)], [uid(2)]]);
    answer(1);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(upserts).toHaveLength(0);
    answer(0);
    expect(await running).toBe('more');
    expect(upserts).toHaveLength(1);
    expect(upserts[0].high_water_mark).toBe(AT_B);
    expect(upserts[0].high_water_mark_id).toBe(uid(2));
  });

  it('a failed lane halts the page, and only after the other lane has stopped', async () => {
    const running = run();
    await vi.waitFor(() => expect(parked).toHaveLength(2));
    parked[0].release({ data: null, error: { message: 'timeout after commit' } });
    let settled = false;
    void running.then(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(false);
    answer(1);
    expect(await running).toBe('halted');
    expect(upserts).toHaveLength(0);
  });
});
