import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
  getOverseerUnionOptions: vi.fn(),
  unionPanel: vi.fn(),
  responsiveContainer: vi.fn(),
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() },
}));

function fallback(read: Read) {
  if (read.table === 'fn_ca_can_view_drift_console') {
    return { data: m.scope.isPlatformStaff, count: null, error: null };
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
vi.mock('../../src/services/UnionOpsService', () => ({
  UnionOpsService: {
    getOverseerUnionOptions: (...args: unknown[]) => m.getOverseerUnionOptions(...args),
  },
}));
vi.mock('../../src/components/union/UnionOpsPanel', () => ({
  default: (props: { unionId: string; canRun: boolean }) => {
    m.unionPanel(props);
    return <div data-testid="union-ops-panel">Union Operations For {props.unionId}</div>;
  },
}));
vi.mock('recharts', () => ({
  ResponsiveContainer: (props: {
    children: unknown;
    initialDimension?: { width: number; height: number };
  }) => {
    m.responsiveContainer(props);
    return props.children;
  },
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
  m.getOverseerUnionOptions.mockResolvedValue([]);
});

afterEach(() => cleanup());

describe('financial admin reading identity and health truth', () => {
  it('isolates an authorized incident-read failure from verified club financial data', async () => {
    m.response.mockImplementation((read: Read) => {
      if (read.table === 'fn_ca_can_view_drift_console') {
        return { data: true, count: null, error: null };
      }
      if (read.table === 'fn_ca_incident_dashboard') {
        return { data: null, count: null, error: new Error('Incident Read Refused') };
      }
      return fallback(read);
    });
    mount();

    expect(await screen.findByText('6K Chips')).toBeInTheDocument();
    expect(screen.getByText('Incident Status Unavailable')).toBeInTheDocument();
    expect(screen.queryByText('Loaded Drift Incidents')).toBeNull();
    expect(screen.queryByRole('link', { name: /Drift Incidents/i })).toBeNull();
    expect(
      screen.queryByText('Financial Status Could Not Be Verified. No All Clear Is Being Shown.')
    ).toBeNull();
    expect(screen.queryByText(/All Services Operational/)).toBeNull();
  });

  it('does not query or advertise drift incidents when the exact capability is denied', async () => {
    mount();

    expect(await screen.findByText('6K Chips')).toBeInTheDocument();
    expect(screen.queryByText('Loaded Drift Incidents')).toBeNull();
    expect(screen.queryByRole('link', { name: /Drift Incidents/i })).toBeNull();
    expect(m.response).not.toHaveBeenCalledWith(
      expect.objectContaining({ table: 'fn_ca_incident_dashboard' })
    );
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
    expect(screen.queryByText('Scope Reading Complete')).toBeNull();
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
    expect(m.response).not.toHaveBeenCalledWith(
      expect.objectContaining({ table: 'financial_alerts' })
    );
    expect(m.response).not.toHaveBeenCalledWith(
      expect.objectContaining({ table: 'financial_health_checks' })
    );
    expect(m.responsiveContainer).toHaveBeenCalledWith(
      expect.objectContaining({ initialDimension: { width: 280, height: 132 } })
    );
  });

  it('does not expose the retired Financial Alerts door to club finance operators', async () => {
    mount();

    const tools = await screen.findByRole('navigation', { name: 'Financial Tools' });
    expect(tools).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Financial Alerts/i })).toBeNull();
  });

  it('preserves the selected club on scoped financial tools and exposes only truthful doors', async () => {
    mount();

    const tools = await screen.findByRole('navigation', { name: 'Financial Tools' });
    expect(tools).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Credit Admin/i })).toHaveAttribute(
      'href',
      '/credit-admin?club=club-a'
    );
    expect(screen.getByRole('link', { name: /Rate Audit Trail/i })).toHaveAttribute(
      'href',
      '/rate-audit?club=club-a'
    );
    expect(
      screen.getByRole('link', { name: /Open Club Disputes Needing Resolution/i })
    ).toHaveAttribute('href', '/clubs/club-a/disputes');
    expect(screen.getByRole('link', { name: /Settlement History/i })).toHaveAttribute(
      'href',
      '/settlement-history?club=club-a'
    );
    expect(screen.getByRole('link', { name: /Settlement Center/i })).toHaveAttribute(
      'href',
      '/settlement-dashboard?club=club-a'
    );
    expect(screen.queryByRole('link', { name: /^Settlements(?:\s|$)/i })).toBeNull();
    expect(screen.getByRole('link', { name: /Agent Portal/i })).toHaveAttribute(
      'href',
      '/agent-portal'
    );
    expect(screen.queryByRole('link', { name: /Rakeback Dashboard/i })).toBeNull();
    expect(screen.getByRole('link', { name: /CSV Exports/i })).toHaveAttribute(
      'href',
      '/clubs/club-a/financials'
    );
    expect(screen.getByRole('link', { name: /CSV Exports/i })).not.toHaveAttribute(
      'href',
      '/wallet'
    );
    expect(screen.getByRole('link', { name: /CSV Exports/i })).not.toHaveAttribute(
      'href',
      '/transactions'
    );
  });

  it('does not expose the retired Financial Alerts door to platform staff', async () => {
    m.scope = {
      ...m.scope,
      clubId: null,
      platformWide: true,
      clubRole: null,
      isPlatformStaff: true,
    };
    mount();

    const tools = await screen.findByRole('navigation', { name: 'Financial Tools' });
    expect(tools).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Financial Alerts/i })).toBeNull();
    expect(screen.getByRole('link', { name: /Drift Incidents/i })).toHaveAttribute(
      'href',
      '/financial-incidents'
    );
    expect(screen.queryByRole('link', { name: /CSV Exports/i })).toBeNull();
    expect(screen.queryByRole('link', { name: /Credit Admin/i })).toBeNull();
    expect(screen.queryByRole('link', { name: /Club Disputes/i })).toBeNull();
    expect(screen.getByRole('link', { name: /My Disputes/i })).toHaveAttribute('href', '/disputes');
    expect(
      within(tools)
        .getAllByRole('link')
        .some((link) => link.getAttribute('href')?.startsWith('/clubs/'))
    ).toBe(false);
    expect(screen.queryByRole('link', { name: /Agent Portal/i })).toBeNull();
    expect(screen.queryByRole('link', { name: /Settlement History/i })).toBeNull();
  });

  it('hides Credit Admin from platform staff without a qualifying role in the selected club', async () => {
    m.scope = {
      ...m.scope,
      clubRole: null,
      isPlatformStaff: true,
    };
    mount();

    expect(await screen.findByRole('navigation', { name: 'Financial Tools' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Credit Admin/i })).toBeNull();
  });

  it('rejects a late club A reading after the signed-in viewer moves to club B', async () => {
    let resolveOld!: (value: unknown) => void;
    const oldDisputes = new Promise((resolve) => {
      resolveOld = resolve;
    });
    m.response.mockImplementation((read: Read) => {
      if (read.table === 'disputes' && read.filters.club_id === 'club-a') return oldDisputes;
      if (read.table === 'fn_ca_can_view_drift_console') {
        return { data: m.scope.clubId === 'club-b', count: null, error: null };
      }
      if (read.table === 'fn_ca_incident_dashboard' && m.scope.clubId === 'club-b') {
        return {
          data: [
            { status: 'open', club_id: 'club-b' },
            { status: 'acknowledged', club_id: 'club-b' },
          ],
          count: null,
          error: null,
        };
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

    const incidents = await screen.findByText('Loaded Drift Incidents');
    expect(within(incidents.closest('div')!).getByText('2')).toBeInTheDocument();
    await act(async () => resolveOld({ data: [], count: 99, error: null }));
    await waitFor(() => expect(screen.queryByText('99')).toBeNull());
    expect(
      within(screen.getByText('Loaded Drift Incidents').closest('div')!).getByText('2')
    ).toBeInTheDocument();
  });
});

describe('financial admin exact overseer union gate', () => {
  it('shows a list failure and mounts no Union Ops panel or report reads', async () => {
    m.getOverseerUnionOptions.mockRejectedValueOnce(new Error('permission denied'));
    mount();

    expect(await screen.findByText('Unions Could Not Be Loaded')).toBeInTheDocument();
    expect(screen.queryByTestId('union-ops-panel')).toBeNull();
    expect(m.unionPanel).not.toHaveBeenCalled();
    expect(m.response.mock.calls.some(([read]: [Read]) => read.table.startsWith('fn_union_'))).toBe(
      false
    );
  });

  it('keeps the panel and mutation controls absent when no authorized unions exist', async () => {
    m.getOverseerUnionOptions.mockResolvedValueOnce([]);
    mount();

    expect(await screen.findByText('No Authorized Unions Available')).toBeInTheDocument();
    expect(screen.queryByTestId('union-ops-panel')).toBeNull();
    expect(m.unionPanel).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: /Settlement|Integrity Sweep/i })).toBeNull();
  });

  it('mounts the panel only after an exact authorized union is selected', async () => {
    m.getOverseerUnionOptions.mockResolvedValueOnce([
      { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', name: 'authorized alpha' },
    ]);
    mount();

    const select = (await screen.findByLabelText('Union')) as HTMLSelectElement;
    await waitFor(() => expect(select).toBeEnabled());
    expect(Array.from(select.options).map((option) => option.textContent)).toEqual([
      'Choose An Authorized Union',
      'Authorized Alpha',
    ]);
    expect(screen.queryByTestId('union-ops-panel')).toBeNull();
    expect(m.unionPanel).not.toHaveBeenCalled();

    fireEvent.change(select, {
      target: { value: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
    });
    expect(await screen.findByTestId('union-ops-panel')).toHaveTextContent(
      'Union Operations For aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    );
    expect(m.unionPanel).toHaveBeenLastCalledWith({
      unionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      canRun: true,
    });
  });

  it('ignores an old viewer and scope list after the signed-in scope changes', async () => {
    let resolveOld!: (value: Array<{ id: string; name: string }>) => void;
    m.getOverseerUnionOptions
      .mockImplementationOnce(() => new Promise((resolve) => (resolveOld = resolve)))
      .mockResolvedValue([
        { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', name: 'authorized bravo' },
      ]);
    const view = mount();
    await waitFor(() => expect(m.getOverseerUnionOptions).toHaveBeenCalledTimes(1));

    m.user = { id: 'owner-b' };
    m.scope = {
      ...m.scope,
      clubId: 'club-b',
      userId: 'owner-b',
    };
    view.rerender(
      <MemoryRouter>
        <FinancialAdminHub />
      </MemoryRouter>
    );

    const select = (await screen.findByLabelText('Union')) as HTMLSelectElement;
    await waitFor(() =>
      expect(Array.from(select.options).map((option) => option.textContent)).toContain(
        'Authorized Bravo'
      )
    );
    await act(async () => {
      resolveOld([{ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', name: 'stale alpha' }]);
      await Promise.resolve();
    });
    expect(Array.from(select.options).map((option) => option.textContent)).toEqual([
      'Choose An Authorized Union',
      'Authorized Bravo',
    ]);
    expect(screen.queryByText('Stale Alpha')).toBeNull();
    expect(screen.queryByTestId('union-ops-panel')).toBeNull();
  });
});
