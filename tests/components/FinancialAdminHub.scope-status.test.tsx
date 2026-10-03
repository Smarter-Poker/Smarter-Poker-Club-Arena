import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Scope = {
  status: 'ready';
  clubId: string;
  platformWide: false;
  clubRole: string;
  isPlatformStaff: false;
  userId: string;
  message: null;
  reload: () => void;
};

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
  if (read.table === 'rake_records') return { data: [], count: null, error: null };
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
      rpc: (name: string) =>
        Promise.resolve(
          m.response({
            table: name,
            columns: '*',
            countQuery: false,
            filters: {},
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
      read.table === 'rake_records'
        ? { data: [{ rake_amount: 10, created_at: 'not-a-date' }], count: null, error: null }
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
