/**
 * Routed accounting regressions.
 * Actual pages/workspace/observer/weekly and period readers/account-generation
 * guards run against synthetic remote responses. Financial admin eligibility
 * and the ledger renderer are boundary mocks, not provider/RLS qualification.
 * Direct-workspace invalid-date cases live in UnionAccountingRunStatus.test.tsx.
 */
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Link, MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import {
  OBSERVER_ID,
  missingObservation,
  observationRow,
  recordedPeriod,
} from '../helpers/accountingObservation';
import { WEEKLY_ID, weeklyStatementRow } from '../helpers/clubWeeklyStatement';

interface QueryCall {
  table: string;
  fields: string;
  filters: Array<{ operation: string; column: string; value: unknown }>;
  orders: Array<{ column: string; ascending: boolean }>;
  limit: number;
}
interface Reply {
  data: unknown;
  error: unknown;
}
const m = vi.hoisted(() => ({
  actor: null as string | null,
  hydrating: false,
  canOperateUnionNetwork: false,
  authRevision: 0,
  authSubscribers: new Set<() => void>(),
  handlers: new Set<(event: { payload: { isAuthenticated: boolean; userId?: string } }) => void>(),
  rpc: vi.fn(),
  resolveClub: vi.fn(),
  resolveUnion: vi.fn(),
  rows: {} as Record<string, Array<Record<string, unknown>>>,
  calls: [] as QueryCall[],
  reply: null as null | ((call: QueryCall) => Reply | Promise<Reply>),
  dashboard: {
    status: 'ready',
    clubId: null,
    platformWide: true,
    clubRole: null,
    isPlatformStaff: true,
    userId: null,
    message: null,
  } as {
    status: 'loading' | 'ready' | 'denied' | 'error';
    clubId: string | null;
    platformWide: boolean;
    clubRole: string | null;
    isPlatformStaff: boolean;
    userId: string | null;
    message: string | null;
  },
  reload: vi.fn(),
}));
vi.mock('../../src/core/IdentityDNA', () => ({
  getIdentityDNAStatus: () => ({
    loaded: !m.hydrating,
    authenticated: !!m.actor,
    userId: m.actor,
  }),
}));
vi.mock('../../src/core/MasterBus', () => ({
  masterBus: {
    emit: vi.fn(),
    subscribe: (
      name: string,
      callback: (event: { payload: { isAuthenticated: boolean; userId?: string } }) => void
    ) => {
      if (name === 'AUTH_STATE_CHANGED') m.handlers.add(callback);
      return () => m.handlers.delete(callback);
    },
  },
}));
vi.mock('../../src/hooks/useAuthUser', async () => {
  const { useSyncExternalStore } = await vi.importActual<typeof import('react')>('react');
  return {
    useAuthUser: () => {
      // Notify the whole routed tree as an auth provider would. Include the event
      // revision so a batched A-B-A transition is observable to the mounted view.
      useSyncExternalStore(
        (callback) => {
          m.authSubscribers.add(callback);
          return () => m.authSubscribers.delete(callback);
        },
        () => `${m.authRevision}:${m.actor ?? ''}:${String(m.hydrating)}`
      );
      return { user: m.actor ? { id: m.actor } : null, isHydrating: m.hydrating };
    },
  };
});
vi.mock('../../src/hooks/useFinancialAdminScope', () => ({
  useFinancialAdminScope: () => ({ ...m.dashboard, reload: m.reload }),
}));
// Permission is a separate read boundary; accounting RPC assertions stay observer-only.
vi.mock('../../src/hooks/useCanCreateUnion', () => ({
  useCanOperateUnionNetwork: () => ({
    canOperateUnionNetwork: m.canOperateUnionNetwork,
    checking: false,
  }),
}));
vi.mock('../../src/utils/clubIdResolver', () => ({ resolveClubUUID: m.resolveClub }));
vi.mock('../../src/utils/unionIdResolver', () => ({ resolveUnionUUID: m.resolveUnion }));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: vi.fn() }));
vi.mock('../../src/components/common/TransactionLedgerView', () => ({
  default: (props: { clubId?: string; userId?: string; clubScoped?: boolean; limit?: number }) => (
    <div
      data-testid="transaction-ledger"
      data-club={props.clubId ?? ''}
      data-user={props.userId ?? ''}
      data-club-scoped={String(props.clubScoped === true)}
      data-limit={String(props.limit)}
    />
  ),
}));
vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    rpc: m.rpc,
    from: (table: string) => {
      const call: QueryCall = { table, fields: '', filters: [], orders: [], limit: Infinity };
      m.calls.push(call);
      const query: Record<string, unknown> = {};
      query.select = (fields: string) => {
        call.fields = fields;
        return query;
      };
      for (const operation of ['eq', 'is', 'gte', 'lte']) {
        query[operation] = (column: string, value: unknown) => {
          call.filters.push({ operation, column, value });
          return query;
        };
      }
      query.order = (column: string, options: { ascending: boolean }) => {
        call.orders.push({ column, ascending: options.ascending });
        return query;
      };
      query.limit = (limit: number) => {
        call.limit = limit;
        return query;
      };
      query.then = (yes: (reply: Reply) => unknown, no: (reason: unknown) => unknown) => {
        let reply: Reply | Promise<Reply>;
        if (m.reply) reply = m.reply(call);
        else {
          const rows = (m.rows[table] ?? [])
            .filter((row) =>
              call.filters.every((filter) => {
                if (filter.operation === 'gte')
                  return String(row[filter.column]) >= String(filter.value);
                if (filter.operation === 'lte')
                  return String(row[filter.column]) <= String(filter.value);
                return row[filter.column] === filter.value;
              })
            )
            .sort((a, b) => {
              for (const order of call.orders) {
                const comparison = String(a[order.column]).localeCompare(String(b[order.column]));
                if (comparison) return order.ascending ? comparison : -comparison;
              }
              return 0;
            })
            .slice(0, call.limit);
          reply = { data: rows, error: null };
        }
        return Promise.resolve(reply).then(yes, no);
      };
      return query;
    },
  },
}));

import SettlementPage from '../../src/pages/SettlementPage';
import SettlementDashboardPage from '../../src/pages/SettlementDashboardPage';
import { accountingRunExpectedAt } from '../../src/services/AccountingObservationService';

const ID = { ...WEEKLY_ID, union: OBSERVER_ID.union, otherUnion: OBSERVER_ID.otherUnion };
const WEEK_START = '2026-09-07T07:00:00.000Z';
const WEEK_END = '2026-09-14T07:00:00.000Z';
function auth(actor: string | null) {
  m.actor = actor;
  m.authRevision += 1;
  for (const callback of [...m.handlers])
    callback({ payload: { isAuthenticated: !!actor, userId: actor ?? undefined } });
  for (const callback of [...m.authSubscribers]) callback();
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function missingFor(args: Record<string, string>) {
  const week = { periodStart: args.p_period_start, periodEnd: args.p_period_end };
  return {
    ...missingObservation(args.p_scope_kind as 'club' | 'union', args.p_scope_id),
    actor_user_id: args.p_expected_actor_id,
    period_start: week.periodStart,
    period_end: week.periodEnd,
    expected_run_at: accountingRunExpectedAt(week),
    observed_at: '2026-09-15T12:00:00.000001Z',
  };
}
function postedClub() {
  return observationRow({ actor_user_id: ID.actor, scope_kind: 'club', scope_id: ID.club });
}
function LocationProbe() {
  const location = useLocation();
  return <output data-testid="current-path">{location.pathname}</output>;
}
function RoutedPages({ initial }: { initial: string }) {
  return (
    <MemoryRouter initialEntries={[initial]}>
      <nav aria-label="Test Route Driver">
        <Link to={`/clubs/${ID.club}/settlement`}>Test Open Club</Link>
        <Link to={`/unions/${ID.union}/settlement`}>Test Open Union</Link>
      </nav>
      <LocationProbe />
      <Routes>
        <Route path="/clubs/:clubId/settlement" element={<SettlementPage />} />
        <Route path="/unions/:unionId/settlement" element={<SettlementPage />} />
        <Route path="/settlement-dashboard" element={<SettlementDashboardPage />} />
        <Route path="*" element={<p>Navigation Destination</p>} />
      </Routes>
    </MemoryRouter>
  );
}
function expectOnlyObserverRPCs() {
  expect(m.rpc.mock.calls.every(([name]) => name === 'fn_accounting_run_observation_v1')).toBe(
    true
  );
}
function expectNoManualAccountingControls() {
  const main = screen.getByRole('main');
  expect(within(main).getByRole('button', { name: 'Back' })).toBeInTheDocument();
  expect(
    within(main).queryByRole('button', {
      name: /open (?:new )?period|start period|close|pay|distribute|execute|canary/i,
    })
  ).not.toBeInTheDocument();
}
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-09-15T12:00:00Z'));
  m.rpc.mockReset();
  m.resolveClub.mockReset();
  m.resolveUnion.mockReset();
  m.reload.mockReset();
  m.hydrating = false;
  m.canOperateUnionNetwork = false;
  m.rows = {};
  m.calls = [];
  m.reply = null;
  m.resolveClub.mockImplementation(async (reference: string) => reference);
  m.resolveUnion.mockImplementation(async (reference: string) => reference);
  m.dashboard = {
    status: 'ready',
    clubId: null,
    platformWide: true,
    clubRole: null,
    isPlatformStaff: true,
    userId: ID.actor,
    message: null,
  };
  auth(null);
  auth(ID.actor);
  m.rpc.mockImplementation(async (_name: string, args: Record<string, string>) => ({
    data: missingFor(args),
    error: null,
  }));
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('routed automatic weekly accounting', () => {
  it('keeps the actual club weekly-only reader and cashier link while a selected valid DST week changes only the observer request', async () => {
    m.rows.settlement_invoices = [
      weeklyStatementRow(),
      weeklyStatementRow({ invoice_type: 'transaction_receipt', gross_amount: '999.00' }),
      weeklyStatementRow({ invoice_type: 'accounting_correction', gross_amount: '888.00' }),
      weeklyStatementRow({ club_id: ID.otherClub, gross_amount: '777.00' }),
    ];
    render(<RoutedPages initial={`/clubs/${ID.club}/settlement`} />);
    expect(await screen.findByText('100.25 Chips')).toBeInTheDocument();
    expect(screen.getByText('60.20 Chips')).toBeInTheDocument();
    expect(screen.getByText('40.05 Chips')).toBeInTheDocument();
    expect(screen.queryByText('999.00 Chips')).not.toBeInTheDocument();
    expect(screen.queryByText('888.00 Chips')).not.toBeInTheDocument();
    expect(screen.queryByText('777.00 Chips')).not.toBeInTheDocument();
    expect(
      screen.queryByRole('heading', { name: 'Recorded Union Periods' })
    ).not.toBeInTheDocument();
    const summaryReads = m.calls.filter((call) => call.table === 'settlement_invoices').length;
    m.rpc.mockClear();
    fireEvent.change(screen.getByLabelText('Week Ending Monday'), {
      target: { value: '2026-03-09' },
    });
    await waitFor(() => expect(m.rpc).toHaveBeenCalledTimes(1));
    expect(m.rpc).toHaveBeenCalledWith('fn_accounting_run_observation_v1', {
      p_expected_actor_id: ID.actor,
      p_scope_kind: 'club',
      p_scope_id: ID.club,
      p_period_start: '2026-03-02T08:00:00.000Z',
      p_period_end: '2026-03-09T07:00:00.000Z',
    });
    expect(m.calls.filter((call) => call.table === 'settlement_invoices')).toHaveLength(
      summaryReads
    );
    expect(m.calls.every((call) => call.table === 'settlement_invoices')).toBe(true);
    const query = m.calls[0];
    expect(query.filters).toEqual([
      { operation: 'eq', column: 'club_id', value: ID.club },
      { operation: 'eq', column: 'invoice_type', value: 'club_weekly_accounting' },
    ]);
    expect(query.limit).toBe(50);
    expectNoManualAccountingControls();
    expectOnlyObserverRPCs();
    fireEvent.click(screen.getByRole('link', { name: 'Open Club Cashier And Records' }));
    expect(screen.getByTestId('current-path')).toHaveTextContent(`/clubs/${ID.club}/cashier`);
  });

  it('uses actual bounded union aggregate period records and preserves the weekly-statement link without showing their amounts as payments', async () => {
    m.rows.settlement_periods = [
      recordedPeriod(),
      recordedPeriod({ id: ID.period, club_id: ID.club }),
      recordedPeriod({ union_id: ID.otherUnion }),
    ];
    m.rows.settlement_invoices = [weeklyStatementRow()];
    render(<RoutedPages initial={`/unions/${ID.union}/settlement`} />);
    const history = await screen.findByRole('region', { name: 'Union Period Records' });
    expect(await within(history).findByRole('listitem')).toHaveTextContent('closed');
    expect(within(history).getAllByRole('listitem')).toHaveLength(1);
    expect(
      within(history).getByText(/Recorded Period Status Alone Does Not Prove Payment/)
    ).toBeInTheDocument();
    expect(screen.queryByText('100.25 Chips')).not.toBeInTheDocument();
    expect(screen.queryByText('10.25')).not.toBeInTheDocument();
    expect(m.calls).toHaveLength(1);
    expect(m.calls[0]).toMatchObject({
      table: 'settlement_periods',
      limit: 12,
      filters: [
        { operation: 'eq', column: 'union_id', value: ID.union },
        { operation: 'is', column: 'club_id', value: null },
      ],
      orders: [
        { column: 'start_at', ascending: false },
        { column: 'id', ascending: false },
      ],
    });
    expect(m.calls[0].fields).toContain('total_rake_collected::text');
    expect(
      await screen.findByText('No Accounting Run Recorded For This Union Week')
    ).toBeInTheDocument();
    expectNoManualAccountingControls();
    expectOnlyObserverRPCs();
    fireEvent.click(screen.getByRole('link', { name: 'Open Union Weekly Statements' }));
    expect(screen.getByTestId('current-path')).toHaveTextContent(`/unions/${ID.union}/statements`);
  });

  it.each(['empty', 'error', 'malformed'] as const)(
    'keeps a real %s union period result distinct from an unavailable read',
    async (mode) => {
      m.reply = () =>
        mode === 'empty'
          ? { data: [], error: null }
          : mode === 'error'
            ? { data: null, error: { message: 'transport refused' } }
            : { data: [recordedPeriod({ union_id: ID.otherUnion })], error: null };
      render(<RoutedPages initial={`/unions/${ID.union}/settlement`} />);
      if (mode === 'empty') {
        expect(
          await screen.findByText('No Recorded Periods Were Found For This Union.')
        ).toBeInTheDocument();
        expect(screen.queryByText('Period Records Are Unavailable.')).not.toBeInTheDocument();
      } else {
        expect(await screen.findByText('Period Records Are Unavailable.')).toBeInTheDocument();
        expect(
          screen.queryByText('No Recorded Periods Were Found For This Union.')
        ).not.toBeInTheDocument();
      }
      expectOnlyObserverRPCs();
    }
  );

  it.each([
    {
      from: 'club',
      to: 'union',
      oldId: ID.club,
      targetId: ID.union,
      navigation: 'Test Open Union',
      heading: 'Union Weekly Accounting',
      empty: 'No Recorded Periods Were Found For This Union.',
      table: 'settlement_periods',
    },
    {
      from: 'union',
      to: 'club',
      oldId: ID.union,
      targetId: ID.club,
      navigation: 'Test Open Club',
      heading: 'Club Weekly Accounting',
      empty: 'No Issued Weekly Summaries Were Found For This Club.',
      table: 'settlement_invoices',
    },
  ] as const)(
    'discards a delayed $from alias after navigating to $to before any old financial read dispatches',
    async (route) => {
      const oldAlias = deferred<string>();
      const resolver = route.from === 'club' ? m.resolveClub : m.resolveUnion;
      resolver.mockImplementation((reference: string) =>
        reference === 'slow-scope' ? oldAlias.promise : Promise.resolve(reference)
      );
      render(<RoutedPages initial={`/${route.from}s/slow-scope/settlement`} />);
      expect(screen.getByText('Loading Accounting Scope…')).toBeInTheDocument();
      expect(m.rpc).not.toHaveBeenCalled();
      expect(m.calls).toHaveLength(0);
      fireEvent.click(screen.getByRole('link', { name: route.navigation }));
      // The club route intentionally has both a workspace and summary heading.
      expect(
        (await screen.findAllByRole('heading', { name: route.heading })).length
      ).toBeGreaterThan(0);
      await screen.findByText(route.empty);
      await act(async () => {
        oldAlias.resolve(route.oldId);
      });
      expect(
        screen.queryByRole('heading', {
          name: route.from === 'club' ? 'Club Weekly Accounting' : 'Union Weekly Accounting',
        })
      ).not.toBeInTheDocument();
      expect(m.calls.every((call) => call.table === route.table)).toBe(true);
      expect(
        m.rpc.mock.calls.every(
          ([, args]) => args.p_scope_kind === route.to && args.p_scope_id === route.targetId
        )
      ).toBe(true);
    }
  );

  it('retires delayed club receipts through club to union to club route changes instead of republishing the first club view', async () => {
    const oldStatus = deferred<Reply>();
    const oldSummary = deferred<Reply>();
    m.rpc.mockReturnValueOnce(oldStatus.promise);
    let firstSummary = true;
    m.reply = (call) => {
      if (call.table === 'settlement_invoices' && firstSummary) {
        firstSummary = false;
        return oldSummary.promise;
      }
      return { data: [], error: null };
    };
    render(<RoutedPages initial={`/clubs/${ID.club}/settlement`} />);
    await waitFor(() =>
      expect(m.calls.some((call) => call.table === 'settlement_invoices')).toBe(true)
    );
    await waitFor(() => expect(m.rpc).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole('link', { name: 'Test Open Union' }));
    await screen.findByText('No Recorded Periods Were Found For This Union.');
    fireEvent.click(screen.getByRole('link', { name: 'Test Open Club' }));
    await screen.findByText('No Issued Weekly Summaries Were Found For This Club.');
    await act(async () => {
      oldStatus.resolve({ data: postedClub(), error: null });
      oldSummary.resolve({ data: [weeklyStatementRow()], error: null });
    });
    expect(screen.queryByText('Automatic Weekly Accounting Posted')).not.toBeInTheDocument();
    expect(screen.queryByText('100.25 Chips')).not.toBeInTheDocument();
    expect(
      screen.queryByRole('heading', { name: 'Recorded Union Periods' })
    ).not.toBeInTheDocument();
    expect(
      screen.getByText('No Issued Weekly Summaries Were Found For This Club.')
    ).toBeInTheDocument();
    expectOnlyObserverRPCs();
  });

  it('retires a delayed routed account A-B-A receipt even when both auth events precede the next render', async () => {
    const oldStatus = deferred<Reply>();
    const oldSummary = deferred<Reply>();
    m.rpc.mockReturnValueOnce(oldStatus.promise);
    let firstSummary = true;
    m.reply = (call) => {
      if (call.table === 'settlement_invoices' && firstSummary) {
        firstSummary = false;
        return oldSummary.promise;
      }
      return { data: [], error: null };
    };
    const view = render(<RoutedPages initial={`/clubs/${ID.club}/settlement`} />);
    await waitFor(() => expect(m.rpc).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(m.calls).toHaveLength(1));
    act(() => {
      auth(ID.otherActor);
      auth(ID.actor);
    });
    view.rerender(<RoutedPages initial={`/clubs/${ID.club}/settlement`} />);
    await screen.findByText('No Issued Weekly Summaries Were Found For This Club.');
    await act(async () => {
      oldStatus.resolve({ data: postedClub(), error: null });
      oldSummary.resolve({ data: [weeklyStatementRow()], error: null });
    });
    expect(screen.queryByText('Automatic Weekly Accounting Posted')).not.toBeInTheDocument();
    expect(screen.queryByText('100.25 Chips')).not.toBeInTheDocument();
    expect(m.rpc).toHaveBeenLastCalledWith('fn_accounting_run_observation_v1', {
      p_expected_actor_id: ID.actor,
      p_scope_kind: 'club',
      p_scope_id: ID.club,
      p_period_start: WEEK_START,
      p_period_end: WEEK_END,
    });
    expectOnlyObserverRPCs();
  });
});

describe('routed settlement dashboard boundaries', () => {
  it('hides the union directory when permission is denied while preserving club selection and the current ledger', () => {
    m.canOperateUnionNetwork = false;
    render(<RoutedPages initial="/settlement-dashboard" />);
    expect(screen.queryByRole('button', { name: 'Open Unions' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open Clubs' })).toBeInTheDocument();
    expect(screen.getByTestId('transaction-ledger')).toHaveAttribute('data-user', ID.actor);
    expect(screen.queryByLabelText('Week Ending Monday')).not.toBeInTheDocument();
    expect(m.rpc).not.toHaveBeenCalled();
    expect(m.calls).toHaveLength(0);
  });

  it.each([
    { label: 'Open Clubs', path: '/clubs' },
    { label: 'Open Unions', path: '/unions' },
  ])(
    'preserves platform selection $label and the authenticated user ledger without inventing a global accounting run',
    async (destination) => {
      m.canOperateUnionNetwork = destination.path === '/unions';
      render(<RoutedPages initial="/settlement-dashboard" />);
      expect(
        screen.getByText(/Choose A Club Or Union From Its Accounting Page/)
      ).toBeInTheDocument();
      expect(screen.getByTestId('transaction-ledger')).toHaveAttribute('data-user', ID.actor);
      expect(screen.getByTestId('transaction-ledger')).toHaveAttribute('data-club', '');
      expect(screen.getByTestId('transaction-ledger')).toHaveAttribute('data-club-scoped', 'false');
      expect(screen.getByTestId('transaction-ledger')).toHaveAttribute('data-limit', '25');
      expect(m.rpc).not.toHaveBeenCalled();
      expect(m.calls).toHaveLength(0);
      expect(screen.queryByLabelText('Week Ending Monday')).not.toBeInTheDocument();
      expectNoManualAccountingControls();
      fireEvent.click(screen.getByRole('button', { name: destination.label }));
      expect(screen.getByTestId('current-path')).toHaveTextContent(destination.path);
    }
  );

  it('uses the selected canonical club workspace and scopes the retained ledger to that club', async () => {
    m.dashboard = { ...m.dashboard, clubId: ID.club, platformWide: false, clubRole: 'owner' };
    m.rows.settlement_invoices = [weeklyStatementRow()];
    render(<RoutedPages initial="/settlement-dashboard" />);
    expect(await screen.findByText('100.25 Chips')).toBeInTheDocument();
    expect(screen.getByTestId('transaction-ledger')).toHaveAttribute('data-club', ID.club);
    expect(screen.getByTestId('transaction-ledger')).toHaveAttribute('data-user', '');
    expect(screen.getByTestId('transaction-ledger')).toHaveAttribute('data-club-scoped', 'true');
    expect(screen.getByTestId('transaction-ledger')).toHaveAttribute('data-limit', '25');
    expect(screen.queryByRole('button', { name: 'Open Clubs' })).not.toBeInTheDocument();
    expect(m.rpc).toHaveBeenCalledWith('fn_accounting_run_observation_v1', {
      p_expected_actor_id: ID.actor,
      p_scope_kind: 'club',
      p_scope_id: ID.club,
      p_period_start: WEEK_START,
      p_period_end: WEEK_END,
    });
    expectNoManualAccountingControls();
    expectOnlyObserverRPCs();
    expect(screen.getByRole('link', { name: 'Open Club Cashier And Records' })).toHaveAttribute(
      'href',
      `/clubs/${ID.club}/cashier`
    );
  });

  it('removes the selected workspace and ledger when its account no longer matches the financial scope', async () => {
    m.dashboard = { ...m.dashboard, clubId: ID.club, platformWide: false, clubRole: 'owner' };
    m.rows.settlement_invoices = [weeklyStatementRow()];
    const view = render(<RoutedPages initial="/settlement-dashboard" />);
    await screen.findByText('100.25 Chips');
    act(() => {
      auth(ID.otherActor);
    });
    view.rerender(<RoutedPages initial="/settlement-dashboard" />);
    expect(
      screen.getByText('Accounting Is Unavailable Until This Account Is Ready.')
    ).toBeInTheDocument();
    expect(screen.queryByTestId('transaction-ledger')).not.toBeInTheDocument();
    expect(screen.queryByText('100.25 Chips')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Week Ending Monday')).not.toBeInTheDocument();
    expect(m.rpc.mock.calls.every(([, args]) => args.p_expected_actor_id === ID.actor)).toBe(true);
  });
});
