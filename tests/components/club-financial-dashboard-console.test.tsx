import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const CLUB_ID = '11111111-1111-4111-8111-111111111111';

const m = vi.hoisted(() => ({
  rpc: vi.fn(),
  tableResponse: vi.fn(),
  resolveClub: vi.fn(),
  mintChips: vi.fn(),
  setRate: vi.fn(),
  reportError: vi.fn(),
  navigate: vi.fn(),
  removeChannel: vi.fn(),
  channel: {
    on: vi.fn(),
    subscribe: vi.fn(),
  },
  isMounted: { current: true },
}));

function range() {
  const endDate = new Date();
  const end = endDate.toISOString().slice(0, 10);
  const startDate = new Date(endDate);
  startDate.setUTCDate(startDate.getUTCDate() - 6);
  return { start: startDate.toISOString().slice(0, 10), end };
}

function financialPayload(unionId: string | null = null) {
  const { start, end } = range();
  const startMs = Date.parse(`${start}T00:00:00Z`);
  const daily = Array.from({ length: 7 }, (_, index) => ({
    d: new Date(startMs + index * 86_400_000).toISOString().slice(0, 10),
    raked_hands: 10,
    gross_rake: 100,
    bbj_drop: 0,
    pot_volume: 1_000,
    tournament_fees: 0,
    rakeback_paid: 0,
    agent_commissions: 0,
    union_fee: 0,
  }));
  return {
    contract: 'ca_club_financials.v2',
    contract_version: 2,
    club_id: CLUB_ID,
    requested_start: start,
    requested_end: end,
    range: { start, end, days: 7, first_day: start, series_from: start },
    union_id: unionId,
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
    daily,
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
    or() {
      return this;
    }
    maybeSingle() {
      return Promise.resolve(m.tableResponse(this.table));
    }
    then(resolveValue: (value: unknown) => unknown, rejectValue: (reason: unknown) => unknown) {
      return Promise.resolve(m.tableResponse(this.table)).then(resolveValue, rejectValue);
    }
  }
  return {
    supabase: {
      from: (table: string) => new Query(table),
      rpc: (...args: unknown[]) => m.rpc(...args),
    },
  };
});

vi.mock('../../src/services/WalletService', () => ({
  WalletService: { mintChips: (...args: unknown[]) => m.mintChips(...args) },
}));
vi.mock('../../src/services/CommissionService', () => ({
  CommissionService: { setRate: (...args: unknown[]) => m.setRate(...args) },
}));
vi.mock('../../src/hooks/useIsMounted', () => ({ useIsMounted: () => m.isMounted }));
vi.mock('../../src/hooks/useVisibilityRefresh', () => ({ useVisibilityRefresh: vi.fn() }));
vi.mock('../../src/utils/errorReporter', () => ({
  reportError: (...args: unknown[]) => m.reportError(...args),
}));
vi.mock('../../src/utils/strictClubIdResolver', () => ({
  resolveClubUUIDStrict: (...args: unknown[]) => m.resolveClub(...args),
}));
vi.mock('../../src/utils/unionScope', () => ({
  clubGamesOrFilter: async (clubId: string) => `club_id.eq.${clubId}`,
}));
vi.mock('../../src/utils/clubDashboard', () => ({
  isAuthzError: (error: { code?: string } | null) => error?.code === '42501',
}));
vi.mock('../../src/core/MasterBus', () => ({
  masterBus: {
    getOrCreateChannel: () => m.channel,
    removeRegisteredChannel: (...args: unknown[]) => m.removeChannel(...args),
  },
}));
vi.mock('react-router-dom', async (original) => {
  const actual = await original<typeof import('react-router-dom')>();
  return { ...actual, useNavigate: () => m.navigate };
});
vi.mock('../../src/components/console/SpadeConsole', () => ({
  SpadeConsole: ({
    title,
    pill,
    plates,
    children,
  }: {
    title: string;
    pill?: string;
    plates?: {
      secondary?: { label: string; onClick?: () => void; disabled?: boolean };
      primary?: { label: string; onClick?: () => void; disabled?: boolean };
    };
    children: React.ReactNode;
  }) => (
    <section aria-label={title}>
      {pill && <span>{pill}</span>}
      {children}
      {plates?.secondary && (
        <button
          type="button"
          onClick={plates.secondary.onClick}
          disabled={plates.secondary.disabled}
        >
          {plates.secondary.label}
        </button>
      )}
      {plates?.primary && (
        <button type="button" onClick={plates.primary.onClick} disabled={plates.primary.disabled}>
          {plates.primary.label}
        </button>
      )}
    </section>
  ),
}));
vi.mock('recharts', () => ({
  ResponsiveContainer: ({ children }: { children: React.ReactNode }) => children,
  AreaChart: ({ children }: { children: React.ReactNode }) => children,
  BarChart: ({ children }: { children: React.ReactNode }) => children,
  Area: () => null,
  Bar: () => null,
  CartesianGrid: () => null,
  XAxis: () => null,
  YAxis: () => null,
}));

import ClubFinancialDashboard from '../../src/components/dashboard/ClubFinancialDashboard';

type InitialSnapshot = NonNullable<
  React.ComponentProps<typeof ClubFinancialDashboard>['initialSnapshot']
>;

const mount = (clubId = CLUB_ID, initialSnapshot?: InitialSnapshot, canManageAgents = true) =>
  render(
    <MemoryRouter>
      <ClubFinancialDashboard
        clubId={clubId}
        canManageAgents={canManageAgents}
        initialSnapshot={initialSnapshot}
      />
    </MemoryRouter>
  );

beforeEach(() => {
  vi.clearAllMocks();
  m.isMounted.current = true;
  m.resolveClub.mockResolvedValue(CLUB_ID);
  m.channel.on.mockReturnValue(m.channel);
  m.channel.subscribe.mockReturnValue(m.channel);
  m.tableResponse.mockImplementation((table: string) =>
    table === 'club_diamond_wallets'
      ? { data: { balance: 1_250 }, error: null }
      : { data: null, count: 4, error: null }
  );
  m.rpc.mockResolvedValue({ data: financialPayload(), error: null });
});

afterEach(() => {
  m.isMounted.current = false;
  cleanup();
});

describe('Club Financial Dashboard console and truth boundary', () => {
  it('renders verified server figures on approved painted consoles', async () => {
    mount();

    expect(await screen.findByText('1.2K')).toBeInTheDocument();
    expect(screen.getAllByText('700')).toHaveLength(2);
    expect(screen.getByText('4')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open Club Bank Cashier' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Open Agent Management' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Open Disputes' })).toBeEnabled();
    expect(screen.queryByRole('button', { name: 'Drift Incidents' })).toBeNull();
    expect(screen.getByText('Shown Before Confirmation')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Mint Chips' })).toBeNull();
    expect(screen.queryByLabelText('Agent UUID')).toBeNull();
    expect(screen.queryByText('Measured Commission Split')).toBeNull();
  });

  it('binds realtime to the verified uuid when the route uses a slug', async () => {
    mount('shark-club');
    await screen.findByText('1.2K');

    await waitFor(() =>
      expect(m.channel.on).toHaveBeenCalledWith(
        'postgres_changes',
        expect.objectContaining({ filter: `club_id=eq.${CLUB_ID}` }),
        expect.any(Function)
      )
    );
    expect(m.resolveClub).toHaveBeenCalledWith('shark-club');
  });

  it('reuses an exact parent snapshot while still reading vault and table facts', async () => {
    const { start, end } = range();
    mount('shark-club', {
      resolvedClubId: CLUB_ID,
      requestedStart: start,
      requestedEnd: end,
      financials: financialPayload(),
    });

    expect(await screen.findByText('1.2K')).toBeInTheDocument();
    expect(screen.getByText('4')).toBeInTheDocument();
    expect(m.resolveClub).not.toHaveBeenCalled();
    expect(m.rpc.mock.calls.filter(([name]) => name === 'ca_club_financials')).toHaveLength(0);
    expect(m.tableResponse).toHaveBeenCalledWith('club_diamond_wallets');
    expect(m.tableResponse).toHaveBeenCalledWith('tables');
  });

  it('shows union-funded truth without a dead local mint action', async () => {
    m.rpc.mockResolvedValue({
      data: financialPayload('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
      error: null,
    });
    mount();

    expect(await screen.findByText('Union Funded')).toBeInTheDocument();
    expect(screen.getByText('Managed By The Union')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Mint Chips' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Open Club Bank Cashier' })).toBeEnabled();
    expect(m.mintChips).not.toHaveBeenCalled();
  });

  it.each([
    [
      'malformed money',
      () => ({
        ...financialPayload(),
        totals: { ...financialPayload().totals, gross_rake: '700' },
      }),
    ],
    ['missing table count', () => financialPayload()],
  ])('fails closed for %s instead of presenting plausible zeroes', async (kind, payloadFactory) => {
    if (kind === 'missing table count') {
      m.tableResponse.mockImplementation((table: string) =>
        table === 'club_diamond_wallets'
          ? { data: { balance: 1_250 }, error: null }
          : { data: null, count: null, error: null }
      );
    } else {
      m.rpc.mockResolvedValue({ data: payloadFactory(), error: null });
    }
    mount();

    expect(
      await screen.findByText(
        'The Financial Reading Could Not Be Verified. No Zero Or All Clear Is Being Shown.'
      )
    ).toBeInTheDocument();
    expect(screen.queryByText('Verified')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Mint Chips' })).toBeNull();
  });

  it('keeps a denied reader out of the mutation controls', async () => {
    m.rpc.mockResolvedValue({ data: null, error: { code: '42501', message: 'denied' } });
    mount();

    expect(
      await screen.findByText('Financial Access Could Not Be Verified For This Club.')
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Mint Chips' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Set Rate' })).toBeNull();
  });

  it('routes financial actions to their maintained selected-club surfaces without mutating money', async () => {
    mount();
    await screen.findByText('1.2K');

    fireEvent.click(screen.getByRole('button', { name: 'Open Club Bank Cashier' }));
    expect(m.navigate).toHaveBeenCalledWith(`/clubs/${CLUB_ID}/cashier`);
    fireEvent.click(screen.getByRole('button', { name: 'Open Agent Management' }));
    expect(m.navigate).toHaveBeenCalledWith(`/clubs/${CLUB_ID}/agents`);
    fireEvent.click(screen.getByRole('button', { name: 'Open Disputes' }));
    expect(m.navigate).toHaveBeenCalledWith(`/clubs/${CLUB_ID}/disputes`);
    expect(m.mintChips).not.toHaveBeenCalled();
    expect(m.setRate).not.toHaveBeenCalled();
  });

  it('routes finance readers without club-control authority to their legitimate agent network', async () => {
    mount(CLUB_ID, undefined, false);
    await screen.findByText('1.2K');

    expect(screen.queryByRole('button', { name: 'Open Agent Management' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Open Agent Network' }));
    expect(m.navigate).toHaveBeenCalledWith(`/clubs/${CLUB_ID}/agent-dashboard`);
    expect(m.setRate).not.toHaveBeenCalled();
  });

  it('contains no generic dashboard paint, emoji, hover control, or horizontal slider', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'src/components/dashboard/ClubFinancialDashboard.tsx'),
      'utf8'
    );
    const styles = readFileSync(
      resolve(process.cwd(), 'src/components/dashboard/ClubFinancialDashboard.css'),
      'utf8'
    );

    expect(source.match(/<SpadeConsole\b/g)).toHaveLength(9);
    expect(source).toContain('parseClubFinancialsPayload');
    expect(source).not.toMatch(/(?:bg|text|border)-(?:gray|purple|orange)-/);
    expect(source).not.toContain('hover:');
    expect(source).not.toContain('<linearGradient');
    expect(source).not.toContain('/financial-incidents');
    expect(source).not.toContain('WalletService');
    expect(source).not.toContain('CommissionService');
    expect(source).not.toContain('Agent UUID');
    expect(source).not.toContain('Measured Commission Split');
    expect(source).not.toMatch(/[⚙⚠]/u);
    expect(styles).not.toContain(':hover');
    expect(styles).not.toContain('linear-gradient');
  });
});
