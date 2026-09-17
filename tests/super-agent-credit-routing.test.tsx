import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Agent } from '../src/services/AgentService';
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const mocks = vi.hoisted(() => ({
  userId: 'user-a',
  ownerId: 'club-owner',
  parentRole: 'admin',
  parentStatus: 'active',
  viewerRole: 'super_agent',
  viewerStatus: 'active',
  agents: vi.fn(),
  players: vi.fn(),
  spread: vi.fn(),
  toast: { error: vi.fn(), success: vi.fn() },
}));
vi.mock('../src/hooks/useAuthUser', () => ({
  useAuthUser: () => ({ user: { id: mocks.userId }, isHydrating: false }),
}));
vi.mock('../src/hooks/useVisibilityRefresh', () => ({ useVisibilityRefresh: vi.fn() }));
vi.mock('../src/components/common/Toast', () => ({ useToast: () => mocks.toast }));
vi.mock('../src/components/common/PageSkeleton', () => ({
  default: () => <p>Loading dashboard</p>,
}));
vi.mock('../src/components/agent/AgentBackOffice', () => ({ default: () => null }));
vi.mock('../src/components/agent/CreditRequestWidget', () => ({
  default: (props: Record<string, unknown>) => (
    <output data-testid="credit-props">{JSON.stringify(props)}</output>
  ),
}));
vi.mock('../src/utils/clubIdResolver', () => ({ resolveClubUUID: async (id: string) => id }));
vi.mock('../src/utils/errorReporter', () => ({ reportError: vi.fn() }));
vi.mock('../src/services/AgentService', () => ({
  AgentService: { getAgents: mocks.agents, getAgentPlayers: mocks.players },
}));
vi.mock('../src/services/CommissionService', () => ({
  CommissionService: { calculateSpread: mocks.spread },
}));
vi.mock('../src/core/MasterBus', () => ({
  masterBus: {
    subscribeDebounced: vi.fn(() => vi.fn()),
    removeRegisteredChannel: vi.fn(),
    emit: vi.fn(),
    getOrCreateChannel: vi.fn(() => {
      const channel: Record<string, any> = {};
      channel.on = channel.subscribe = () => channel;
      return channel;
    }),
  },
}));
vi.mock('../src/lib/supabase', () => ({
  supabase: {
    from: vi.fn((table: string) => {
      const filters = new Map<string, string>();
      const query: Record<string, any> = {};
      query.select = () => query;
      query.eq = (key: string, value: string) => {
        filters.set(key, value);
        return query;
      };
      query.maybeSingle = () =>
        Promise.resolve({
          error: null,
          data:
            table === 'clubs'
              ? { owner_id: mocks.ownerId }
              : filters.get('user_id') === 'parent-user'
                ? { role: mocks.parentRole, status: mocks.parentStatus }
                : { role: mocks.viewerRole, status: mocks.viewerStatus },
        });
      return query;
    }),
  },
}));
import SuperAgentDashboard from '../src/pages/SuperAgentDashboard';
function agent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: 'agent-row-a',
    userId: 'user-a',
    clubId: 'club-a',
    role: 'super_agent',
    status: 'active',
    parentAgentId: 'parent-agent-row',
    commissionRate: 0.2,
    playerRakebackRate: 0.1,
    creditLimit: 100,
    creditUsed: 25,
    isPrepaid: false,
    businessBalance: 0,
    playerBalance: 0,
    promoBalance: 0,
    totalPlayers: 0,
    activePlayerCount: 0,
    subAgentCount: 0,
    weeklyRakeGenerated: 0,
    lifetimeEarnings: 0,
    displayName: 'Agent A',
    joinedAt: '2026-09-14T09:00:00Z',
    ...overrides,
  };
}
function Navigation() {
  const navigate = useNavigate();
  return <button onClick={() => navigate('/clubs/club-b/agent-dashboard')}>Other club</button>;
}
function View({ revision = 0 }: { revision?: number }) {
  void revision;
  return (
    <MemoryRouter initialEntries={['/clubs/club-a/agent-dashboard']}>
      <Navigation />
      <Routes>
        <Route path="/clubs/:clubId/agent-dashboard" element={<SuperAgentDashboard />} />
      </Routes>
    </MemoryRouter>
  );
}
function creditProps() {
  return JSON.parse(screen.getByTestId('credit-props').textContent || '{}');
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.userId = 'user-a';
  mocks.ownerId = 'club-owner';
  mocks.parentRole = 'admin';
  mocks.parentStatus = 'active';
  mocks.viewerRole = 'super_agent';
  mocks.viewerStatus = 'active';
  mocks.agents.mockResolvedValue([
    agent(),
    agent({ id: 'parent-agent-row', userId: 'parent-user', parentAgentId: undefined }),
  ]);
  mocks.players.mockResolvedValue([]);
  mocks.spread.mockResolvedValue(null);
});
afterEach(cleanup);

describe('Super-agent credit request wiring', () => {
  it('routes a verified own agent request to the exact club owner account', async () => {
    render(<View />);
    await screen.findByTestId('credit-props');
    expect(creditProps()).toMatchObject({
      userId: 'user-a',
      clubId: 'club-a',
      approverUserId: 'club-owner',
      canRequest: true,
      canReview: false,
    });
    expect(creditProps()).not.toHaveProperty('agentId');
    expect(creditProps()).not.toHaveProperty('parentAgentId');
  });
  it('does not turn a hierarchy role into credit approval authority', async () => {
    mocks.parentRole = 'super_agent';
    render(<View />);
    await screen.findByTestId('credit-props');
    expect(creditProps().approverUserId).toBe('club-owner');
    expect(creditProps().canReview).toBe(false);
  });
  it('still routes to the owner when roster privacy hides every upline row', async () => {
    mocks.agents.mockResolvedValue([agent()]);
    render(<View />);
    await screen.findByTestId('credit-props');
    expect(creditProps().approverUserId).toBe('club-owner');
  });
  it('does not authorize a suspended admin to review credit', async () => {
    mocks.viewerRole = 'admin';
    mocks.viewerStatus = 'suspended';
    render(<View />);
    await screen.findByTestId('credit-props');
    expect(creditProps().canReview).toBe(false);
  });
  it('rejects a mismatched club in the returned agent rows', async () => {
    mocks.agents.mockResolvedValue([agent({ clubId: 'club-b' })]);
    render(<View />);
    expect(await screen.findByText(/Your Agent Details Could Not Be Loaded/)).toBeInTheDocument();
    expect(screen.queryByTestId('credit-props')).not.toBeInTheDocument();
  });
  it('does not render old account details after a delayed player read', async () => {
    const gate = deferred<never[]>();
    mocks.players.mockReturnValueOnce(gate.promise).mockResolvedValue([]);
    const view = render(<View />);
    await waitFor(() => expect(mocks.players).toHaveBeenCalled());
    mocks.userId = 'user-b';
    mocks.agents.mockResolvedValue([
      agent({ id: 'agent-row-b', userId: 'user-b', parentAgentId: undefined }),
    ]);
    view.rerender(<View revision={1} />);
    await screen.findByTestId('credit-props');
    await act(async () => {
      gate.resolve([]);
      await gate.promise;
    });
    expect(creditProps().userId).toBe('user-b');
    expect(mocks.toast.error).not.toHaveBeenCalled();
  });
  it('does not reuse the previous club agent when the new club has none', async () => {
    render(<View />);
    await screen.findByTestId('credit-props');
    mocks.agents.mockResolvedValue([]);
    fireEvent.click(screen.getByRole('button', { name: 'Other club' }));
    expect(await screen.findByText('You Are Not An Agent In This Club')).toBeInTheDocument();
    expect(screen.queryByTestId('credit-props')).not.toBeInTheDocument();
  });
});
