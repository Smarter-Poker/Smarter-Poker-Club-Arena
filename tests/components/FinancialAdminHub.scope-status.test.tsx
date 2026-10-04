import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Scope = {
  status: 'ready';
  clubId: string | null;
  platformWide: boolean;
  clubRole: string | null;
  isPlatformStaff: boolean;
  userId: string;
  message: null;
  reload: () => void;
};

function revenueSeries(clubId: string | null, scope: 'club' | 'platform' = 'club') {
  const end = new Date();
  end.setUTCHours(0, 0, 0, 0);
  end.setUTCDate(end.getUTCDate() - 1);
  const start = new Date(end.getTime() - 6 * 86400000);
  return {
    contract: 'ca_financial_admin_revenue_series_v1',
    basis: 'cash_rake_plus_tournament_fees',
    includes_live_day: false,
    scope,
    club_id: clubId,
    range_days: 7,
    range_start: start.toISOString().slice(0, 10),
    range_end: end.toISOString().slice(0, 10),
    daily: Array.from({ length: 7 }, (_, index) => ({
      d: new Date(start.getTime() + index * 86400000).toISOString().slice(0, 10),
      cash_rake: index === 6 ? 5999.75 : 0,
      tournament_fees: index === 6 ? 1.25 : 0,
      revenue: index === 6 ? 6001 : 0,
    })),
    period_total: 6001,
    data_updated_at: new Date().toISOString(),
    generated_at: new Date().toISOString(),
  };
}

type Read = {
  table: string;
  columns: string;
  countQuery: boolean;
  filters: Record<string, unknown>;
};

const m = vi.hoisted(() => ({
  user: { id: 'owner-a' },
  scope: {
    status: 'ready',
    clubId: 'club-a',
    platformWide: false,
    clubRole: 'owner',
    isPlatformStaff: false,
    userId: 'owner-a',
    message: null,
    reload: vi.fn(),
  } as Scope,
  response: vi.fn(),
  getUnions: vi.fn(),
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() },
}));

function fallback(read: Read) {
  if (read.table === 'financial_health_checks' && read.columns === 'passed') {
    return { data: { passed: true }, count: null, error: null };
  }
  if (read.table === 'fn_ca_incident_dashboard') {
    return { data: [], count: null, error: null };
  }
  if (read.table === 'ca_financial_admin_revenue_series') {
    const clubId = (read.filters.p_club_id as string | null | undefined) ?? null;
    return {
      data: revenueSeries(clubId, clubId === null ? 'platform' : 'club'),
      count: null,
      error: null,
    };
  }
  return { data: [], count: 0, error: null };
}

vi.mock('../../src/lib/supabase', () => {
  class Query {
    read: Read;

    constructor(table: string) {
      this.read = { table, columns: '*', countQuery: false, filters: {} };
    }

    select(columns: string, options?: { count?: string; head?: boolean }) {
      this.read.columns = columns;
      this.read.countQuery = Boolean(options?.head);
      return this;
    }

    eq(column: string, value: unknown) {
      this.read.filters[column] = value;
      return this;
    }

    in(column: string, value: unknown) {
      this.read.filters[column] = value;
      return this;
    }

    gte(column: string, value: unknown) {
      this.read.filters[`${column}:gte`] = value;
      return this;
    }

    lte(column: string, value: unknown) {
      this.read.filters[`${column}:lte`] = value;
      return this;
    }

    order() {
      return this;
    }

    limit() {
      return this;
    }

    maybeSingle() {
      return Promise.resolve(m.response(this.read));
    }

    then(resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) {
      return Promise.resolve(m.response(this.read)).then(resolve, reject);
    }
  }

  return {
    supabase: {
      from: (table: string) => new Query(table),
      rpc: (name: string, args?: Record<string, unknown>) =>
        Promise.resolve(
          m.response({
            table: name,
            columns: '*',
            countQuery: false,
            filters: args || {},
          })
        ),
    },
  };
});

vi.mock('../../src/hooks/useAuthUser', () => ({ useAuthUser: () => ({ user: m.user }) }));
vi.mock('../../src/hooks/useFinancialAdminScope', async (original) => {
  const real = await original<typeof import('../../src/hooks/useFinancialAdminScope')>();
  return { ...real, useFinancialAdminScope: () => m.scope };
});
vi.mock('../../src/hooks/useVisibilityRefresh', () => ({ useVisibilityRefresh: vi.fn() }));
vi.mock('../../src/components/common/Toast', () => ({ useToast: () => m.toast }));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: vi.fn() }));
vi.mock('../../src/services/UnionService', () => ({
  unionService: { getUnions: (...args: unknown[]) => m.getUnions(...args) },
}));
vi.mock('../../src/components/union/UnionOpsPanel', () => ({ default: () => null }));
vi.mock('recharts', () => ({
  ResponsiveContainer: ({ children }: { children: unknown }) => children,
  AreaChart: ({ children }: { children: unknown }) => children,
  Area: () => null,
  XAxis: () => null,
}));

import FinancialAdminHub from '../../src/pages/FinancialAdminHub';

const mount = () =>
  render(
    <MemoryRouter>
      <FinancialAdminHub />
    </MemoryRouter>
  );

beforeEach(() => {
  vi.clearAllMocks();
  m.user = { id: 'owner-a' };
  m.scope = {
    status: 'ready',
    clubId: 'club-a',
    platformWide: false,
    clubRole: 'owner',
    isPlatformStaff: false,
    userId: 'owner-a',
    message: null,
    reload: vi.fn(),
  };
  m.response.mockImplementation(fallback);
  m.getUnions.mockResolvedValue([]);
});

afterEach(() => cleanup());

describe('financial admin reading identity and health truth', () => {
  it('shows an unverified state when one dependent read fails, never a false all clear', async () => {
    m.response.mockImplementation((read: Read) =>
      read.table === 'financial_alerts'
        ? { data: null, count: null, error: new Error('Alert Read Refused') }
        : fallback(read)
    );
    mount();

    expect(
      await screen.findByText(
        'Financial Status Could Not Be Verified. No All Clear Is Being Shown.'
      )
    ).toBeInTheDocument();
    expect(screen.queryByText('Checks Passing')).toBeNull();
    expect(screen.queryByText(/All Services Operational/)).toBeNull();
  });

  it('shows an unverified state for a malformed successful revenue response', async () => {
    m.response.mockImplementation((read: Read) =>
      read.table === 'ca_financial_admin_revenue_series'
        ? {
            data: {
              ...revenueSeries('club-a'),
              daily: [{ d: 'not-a-date', cash_rake: 10, tournament_fees: 0, revenue: 10 }],
            },
            count: null,
            error: null,
          }
        : fallback(read)
    );
    mount();

    expect(
      await screen.findByText(
        'Financial Status Could Not Be Verified. No All Clear Is Being Shown.'
      )
    ).toBeInTheDocument();
    expect(screen.queryByText('Checks Passing')).toBeNull();
  });

  it('rejects coercible non-numeric values instead of treating them as ledger money', async () => {
    const series = revenueSeries('club-a');
    series.daily[6] = { ...series.daily[6], revenue: true as unknown as number };
    m.response.mockImplementation((read: Read) =>
      read.table === 'ca_financial_admin_revenue_series'
        ? { data: series, count: null, error: null }
        : fallback(read)
    );
    mount();

    expect(
      await screen.findByText(
        'Financial Status Could Not Be Verified. No All Clear Is Being Shown.'
      )
    ).toBeInTheDocument();
  });

  it('rejects a revenue component mismatch instead of displaying an invented total', async () => {
    const series = revenueSeries('club-a');
    series.daily[6] = { ...series.daily[6], tournament_fees: 2 };
    m.response.mockImplementation((read: Read) =>
      read.table === 'ca_financial_admin_revenue_series'
        ? { data: series, count: null, error: null }
        : fallback(read)
    );
    mount();

    expect(
      await screen.findByText(
        'Financial Status Could Not Be Verified. No All Clear Is Being Shown.'
      )
    ).toBeInTheDocument();
  });

  it('reads the complete bounded revenue RPC and never downloads raw rake rows', async () => {
    mount();

    expect(await screen.findByText('6K Chips')).toBeInTheDocument();
    expect(screen.getByLabelText('Seven Complete Days Revenue')).toBeInTheDocument();
    expect(screen.getByText(/Reading Window/).parentElement).toHaveTextContent(/UTC/);
    expect(m.response).toHaveBeenCalledWith(
      expect.objectContaining({
        table: 'ca_financial_admin_revenue_series',
        filters: { p_club_id: 'club-a', p_days: 7 },
      })
    );
    expect(m.response).not.toHaveBeenCalledWith(expect.objectContaining({ table: 'rake_records' }));
  });

  it('hides the platform-only Financial Alerts door from club finance operators', async () => {
    mount();

    expect(await screen.findByRole('navigation', { name: 'Financial Tools' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Financial Alerts/i })).toBeNull();
  });

  it('shows the Financial Alerts door to verified platform staff', async () => {
    m.scope = {
      ...m.scope,
      clubId: null,
      platformWide: true,
      clubRole: null,
      isPlatformStaff: true,
    };
    mount();

    expect(await screen.findByRole('link', { name: /Financial Alerts/i })).toBeInTheDocument();
  });

  it('rejects a late club A reading after the signed-in viewer moves to club B', async () => {
    let resolveOld!: (value: unknown) => void;
    const oldDisputes = new Promise((resolve) => {
      resolveOld = resolve;
    });
    m.response.mockImplementation((read: Read) => {
      if (read.table === 'disputes' && read.filters.club_id === 'club-a') return oldDisputes;
      if (read.table === 'financial_alerts' && m.scope.clubId === 'club-b') {
        return { data: [], count: 2, error: null };
      }
      return fallback(read);
    });
    const view = mount();

    m.user = { id: 'owner-b' };
    m.scope = { ...m.scope, clubId: 'club-b', userId: 'owner-b' };
    view.rerender(
      <MemoryRouter>
        <FinancialAdminHub />
      </MemoryRouter>
    );

    const alerts = await screen.findByText('Active Alerts');
    expect(within(alerts.closest('div')!).getByText('2')).toBeInTheDocument();
    await act(async () => resolveOld({ data: [], count: 99, error: null }));
    await waitFor(() => expect(screen.queryByText('99')).toBeNull());
    expect(
      within(screen.getByText('Active Alerts').closest('div')!).getByText('2')
    ).toBeInTheDocument();
  });
});
