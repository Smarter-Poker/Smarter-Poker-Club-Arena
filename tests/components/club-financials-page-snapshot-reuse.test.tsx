import { cleanup, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const CLUB_ID = '11111111-1111-4111-8111-111111111111';
const OWNER_ID = '22222222-2222-4222-8222-222222222222';

const m = vi.hoisted(() => ({
  rpc: vi.fn(),
  resolveClub: vi.fn(),
  dashboardProps: vi.fn(),
  rakeProps: vi.fn(),
  navigate: vi.fn(),
  reportError: vi.fn(),
  isMounted: { current: true },
  clubOwnerId: '22222222-2222-4222-8222-222222222222',
  memberRole: 'owner',
}));

function weekRange() {
  const endDate = new Date();
  const end = endDate.toISOString().slice(0, 10);
  const startDate = new Date(endDate);
  startDate.setUTCDate(startDate.getUTCDate() - 6);
  return { start: startDate.toISOString().slice(0, 10), end };
}

function financialPayload() {
  const { start, end } = weekRange();
  const startMs = Date.parse(`${start}T00:00:00Z`);
  return {
    contract: 'ca_club_financials.v2',
    contract_version: 2,
    club_id: CLUB_ID,
    requested_start: start,
    requested_end: end,
    range: { start, end, days: 7, first_day: start, series_from: start },
    union_id: null,
    totals: {
      raked_hands: 70,
      gross_rake: 700,
      bbj_drop: 0,
      net_rake: 700,
      pot_volume: 7_000,
      tournament_fees: 0,
      rakeback_paid: 0,
      rakeback_rows: 0,
      agent_commissions: 0,
      union_fee: 0,
      union_statements: 0,
      union_squareup: 0,
      net_revenue: 700,
    },
    daily: Array.from({ length: 7 }, (_, index) => ({
      d: new Date(startMs + index * 86_400_000).toISOString().slice(0, 10),
      raked_hands: 10,
      gross_rake: 100,
      bbj_drop: 0,
      pot_volume: 1_000,
      tournament_fees: 0,
      rakeback_paid: 0,
      agent_commissions: 0,
      union_fee: 0,
    })),
    by_table: [],
    recent: [],
    data_updated_at: null,
    club_table_daily_updated_at: null,
    generated_at: new Date().toISOString(),
  };
}

vi.mock('../../src/lib/supabase', () => {
  class Query {
    constructor(private table: string) {}
    select() {
      return this;
    }
    eq() {
      return this;
    }
    maybeSingle() {
      if (this.table === 'clubs') {
        return Promise.resolve({ data: { owner_id: m.clubOwnerId }, error: null });
      }
      return Promise.resolve({ data: { role: m.memberRole }, error: null });
    }
  }
  return {
    supabase: {
      from: (table: string) => new Query(table),
      rpc: (...args: unknown[]) => m.rpc(...args),
    },
  };
});
vi.mock('../../src/utils/strictClubIdResolver', () => ({
  resolveClubUUIDStrict: (...args: unknown[]) => m.resolveClub(...args),
}));
vi.mock('../../src/hooks/useAuthUser', () => ({
  useAuthUser: () => ({ user: { id: OWNER_ID } }),
}));
vi.mock('../../src/hooks/useIsMounted', () => ({ useIsMounted: () => m.isMounted }));
vi.mock('../../src/hooks/useVisibilityRefresh', () => ({ useVisibilityRefresh: vi.fn() }));
vi.mock('../../src/utils/errorReporter', () => ({
  reportError: (...args: unknown[]) => m.reportError(...args),
}));
vi.mock('../../src/core/MasterBus', () => ({
  masterBus: { subscribeDebounced: () => vi.fn() },
}));
vi.mock('../../src/components/common/Toast', () => ({
  useToast: () => ({ error: vi.fn(), success: vi.fn(), info: vi.fn() }),
}));
vi.mock('react-router-dom', async (original) => {
  const actual = await original<typeof import('react-router-dom')>();
  return {
    ...actual,
    useNavigate: () => m.navigate,
    useParams: () => ({ clubId: CLUB_ID }),
  };
});
vi.mock('../../src/components/layouts/StandardContentLayout', () => ({
  default: ({ children }: { children: ReactNode }) => <main>{children}</main>,
}));
vi.mock('../../src/components/console/SpadeConsole', () => ({
  SpadeConsole: ({ title, children }: { title: string; children: ReactNode }) => (
    <section aria-label={title}>{children}</section>
  ),
}));
vi.mock('../../src/components/dashboard/ClubFinancialDashboard', () => ({
  ClubFinancialDashboard: (props: unknown) => {
    m.dashboardProps(props);
    return <div>Dashboard Embed Ready</div>;
  },
}));
vi.mock('../../src/components/admin/RakeReports', () => ({
  default: (props: unknown) => {
    m.rakeProps(props);
    return <div>Rake Embed Ready</div>;
  },
}));
vi.mock('../../src/components/charts/FinancialChart', () => ({ default: () => null }));
vi.mock('../../src/components/common/TransactionLedgerView', () => ({ default: () => null }));
vi.mock('../../src/components/wallet/ChipStatement', () => ({ default: () => null }));
vi.mock('../../src/components/wallet/DynamicWallet', () => ({ default: () => null }));
vi.mock('../../src/components/wallet/WalletCashierModal', () => ({ default: () => null }));
vi.mock('../../src/components/wallet/PlayerWalletModal', () => ({ default: () => null }));

import ClubFinancialsPage from '../../src/pages/ClubFinancialsPage';

beforeEach(() => {
  vi.clearAllMocks();
  m.isMounted.current = true;
  m.resolveClub.mockResolvedValue(CLUB_ID);
  m.rpc.mockResolvedValue({ data: financialPayload(), error: null });
  m.clubOwnerId = OWNER_ID;
  m.memberRole = 'owner';
});

afterEach(() => {
  m.isMounted.current = false;
  cleanup();
});

describe('Club Financials default snapshot reuse', () => {
  it('loads the week once and supplies that verified snapshot to both embedded readers', async () => {
    render(<ClubFinancialsPage />);

    expect(await screen.findByText('Dashboard Embed Ready')).toBeInTheDocument();
    expect(screen.getByText('Rake Embed Ready')).toBeInTheDocument();
    expect(m.rpc.mock.calls.filter(([name]) => name === 'ca_club_financials')).toHaveLength(1);

    const { start, end } = weekRange();
    await waitFor(() => {
      expect(m.dashboardProps).toHaveBeenLastCalledWith(
        expect.objectContaining({
          clubId: CLUB_ID,
          canManageAgents: true,
          initialSnapshot: expect.objectContaining({
            resolvedClubId: CLUB_ID,
            requestedStart: start,
            requestedEnd: end,
          }),
        })
      );
      expect(m.rakeProps).toHaveBeenLastCalledWith(
        expect.objectContaining({
          clubId: CLUB_ID,
          initialSnapshot: expect.objectContaining({
            resolvedClubId: CLUB_ID,
            requestedStart: start,
            requestedEnd: end,
          }),
        })
      );
    });
  });

  it('supplies finance-only super agents a read dashboard without club-control authority', async () => {
    m.clubOwnerId = '33333333-3333-4333-8333-333333333333';
    m.memberRole = 'super_agent';

    render(<ClubFinancialsPage />);

    expect(await screen.findByText('Dashboard Embed Ready')).toBeInTheDocument();
    await waitFor(() => {
      expect(m.dashboardProps).toHaveBeenLastCalledWith(
        expect.objectContaining({ clubId: CLUB_ID, canManageAgents: false })
      );
    });
  });

  it('normalizes backend table names and descriptors at the console print site', async () => {
    const payload = financialPayload();
    payload.by_table = [
      {
        table_id: '33333333-3333-4333-8333-333333333333',
        name: 'river room',
        status: 'running',
        stakes: 'mid stakes',
        variant: 'plo5',
        raked_hands: 12,
        rake: 123,
        players: 6,
        table_net: 123,
      },
    ];
    m.rpc.mockResolvedValue({ data: payload, error: null });

    render(<ClubFinancialsPage />);

    expect(await screen.findByText('River Room')).toBeInTheDocument();
    expect(screen.getByText('PLO5 Mid Stakes - 12 Raked Hands')).toBeInTheDocument();
    expect(screen.queryByText('river room')).not.toBeInTheDocument();
    expect(screen.queryByText(/plo5 mid stakes/)).not.toBeInTheDocument();
  });
});
