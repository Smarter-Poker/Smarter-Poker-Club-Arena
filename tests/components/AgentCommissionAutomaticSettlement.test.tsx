import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const state = vi.hoisted(() => ({
  user: { id: 'agent-a' } as { id: string } | null,
  rpc: vi.fn(),
  owed: vi.fn(),
  downline: vi.fn(),
  leave: vi.fn(),
  query: vi.fn(),
  report: vi.fn(),
  records: [] as Record<string, unknown>[],
  agents: [] as Record<string, unknown>[],
  profiles: [] as Record<string, unknown>[],
  clubs: [] as Record<string, unknown>[],
}));
type Query = { table: string; filters: Record<string, unknown>; single: boolean };
const clubA = '11111111-1111-4111-8111-111111111111';
const clubB = '22222222-2222-4222-8222-222222222222';
vi.mock('../../src/hooks/useAuthUser', () => ({ useAuthUser: () => ({ user: state.user }) }));
vi.mock('../../src/hooks/useStaggerAnimation', () => ({
  useStaggerAnimation: () => ({ style: () => ({}) }),
}));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: state.report }));
vi.mock('../../src/components/common/Toast', () => ({ useToast: () => ({ error: vi.fn() }) }));
vi.mock('../../src/lib/openExternal', () => ({ leaveForHub: state.leave }));
vi.mock('../../src/services/CommissionService', () => ({
  CommissionService: { unsettledCommission: state.owed, downlineCommission: state.downline },
}));
vi.mock('../../src/core/MasterBus', () => ({
  masterBus: {
    getOrCreateChannel: () => {
      const channel = { on: () => channel, subscribe: () => channel };
      return channel;
    },
    removeRegisteredChannel: vi.fn(),
    subscribeDebounced: () => vi.fn(),
  },
}));
vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    rpc: state.rpc,
    from: (table: string) => {
      const filters: Record<string, unknown> = {};
      const query = {
        select: () => query,
        eq: (column: string, value: unknown) => {
          filters[column] = value;
          return query;
        },
        in: (column: string, value: unknown[]) => {
          filters[column] = value;
          return query;
        },
        order: () => query,
        limit: () => query,
        maybeSingle: () => state.query({ table, filters, single: true }),
        then: (resolve: (value: unknown) => void) =>
          Promise.resolve(state.query({ table, filters, single: false })).then(resolve),
      };
      return query;
    },
  },
}));
import { AgentCommissionDashboard } from '../../src/components/agent/AgentCommissionDashboard';
import { clearClubUUIDCache } from '../../src/utils/clubIdResolver';
const answerQuery = ({ table, filters, single }: Query) => {
  const rows = (
    table === 'v_agent_commissions'
      ? state.records
      : table === 'agents'
        ? state.agents
        : table === 'profiles'
          ? state.profiles
          : table === 'clubs'
            ? state.clubs
            : []
  ).filter((row) =>
    Object.entries(filters).every(([key, value]) =>
      Array.isArray(value) ? value.includes(row[key]) : row[key] === value
    )
  );
  return single && rows.length > 1
    ? { data: null, error: { message: 'Multiple Rows' } }
    : { data: single ? (rows[0] ?? null) : rows, error: null };
};
const summary = (total = 100.25) => ({
  data: {
    total_earned: total,
    this_week: 10.25,
    this_month: 40.25,
    pending_payout: 9999.99,
    last_payout: null,
  },
  error: null,
});
beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  state.rpc.mockReset();
  state.owed.mockReset();
  state.downline.mockReset();
  state.query.mockReset();
  localStorage.clear();
  clearClubUUIDCache();
  state.user = { id: 'agent-a' };
  state.records = [];
  state.agents = [];
  state.profiles = [];
  state.clubs = [
    { id: clubA, club_id: 301101, slug: 'club-a' },
    { id: clubB, club_id: 301102, slug: 'club-b' },
  ];
  state.query.mockImplementation(answerQuery);
  state.rpc.mockResolvedValue(summary());
  state.owed.mockResolvedValue(45.67);
  state.downline.mockResolvedValue([]);
});
describe('one automatic commission settlement path', () => {
  it('shows the real unpaid amount and opens invoices without a client payout call', async () => {
    render(<AgentCommissionDashboard clubId="club-a" />);
    await screen.findByText('Automatic Weekly Settlement');
    expect(screen.getByText('Scheduled Every Monday At 4:00 AM Central Time.')).toBeDefined();
    expect(screen.getAllByText('45.67').length).toBeGreaterThan(0);
    expect(screen.queryByText('9,999.99')).toBeNull();
    expect(screen.queryByText('Claim Commission')).toBeNull();
    fireEvent.click(screen.getByText('View Invoices'));
    expect(state.leave).toHaveBeenCalledWith(`/hub/messenger?clubId=${clubA}&folder=invoices`);
    expect(state.rpc.mock.calls.every(([name]) => name === 'fn_get_agent_commission_summary')).toBe(
      true
    );
  });
  it('keeps a failed unpaid read unavailable rather than using the summary fallback', async () => {
    state.owed.mockRejectedValueOnce(new Error('Unavailable'));
    render(<AgentCommissionDashboard clubId="club-a" />);
    await screen.findByText('Automatic Weekly Settlement');
    expect(screen.getAllByText('Unavailable').length).toBeGreaterThan(0);
    expect(screen.queryByText('9,999.99')).toBeNull();
  });
  it('ignores a previous clubs delayed summary after the selected club changes', async () => {
    let finish!: (value: unknown) => void;
    state.rpc.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      })
    );
    const view = render(<AgentCommissionDashboard clubId="club-a" />);
    await waitFor(() => expect(state.rpc).toHaveBeenCalledTimes(1));
    state.rpc.mockResolvedValueOnce(summary(77.77));
    view.rerender(<AgentCommissionDashboard clubId="club-b" />);
    await screen.findAllByText('77.77');
    await act(async () => {
      finish(summary(1234.56));
    });
    expect(screen.queryByText('1,234.56')).toBeNull();
    expect(state.owed).toHaveBeenCalledWith(clubB, 'agent-a');
    expect(state.owed).not.toHaveBeenCalledWith(clubA, 'agent-a');
  });
  it('removes financial data immediately on signout', async () => {
    const view = render(<AgentCommissionDashboard clubId="club-a" />);
    await screen.findByText('Automatic Weekly Settlement');
    state.user = null;
    view.rerender(<AgentCommissionDashboard clubId="club-a" />);
    expect(screen.queryByText('45.67')).toBeNull();
    expect(screen.getByText('Sign In To View Your Commission')).toBeDefined();
  });
  it('does not invent a zero summary when the server response is incomplete', async () => {
    state.rpc.mockResolvedValueOnce({ data: { total_earned: 1 }, error: null });
    render(<AgentCommissionDashboard clubId="club-a" />);
    await screen.findByText('Your Commission Summary Could Not Be Loaded.');
    expect(screen.queryByText('Total Earned')).toBeNull();
  });
  it('labels records paid only when the settlement-aware reader records payment', async () => {
    state.records = [
      {
        id: 'one',
        club_id: clubA,
        user_id: 'agent-a',
        amount: 12.34,
        source_type: 'rake',
        created_at: '2026-09-13T10:00Z',
        settled_at: null,
      },
      {
        id: 'two',
        club_id: clubA,
        user_id: 'agent-a',
        amount: 23.45,
        source_type: 'rake',
        created_at: '2026-09-13T10:00Z',
        settled_at: '2026-09-14T10:00Z',
        settled_via: 'round2',
      },
    ];
    render(<AgentCommissionDashboard clubId="club-a" />);
    await screen.findByText('Automatic Weekly Settlement');
    fireEvent.click(screen.getByText('Records'));
    expect(screen.getByText('unpaid')).toBeDefined();
    expect(screen.getByText('paid')).toBeDefined();
  });

  it.each(['301101', 'club-a', clubA])(
    'resolves %s before every club read and invoice navigation',
    async (route) => {
      state.agents = [{ id: 'me-a', club_id: clubA, user_id: 'agent-a' }];
      render(<AgentCommissionDashboard clubId={route} />);
      await screen.findByText('Automatic Weekly Settlement');
      expect(state.rpc).toHaveBeenCalledWith('fn_get_agent_commission_summary', {
        p_agent_id: 'agent-a',
        p_club_id: clubA,
      });
      expect(state.owed).toHaveBeenCalledWith(clubA, 'agent-a');
      expect(state.downline).toHaveBeenCalledWith(clubA);
      for (const [{ table, filters }] of state.query.mock.calls) {
        if (table !== 'clubs') expect(filters.club_id).toBe(clubA);
      }
      fireEvent.click(screen.getByText('View Invoices'));
      expect(state.leave).toHaveBeenCalledWith(`/hub/messenger?clubId=${clubA}&folder=invoices`);
    }
  );

  it('fails closed when a friendly club route cannot be resolved and allows retry', async () => {
    state.query.mockImplementation((query: Query) =>
      query.table === 'clubs'
        ? { data: null, error: { message: 'Read Denied' } }
        : answerQuery(query)
    );
    render(<AgentCommissionDashboard clubId="301101" />);
    await screen.findByText('Your Commission Data Could Not Be Loaded.');
    expect(state.rpc).not.toHaveBeenCalled();
    expect(state.owed).not.toHaveBeenCalled();
    expect(state.query.mock.calls.every(([q]) => q.table === 'clubs')).toBe(true);
    expect(screen.queryByText('View Invoices')).toBeNull();
    state.query.mockImplementation(answerQuery);
    fireEvent.click(screen.getByText('Try Again'));
    await screen.findByText('Automatic Weekly Settlement');
    expect(state.owed).toHaveBeenCalledWith(clubA, 'agent-a');
  });

  it('does not start financial reads for an old route after delayed club resolution', async () => {
    let finish!: (value: unknown) => void;
    state.query.mockImplementation((query: Query) =>
      query.table === 'clubs' && query.filters.slug === 'club-a'
        ? new Promise((resolve) => {
            finish = resolve;
          })
        : answerQuery(query)
    );
    const view = render(<AgentCommissionDashboard clubId="club-a" />);
    await waitFor(() => expect(finish).toBeDefined());
    view.rerender(<AgentCommissionDashboard clubId="club-b" />);
    await screen.findByText('Automatic Weekly Settlement');
    await act(async () => finish({ data: { id: clubA }, error: null }));
    expect(state.rpc).toHaveBeenCalledTimes(1);
    expect(state.owed).toHaveBeenCalledTimes(1);
    expect(state.owed).toHaveBeenCalledWith(clubB, 'agent-a');
    fireEvent.click(screen.getByText('View Invoices'));
    expect(state.leave).toHaveBeenCalledWith(`/hub/messenger?clubId=${clubB}&folder=invoices`);
  });

  it('shows only the selected clubs downline for an agent who belongs to two clubs', async () => {
    state.agents = [
      { id: 'me-a', club_id: clubA, user_id: 'agent-a' },
      { id: 'me-b', club_id: clubB, user_id: 'agent-a' },
      { id: 'down-a', club_id: clubA, user_id: 'user-a', parent_agent_id: 'me-a' },
      { id: 'down-b', club_id: clubB, user_id: 'user-b', parent_agent_id: 'me-b' },
      { id: 'cross-club', club_id: clubB, user_id: 'cross-user', parent_agent_id: 'me-a' },
    ];
    state.profiles = [
      { id: 'user-a', alias: 'Alpha' },
      { id: 'user-b', alias: 'Beta' },
      { id: 'cross-user', alias: 'Cross-Club' },
    ];
    state.downline.mockImplementation(async (clubId: string) =>
      clubId === clubA
        ? [{ agentId: 'down-a', userId: 'user-a', unclaimed: 12.34 }]
        : [{ agentId: 'down-b', userId: 'user-b', unclaimed: 56.78 }]
    );
    const view = render(<AgentCommissionDashboard clubId="301101" />);
    await screen.findByText('Automatic Weekly Settlement');
    fireEvent.click(screen.getByText('Sub-Agents'));
    expect(screen.getByText('Alpha')).toBeDefined();
    expect(screen.getByText('12.34')).toBeDefined();
    expect(screen.queryByText('Beta')).toBeNull();
    expect(screen.queryByText('Cross-Club')).toBeNull();
    view.rerender(<AgentCommissionDashboard clubId="club-b" />);
    expect(screen.queryByText('Alpha')).toBeNull();
    await screen.findByText('Beta');
    expect(screen.getByText('56.78')).toBeDefined();
    expect(screen.queryByText('Alpha')).toBeNull();
  });

  it.each(['records', 'agent', 'subagents', 'profiles'])(
    'surfaces a failed %s query',
    async (failed) => {
      state.agents = [
        { id: 'me-a', user_id: 'agent-a', club_id: clubA },
        { id: 'down-a', user_id: 'user-a', parent_agent_id: 'me-a', club_id: clubA },
      ];
      state.downline.mockResolvedValue([{ agentId: 'down-a', userId: 'user-a', unclaimed: 12.34 }]);
      state.query.mockImplementation((query: Query) => {
        const rejects =
          failed === 'records'
            ? query.table === 'v_agent_commissions'
            : failed === 'profiles'
              ? query.table === 'profiles'
              : query.table === 'agents' && query.single === (failed === 'agent');
        return rejects
          ? { data: null, error: { message: 'Permission Denied' } }
          : answerQuery(query);
      });
      render(<AgentCommissionDashboard clubId="club-a" />);
      await screen.findByText('Automatic Weekly Settlement');
      fireEvent.click(screen.getByText(failed === 'records' ? 'Records' : 'Sub-Agents'));
      expect(screen.getByRole('alert').textContent).toContain('Could Not Be Loaded.');
      expect(screen.getByText('Try Again')).toBeDefined();
      expect(screen.queryByText('No Commission Records Yet')).toBeNull();
      expect(screen.queryByText('No Sub-Agents Yet')).toBeNull();
      expect(state.report).toHaveBeenCalled();
    }
  );

  it('does not invent a zero when a sub-agent balance is missing from the reader', async () => {
    state.agents = [
      { id: 'me-a', user_id: 'agent-a', club_id: clubA },
      { id: 'down-a', user_id: 'user-a', parent_agent_id: 'me-a', club_id: clubA },
    ];
    state.profiles = [{ id: 'user-a', alias: 'Alpha' }];
    render(<AgentCommissionDashboard clubId="club-a" />);
    await screen.findByText('Automatic Weekly Settlement');
    fireEvent.click(screen.getByText('Sub-Agents'));
    expect(screen.getByText('Sub-Agent Commission Balances Could Not Be Loaded.')).toBeDefined();
    expect(screen.getByText('Unavailable')).toBeDefined();
    expect(screen.queryByText('0')).toBeNull();
  });

  it('requests club selection rather than running an unscoped single-agent lookup', async () => {
    render(<AgentCommissionDashboard />);
    await screen.findByText('Automatic Weekly Settlement');
    fireEvent.click(screen.getByText('Sub-Agents'));
    expect(screen.getByText('Select A Club To View Its Sub-Agents.')).toBeDefined();
    expect(state.query.mock.calls.some(([q]) => q.table === 'agents')).toBe(false);
    expect(state.downline).not.toHaveBeenCalled();
  });
});
