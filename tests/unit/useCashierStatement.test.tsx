import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { supabase } from '../../src/lib/supabase';
import { masterBus } from '../../src/core/MasterBus';
import {
  EMPTY_STATEMENT_FILTERS,
  customStatementRange,
  statementPresetRange,
  statementRpcFilters,
  useCashierStatement,
  type StatementRequest,
} from '../../src/hooks/useCashierStatement';

const downloads = vi.hoisted(() => ({ calls: [] as Array<[string, Blob, () => boolean]> }));
vi.mock('../../src/utils/downloadCsv', () => ({
  downloadBlob: vi.fn((filename: string, blob: Blob, isCurrent: () => boolean) => {
    downloads.calls.push([filename, blob, isCurrent]);
    if (!isCurrent()) throw new Error('export_account_or_view_changed');
    return true;
  }),
}));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: vi.fn() }));

const CLUB = '11111111-1111-4111-8111-111111111111';
const OTHER_CLUB = '99999999-9999-4999-8999-999999999999';
const USER = '22222222-2222-4222-8222-222222222222';
const FROM = '2026-09-14T07:00:00.000Z';
const TO = '2026-09-21T07:00:00.000Z';

const rpc = vi.mocked(supabase.rpc);
type Args = Record<string, unknown>;

const entryId = (n: number) => `bbbbbbbb-0000-4000-8000-${String(n).padStart(12, '0')}`;
function entry(n: number, over: Record<string, unknown> = {}) {
  return {
    source: 'receipt',
    id: entryId(n),
    at: new Date(Date.UTC(2026, 8, 20, 12) - n * 60_000).toISOString(),
    kind: 'agent_wallet_send',
    wallet: 'agent',
    direction: 'out',
    amount: '100.00',
    from: { type: 'agent_wallet', id: USER, label: 'KingFish' },
    to: { type: 'player_wallet', id: 'aaaaaaaa-0006-4000-8000-000000000006', label: 'Donk Bettor' },
    counterparty: 'Donk Bettor',
    notes: null,
    state: 'posted',
    reference: {
      id: entryId(n),
      source: 'receipt',
      op_id: null,
      idempotency_key: null,
      correlation_id: null,
      ledger_id: null,
      cashout_id: null,
      ticket_id: null,
    },
    balance_after: null,
    table_id: null,
    tournament_id: null,
    hand_id: null,
    ...over,
  };
}
function page(rows: unknown[], next: Record<string, unknown> | null = null, over: Args = {}) {
  return {
    authorized: true,
    scope: 'all',
    viewer: USER,
    range: { from: FROM, to: TO },
    filters: {},
    rows,
    next_cursor: next,
    generated_at: '2026-09-20T12:00:00Z',
    ...over,
  };
}
/** The totals door's contract shape. */
function totalsDoc(over: Args = {}) {
  return {
    authorized: true,
    scope: 'all',
    range: { from: FROM, to: TO },
    filters: {},
    totals: { in: '0.00', out: '300.00', managed: '0.00', count: 3 },
    generated_at: '2026-09-20T12:00:00Z',
    ...over,
  };
}
const ok = (data: unknown) => Promise.resolve({ data, error: null } as never);
const fail = (code: string, message: string) =>
  Promise.resolve({ data: null, error: { code, message } } as never);
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const request = (over: Partial<StatementRequest> = {}): StatementRequest => ({
  from: FROM,
  to: TO,
  filters: EMPTY_STATEMENT_FILTERS,
  ...over,
});

/** The handler the hook registered on the (mocked) master bus for `type`. */
function busHandler(type: string) {
  const calls = vi.mocked(masterBus.subscribe).mock.calls.filter((c) => c[0] === type);
  const last = calls[calls.length - 1];
  if (!last) throw new Error(`no ${type} subscription`);
  return last[1] as (event: unknown) => void;
}

function mount(opts: { request?: StatementRequest | null; current?: () => boolean } = {}) {
  const guard = { current: opts.current ?? (() => true) };
  const hook = renderHook(
    (props: { request: StatementRequest | null }) =>
      useCashierStatement({
        userId: USER,
        clubId: CLUB,
        request: props.request,
        isAccountCurrent: () => guard.current(),
      }),
    { initialProps: { request: opts.request === undefined ? request() : opts.request } }
  );
  return { ...hook, guard };
}

const callsOf = (name: string) =>
  rpc.mock.calls.filter((c) => c[0] === name).map((c) => c[1] as Args);

beforeEach(() => {
  vi.clearAllMocks();
  downloads.calls = [];
});

describe('keyset paging', () => {
  it('continues with the exact cursor and the exact request the rows were read with', async () => {
    const cursorA = { at: entry(2).at, source: 'receipt', id: entryId(2), fp: 'fp-a' };
    rpc.mockImplementation(((name: string, args: Args) => {
      if (name !== 'fn_cashier_statement_page') return ok(null);
      return args.p_cursor
        ? ok(page([entry(2), entry(3)], null))
        : ok(page([entry(1), entry(2)], cursorA));
    }) as never);
    const { result } = mount({
      request: request({
        filters: { ...EMPTY_STATEMENT_FILTERS, wallet: 'agent', operation: 'Agent Wallet Send' },
      }),
    });
    await waitFor(() => expect(result.current.list.status).toBe('ready'));
    expect(result.current.list.rows).toHaveLength(2);
    expect(result.current.list.hasMore).toBe(true);

    await act(async () => {
      await result.current.loadMore();
    });
    const [first, second] = callsOf('fn_cashier_statement_page');
    expect(first).toMatchObject({
      p_club_id: CLUB,
      p_from: FROM,
      p_to: TO,
      p_cursor: null,
      p_limit: 100,
      p_filters: { wallet: 'agent', operation: 'agent_wallet_send' },
    });
    expect(second.p_cursor).toEqual(cursorA);
    expect({ ...second, p_cursor: null }).toEqual(first);
    // The overlapping row the server repeated is shown once.
    expect(result.current.list.rows.map((r) => r.id)).toEqual([entryId(1), entryId(2), entryId(3)]);
    expect(result.current.list.hasMore).toBe(false);
  });

  it('a cursor refused as belonging to another statement keeps the rows and asks for a reload', async () => {
    rpc.mockImplementation(((_: string, args: Args) =>
      args.p_cursor
        ? fail('55000', 'cursor does not belong to this statement')
        : ok(
            page([entry(1)], { at: 'x', source: 'receipt', id: entryId(1), fp: 'old' })
          )) as never);
    const { result } = mount();
    await waitFor(() => expect(result.current.list.status).toBe('ready'));
    await act(async () => {
      await result.current.loadMore();
    });
    expect(result.current.list.moreProblem).toBe('changed');
    expect(result.current.list.rows).toHaveLength(1);
    expect(result.current.list.status).toBe('ready');
  });

  it('never continues an old statement after the request changed', async () => {
    const more = deferred<unknown>();
    rpc.mockImplementation(((_: string, args: Args) => {
      if (args.p_cursor) return more.promise;
      return args.p_from === FROM
        ? ok(page([entry(1)], { at: 'a', source: 'receipt', id: entryId(1), fp: 'a' }))
        : ok(page([entry(9)], null));
    }) as never);
    const { result, rerender } = mount();
    await waitFor(() => expect(result.current.list.status).toBe('ready'));
    let pending!: Promise<void>;
    act(() => {
      pending = result.current.loadMore();
    });
    rerender({ request: request({ from: '2026-09-01T07:00:00.000Z' }) });
    await waitFor(() => expect(result.current.list.rows.map((r) => r.id)).toEqual([entryId(9)]));
    await act(async () => {
      more.resolve({ data: page([entry(2)], null), error: null });
      await pending;
    });
    expect(result.current.list.rows.map((r) => r.id)).toEqual([entryId(9)]);
  });
});

describe('stale responses', () => {
  it('drops an older first page that lands after a newer one', async () => {
    const slow = deferred<unknown>();
    const fast = deferred<unknown>();
    rpc.mockImplementation(((_: string, args: Args) =>
      args.p_from === FROM ? slow.promise : fast.promise) as never);
    const { result, rerender } = mount();
    rerender({ request: request({ from: '2026-09-15T07:00:00.000Z' }) });
    await act(async () => {
      fast.resolve({ data: page([entry(7)]), error: null });
    });
    await waitFor(() => expect(result.current.list.status).toBe('ready'));
    await act(async () => {
      slow.resolve({ data: page([entry(1), entry(2)]), error: null });
    });
    expect(result.current.list.rows.map((r) => r.id)).toEqual([entryId(7)]);
  });

  it('clears the previous rows the moment a new request starts', async () => {
    const second = deferred<unknown>();
    rpc.mockImplementation(((_: string, args: Args) =>
      args.p_from === FROM ? ok(page([entry(1)])) : second.promise) as never);
    const { result, rerender } = mount();
    await waitFor(() => expect(result.current.list.rows).toHaveLength(1));
    rerender({ request: request({ from: '2026-09-15T07:00:00.000Z' }) });
    await waitFor(() => expect(result.current.list.status).toBe('loading'));
    expect(result.current.list.rows).toEqual([]);
    expect(result.current.list.totals).toBeNull();
  });
});

describe('honest failures', () => {
  it.each([
    [fail('22023', 'statement range is limited to 92 days'), 'range'],
    [fail('PGRST500', 'Unavailable'), 'unavailable'],
    [ok(page([entry(1, { amount: 'NaN' })])), 'malformed'],
    [ok(page([entry(1, { direction: 'sideways' })])), 'malformed'],
  ])('a failed read is an error, never an empty list (%#)', async (response, problem) => {
    rpc.mockImplementation((() => response) as never);
    const { result } = mount();
    await waitFor(() => expect(result.current.list.status).toBe('error'));
    expect(result.current.list.problem).toBe(problem);
    expect(result.current.list.rows).toEqual([]);
    expect(result.current.list.totals).toBeNull();
  });
});

describe('access loss clears everything', () => {
  it('authorized:false shows the refusal and no figures', async () => {
    rpc.mockImplementation((() => ok({ authorized: false, reason: 'not_member' })) as never);
    const { result } = mount();
    await waitFor(() => expect(result.current.list.status).toBe('unauthorized'));
    expect(result.current.list.refusal).toBe('refused');
    expect(result.current.list.rows).toEqual([]);
    expect(result.current.list.totals).toBeNull();
  });

  it('an RPC 42501 on Load More clears the rows already shown', async () => {
    rpc.mockImplementation(((_: string, args: Args) =>
      args.p_cursor
        ? fail('42501', 'permission denied')
        : ok(page([entry(1)], { at: 'a', source: 'receipt', id: entryId(1), fp: 'a' }))) as never);
    const { result } = mount();
    await waitFor(() => expect(result.current.list.rows).toHaveLength(1));
    await act(async () => {
      await result.current.loadMore();
    });
    expect(result.current.list.status).toBe('unauthorized');
    expect(result.current.list.rows).toEqual([]);
  });

  it('CLUB_LEFT clears at once and drops a read that was already in flight', async () => {
    rpc.mockImplementation((() => ok(page([entry(1)]))) as never);
    const { result } = mount();
    await waitFor(() => expect(result.current.list.rows).toHaveLength(1));

    act(() => busHandler('CLUB_LEFT')({ payload: { clubId: OTHER_CLUB } }));
    expect(result.current.list.rows).toHaveLength(1);

    act(() => busHandler('CLUB_LEFT')({ payload: { clubId: 'unknown' } }));
    expect(result.current.list.status).toBe('unauthorized');
    expect(result.current.list.refusal).toBe('left_club');
    expect(result.current.list.rows).toEqual([]);
    expect(result.current.list.totals).toBeNull();
  });

  it('a role change clears now and lets the server decide again', async () => {
    let authorized = true;
    rpc.mockImplementation((() =>
      ok(authorized ? page([entry(1)]) : { authorized: false, reason: 'role' })) as never);
    const { result } = mount();
    await waitFor(() => expect(result.current.list.rows).toHaveLength(1));
    authorized = false;
    act(() => busHandler('MEMBER_ROLE_CHANGED')({ payload: { clubId: CLUB, newRole: 'player' } }));
    expect(result.current.list.rows).toEqual([]);
    await waitFor(() => expect(result.current.list.refusal).toBe('refused'));
    expect(callsOf('fn_cashier_statement_page')).toHaveLength(2);
  });

  it('a read in flight when access is lost never paints', async () => {
    const slow = deferred<unknown>();
    rpc.mockImplementation((() => slow.promise) as never);
    const { result } = mount();
    act(() =>
      busHandler('AUTH_STATE_CHANGED')({ payload: { userId: null, isAuthenticated: false } })
    );
    await act(async () => {
      slow.resolve({ data: page([entry(1)]), error: null });
    });
    expect(result.current.list.status).toBe('unauthorized');
    expect(result.current.list.refusal).toBe('signed_out');
    expect(result.current.list.rows).toEqual([]);
  });

  it('another account never sees rows read for the first one', async () => {
    rpc.mockImplementation((() => ok(page([entry(1)]))) as never);
    const { result, guard, rerender } = mount();
    await waitFor(() => expect(result.current.list.rows).toHaveLength(1));
    guard.current = () => false;
    rerender({ request: request() });
    expect(result.current.list.rows).toEqual([]);
    expect(result.current.list.refusal).toBe('account_changed');
  });
});

describe('export', () => {
  const TOTAL = 1500;
  const EXPORT_ID = 'eeeeeeee-0000-4000-8000-000000000001';
  const exportRows = Array.from({ length: TOTAL }, (_, i) => entry(i + 1));
  function exportRpc(overrides: Record<string, (args: Args) => Promise<never>> = {}) {
    rpc.mockImplementation(((name: string, args: Args) => {
      if (overrides[name]) return overrides[name](args);
      if (name === 'fn_cashier_statement_page') return ok(page([entry(1)]));
      if (name === 'fn_cashier_statement_totals') return ok(totalsDoc());
      if (name === 'fn_cashier_statement_export_start')
        return ok({
          export_id: EXPORT_ID,
          total_rows: TOTAL,
          expires_at: '2026-09-20T12:15:00Z',
          totals: { in: '0.00', out: '150000.00', managed: '0.00', count: TOTAL },
          metadata_fingerprint: 'abc',
        });
      if (name === 'fn_cashier_statement_export_page') {
        const offset = Number(args.p_offset);
        const rows = exportRows.slice(offset, offset + Number(args.p_limit));
        return ok({
          rows,
          total_rows: TOTAL,
          next_offset: offset + rows.length,
          has_more: offset + rows.length < TOTAL,
          expires_at: '2026-09-20T12:15:00Z',
          metadata: { kind: 'cashier_statement', club_id: CLUB },
          metadata_fingerprint: 'abc',
        });
      }
      if (name === 'fn_cashier_statement_export_cancel') return ok(true);
      return ok(null);
    }) as never);
  }

  it('prepares with the on-screen request, pages 1,000 at a time and hands the file to the one door', async () => {
    exportRpc();
    const { result } = mount();
    await waitFor(() => expect(result.current.list.status).toBe('ready'));
    await act(async () => {
      await result.current.prepareExport();
    });
    expect(result.current.exportView).toMatchObject({ status: 'ready', totalRows: TOTAL });
    const [start] = callsOf('fn_cashier_statement_export_start');
    const [firstPage] = callsOf('fn_cashier_statement_page');
    expect(start).toMatchObject({
      p_club_id: CLUB,
      p_from: firstPage.p_from,
      p_to: firstPage.p_to,
      p_filters: firstPage.p_filters,
    });
    expect(start.p_request_id).toMatch(/^[0-9a-f-]{36}$/);

    await act(async () => {
      await result.current.downloadExport('statement.csv');
    });
    expect(callsOf('fn_cashier_statement_export_page').map((a) => [a.p_offset, a.p_limit])).toEqual(
      [
        [0, 1000],
        [1000, 1000],
      ]
    );
    expect(downloads.calls).toHaveLength(1);
    const [filename, blob, isCurrent] = downloads.calls[0];
    expect(filename).toBe('statement.csv');
    const text = await blob.text();
    expect(text.split('\r\n').filter(Boolean)).toHaveLength(TOTAL + 1);
    expect(result.current.exportView.downloaded).toBe(true);

    // The guard handed to the door dies with access.
    expect(isCurrent()).toBe(true);
    act(() => busHandler('CLUB_LEFT')({ payload: { clubId: CLUB } }));
    expect(isCurrent()).toBe(false);
    expect(result.current.exportView.status).toBe('idle');
  });

  it('an expired export offers Prepare Again', async () => {
    exportRpc({
      fn_cashier_statement_export_page: () => fail('55000', 'export expired; prepare a new export'),
    });
    const { result } = mount();
    await waitFor(() => expect(result.current.list.status).toBe('ready'));
    await act(async () => {
      await result.current.prepareExport();
    });
    await act(async () => {
      await result.current.downloadExport('statement.csv');
    });
    expect(result.current.exportView.status).toBe('expired');
    expect(downloads.calls).toHaveLength(0);
  });

  it('a range over the export cap says to narrow it', async () => {
    exportRpc({
      fn_cashier_statement_export_start: () =>
        fail('55000', 'narrow the range; the export is limited to 20,000 entries'),
    });
    const { result } = mount();
    await waitFor(() => expect(result.current.list.status).toBe('ready'));
    await act(async () => {
      await result.current.prepareExport();
    });
    expect(result.current.exportView.status).toBe('too_large');
  });

  it('a 42501 from the export page voids the file and clears the statement', async () => {
    exportRpc({
      fn_cashier_statement_export_page: () => fail('42501', 'export is no longer authorized'),
    });
    const { result } = mount();
    await waitFor(() => expect(result.current.list.status).toBe('ready'));
    await act(async () => {
      await result.current.prepareExport();
    });
    await act(async () => {
      await result.current.downloadExport('statement.csv');
    });
    expect(result.current.list.status).toBe('unauthorized');
    expect(result.current.list.rows).toEqual([]);
    expect(result.current.list.totals).toBeNull();
    expect(result.current.exportView.status).toBe('idle');
    expect(downloads.calls).toHaveLength(0);
    // The door refuses without deleting the job: the client cancels it.
    await waitFor(() =>
      expect(callsOf('fn_cashier_statement_export_cancel')).toEqual([{ p_export_id: EXPORT_ID }])
    );
  });

  it('access lost mid-download hands nothing to the door', async () => {
    const firstPage = deferred<never>();
    exportRpc({ fn_cashier_statement_export_page: () => firstPage.promise });
    const { result } = mount();
    await waitFor(() => expect(result.current.list.status).toBe('ready'));
    await act(async () => {
      await result.current.prepareExport();
    });
    let pending!: Promise<void>;
    act(() => {
      pending = result.current.downloadExport('statement.csv');
    });
    act(() => busHandler('MEMBER_UPDATED')({ payload: { clubId: CLUB } }));
    await act(async () => {
      firstPage.resolve({
        data: {
          rows: exportRows.slice(0, 1000),
          total_rows: TOTAL,
          next_offset: 1000,
          has_more: false,
        },
        error: null,
      } as never);
      await pending;
    });
    expect(downloads.calls).toHaveLength(0);
  });

  it('a new request releases the export prepared for the old one', async () => {
    exportRpc();
    const { result, rerender } = mount();
    await waitFor(() => expect(result.current.list.status).toBe('ready'));
    await act(async () => {
      await result.current.prepareExport();
    });
    rerender({ request: request({ from: '2026-09-15T07:00:00.000Z' }) });
    await waitFor(() => expect(result.current.exportView.status).toBe('idle'));
    expect(callsOf('fn_cashier_statement_export_cancel')).toEqual([{ p_export_id: EXPORT_ID }]);
  });
});

describe('the totals door', () => {
  it('reads the whole-range totals once per first page, with the same four arguments, never on Load More', async () => {
    const cursor = { at: 'a', source: 'receipt', id: entryId(1), fp: 'a' };
    const totals = deferred<unknown>();
    rpc.mockImplementation(((name: string, args: Args) => {
      if (name === 'fn_cashier_statement_totals') return totals.promise;
      return ok(args.p_cursor ? page([entry(2)]) : page([entry(1)], cursor));
    }) as never);
    const { result } = mount({
      request: request({ filters: { ...EMPTY_STATEMENT_FILTERS, state: 'posted' } }),
    });
    await waitFor(() => expect(result.current.list.status).toBe('ready'));
    expect(result.current.list.totalsStatus).toBe('calculating');
    expect(result.current.list.totals).toBeNull();
    await act(async () => {
      totals.resolve({
        data: totalsDoc({ totals: { in: '10.00', out: '2.50', managed: '0.00', count: 2 } }),
        error: null,
      });
    });
    expect(result.current.list.totalsStatus).toBe('ready');
    expect(result.current.list.totals).toEqual({
      in: '10.00',
      out: '2.50',
      managed: '0.00',
      count: 2,
    });
    expect(callsOf('fn_cashier_statement_totals')).toEqual([
      { p_club_id: CLUB, p_from: FROM, p_to: TO, p_filters: { state: 'posted' } },
    ]);
    await act(async () => {
      await result.current.loadMore();
    });
    expect(callsOf('fn_cashier_statement_totals')).toHaveLength(1);
    expect(result.current.list.totals?.count).toBe(2);
  });

  it.each([
    [{ code: '57014', message: 'canceling statement due to statement timeout' }],
    [{ code: 'PGRST500', message: 'Unavailable' }],
  ])('a failed total is Unavailable For This Range, never zero (%#)', async (error) => {
    rpc.mockImplementation(((name: string) =>
      name === 'fn_cashier_statement_totals'
        ? Promise.resolve({ data: null, error })
        : ok(page([entry(1)]))) as never);
    const { result } = mount();
    await waitFor(() => expect(result.current.list.totalsStatus).toBe('unavailable'));
    expect(result.current.list.totals).toBeNull();
    expect(result.current.list.status).toBe('ready');
    expect(result.current.list.rows).toHaveLength(1);
  });

  it('authorized:false from the totals door clears everything like the page door', async () => {
    rpc.mockImplementation(((name: string) =>
      name === 'fn_cashier_statement_totals'
        ? ok({ authorized: false, reason: 'role' })
        : ok(page([entry(1)]))) as never);
    const { result } = mount();
    await waitFor(() => expect(result.current.list.status).toBe('unauthorized'));
    expect(result.current.list.refusal).toBe('refused');
    expect(result.current.list.rows).toEqual([]);
    expect(result.current.list.totals).toBeNull();
  });

  it('drops a total for an older range that lands after the newer one', async () => {
    const slow = deferred<unknown>();
    rpc.mockImplementation(((name: string, args: Args) => {
      if (name !== 'fn_cashier_statement_totals') return ok(page([entry(1)]));
      return args.p_from === FROM
        ? slow.promise
        : ok(totalsDoc({ totals: { in: '7.00', out: '0.00', managed: '0.00', count: 1 } }));
    }) as never);
    const { result, rerender } = mount();
    await waitFor(() => expect(result.current.list.totalsStatus).toBe('calculating'));
    rerender({ request: request({ from: '2026-09-15T07:00:00.000Z' }) });
    await waitFor(() => expect(result.current.list.totals?.in).toBe('7.00'));
    await act(async () => {
      slow.resolve({ data: totalsDoc(), error: null });
    });
    expect(result.current.list.totals?.in).toBe('7.00');
  });

  it('access lost while the total is in flight leaves nothing behind', async () => {
    const slow = deferred<unknown>();
    rpc.mockImplementation(((name: string) =>
      name === 'fn_cashier_statement_totals' ? slow.promise : ok(page([entry(1)]))) as never);
    const { result } = mount();
    await waitFor(() => expect(result.current.list.totalsStatus).toBe('calculating'));
    act(() => busHandler('CLUB_LEFT')({ payload: { clubId: CLUB } }));
    await act(async () => {
      slow.resolve({ data: totalsDoc(), error: null });
    });
    expect(result.current.list.status).toBe('unauthorized');
    expect(result.current.list.totals).toBeNull();
    expect(result.current.list.totalsStatus).toBe('idle');
  });
});

describe('receipts and balances', () => {
  it('a receipt never carries a balance; a movement keeps its own', async () => {
    rpc.mockImplementation((() =>
      ok(
        page([
          entry(1, { balance_after: '500.00' }),
          entry(2, { source: 'movement', balance_after: '750.25' }),
        ])
      )) as never);
    const { result } = mount();
    await waitFor(() => expect(result.current.list.rows).toHaveLength(2));
    expect(result.current.list.rows.map((r) => r.balance_after)).toEqual([null, '750.25']);
  });
});

describe('ranges and filters', () => {
  it('This Week is the Pacific accounting week, Monday through Sunday', () => {
    // Wednesday 2026-09-23 10:00 Pacific.
    const range = statementPresetRange('week', Date.parse('2026-09-23T17:00:00Z'));
    expect(range.fromDay).toBe('2026-09-21');
    expect(range.toDay).toBe('2026-09-27');
    expect(range.from).toBe('2026-09-21T07:00:00.000Z');
    expect(range.to).toBe('2026-09-28T07:00:00.000Z');
  });

  it('refuses a custom range that is reversed or longer than 92 days', () => {
    expect(customStatementRange('2026-09-20', '2026-09-01')).toEqual({ problem: 'order' });
    expect(customStatementRange('2026-01-01', '2026-09-01')).toEqual({ problem: 'span' });
    expect(customStatementRange('', '2026-09-01')).toEqual({ problem: 'missing' });
    expect('range' in customStatementRange('2026-06-22', '2026-09-21')).toBe(true);
  });

  it('sends only the filters that narrow the statement', () => {
    expect(statementRpcFilters(EMPTY_STATEMENT_FILTERS)).toEqual({});
    expect(
      statementRpcFilters({
        ...EMPTY_STATEMENT_FILTERS,
        direction: 'in',
        counterparty: '  Donk  ',
        reference: ' abc ',
      })
    ).toEqual({ direction: 'in', counterparty: 'Donk', reference: 'abc' });
  });

  it('never sends a key outside the six the server knows', () => {
    const every = statementRpcFilters({
      wallet: 'bank',
      direction: 'managed',
      state: 'clawed_back',
      operation: 'Club Bank Send',
      counterparty: 'x'.repeat(80),
      reference: 'r',
      ...({ is_horse: true, extra: 'x' } as object),
    } as never);
    expect(Object.keys(every).sort()).toEqual(
      ['counterparty', 'direction', 'operation', 'reference', 'state', 'wallet'].sort()
    );
    expect(every.operation).toBe('club_bank_send');
    expect(every.counterparty).toHaveLength(64);
  });
});
