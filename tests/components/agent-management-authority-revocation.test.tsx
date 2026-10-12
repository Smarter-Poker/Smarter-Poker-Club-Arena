import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getAgents: vi.fn(),
  setCreditLimit: vi.fn(),
  updateAgentStatus: vi.fn(),
  updateAgentRole: vi.fn(),
  createAgent: vi.fn(),
  reversibleDistributions: vi.fn(),
  claimBackDistribution: vi.fn(),
  confirmDialog: vi.fn(),
  eligibleMembers: vi.fn(),
  rpc: vi.fn(),
  isMounted: { current: true },
  reportError: vi.fn(),
  toast: { error: vi.fn(), success: vi.fn() },
}));

vi.mock('../../src/services/AgentService', () => ({
  AgentService: {
    getAgents: (...args: unknown[]) => mocks.getAgents(...args),
    setCreditLimit: (...args: unknown[]) => mocks.setCreditLimit(...args),
    updateAgentStatus: (...args: unknown[]) => mocks.updateAgentStatus(...args),
    updateAgentRole: (...args: unknown[]) => mocks.updateAgentRole(...args),
    createAgent: (...args: unknown[]) => mocks.createAgent(...args),
    reversibleDistributions: (...args: unknown[]) => mocks.reversibleDistributions(...args),
    claimBackDistribution: (...args: unknown[]) => mocks.claimBackDistribution(...args),
  },
}));
vi.mock('../../src/hooks/useAuthUser', () => ({
  useAuthUser: () => ({ user: { id: 'owner-a' } }),
}));
vi.mock('../../src/hooks/useVisibilityRefresh', () => ({ useVisibilityRefresh: vi.fn() }));
vi.mock('../../src/hooks/useIsMounted', () => ({
  useIsMounted: () => mocks.isMounted,
}));
vi.mock('../../src/hooks/useSwipeTabs', () => ({ useSwipeTabs: () => ({}) }));
vi.mock('../../src/utils/clubIdResolver', () => ({
  resolveClubUUID: (clubId: string) => Promise.resolve(clubId),
}));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: mocks.reportError }));
vi.mock('../../src/components/common/Toast', () => ({ useToast: () => mocks.toast }));
vi.mock('../../src/core/MasterBus', () => {
  const channel = { on: vi.fn(), subscribe: vi.fn() };
  channel.on.mockReturnValue(channel);
  channel.subscribe.mockReturnValue(channel);
  return {
    masterBus: {
      getOrCreateChannel: vi.fn(() => channel),
      removeRegisteredChannel: vi.fn(),
      subscribeDebounced: vi.fn(() => vi.fn()),
      emit: vi.fn(),
    },
  };
});
vi.mock('../../src/lib/supabase', () => ({
  supabase: { rpc: (...args: unknown[]) => mocks.rpc(...args), from: vi.fn() },
}));
vi.mock('../../src/components/layouts/StandardContentLayout', () => ({
  default: ({ children }: { children: React.ReactNode }) => <main>{children}</main>,
}));
vi.mock('../../src/components/console/SpadeConsole', () => ({
  SpadeConsole: ({
    title,
    children,
    plates,
  }: {
    title: string;
    children: React.ReactNode;
    plates?: {
      primary?: { label: string; onClick: () => void; disabled?: boolean };
      secondary?: { label: string; onClick: () => void; disabled?: boolean };
    };
  }) => (
    <section aria-label={title}>
      {children}
      {plates?.secondary && (
        <button disabled={plates.secondary.disabled} onClick={plates.secondary.onClick}>
          {plates.secondary.label}
        </button>
      )}
      {plates?.primary && (
        <button disabled={plates.primary.disabled} onClick={plates.primary.onClick}>
          {plates.primary.label}
        </button>
      )}
    </section>
  ),
}));
vi.mock('../../src/components/common/PageSkeleton', () => ({ default: () => <p>Loading</p> }));
vi.mock('../../src/components/common/EmptyState', () => ({
  EmptyState: () => <p>Empty</p>,
  ErrorState: ({ message }: { message: string }) => <p role="alert">{message}</p>,
}));
vi.mock('../../src/components/common/ConfirmModal', () => ({
  default: ({ isOpen, onConfirm }: { isOpen: boolean; onConfirm: () => void }) =>
    isOpen ? <button onClick={onConfirm}>Confirm Agent Action</button> : null,
}));
vi.mock('../../src/components/common/confirmDialog', () => ({
  confirmDialog: (...args: unknown[]) => mocks.confirmDialog(...args),
}));
vi.mock('../../src/components/agent/ChipTransferModal', () => ({
  default: ({ isOpen, onTransferComplete }: { isOpen: boolean; onTransferComplete: () => void }) =>
    isOpen ? <button onClick={onTransferComplete}>Complete Transfer</button> : null,
}));
vi.mock('../../src/components/agent/AgentTree', () => ({ default: () => null }));
vi.mock('../../src/components/agent/CommissionHistoryModal', () => ({ default: () => null }));
vi.mock('../../src/components/agent/DistributionHistory', () => ({ default: () => null }));
vi.mock('../../src/components/agent/AgentAnalyticsDashboard', () => ({ default: () => null }));
vi.mock('../../src/components/agent/PlayerInviteModal', () => ({ default: () => null }));
vi.mock('../../src/components/agent/AgentCommissionDashboard', () => ({ default: () => null }));
vi.mock('../../src/components/agent/AgentAssignmentPanel', () => ({ default: () => null }));
vi.mock('../../src/components/agent/AgentCashoutPanel', () => ({ default: () => null }));
vi.mock('../../src/components/admin/PlayerSearch', () => ({
  PlayerSearch: ({ onBanPlayer }: { onBanPlayer: (playerId: string) => void }) => (
    <button onClick={() => onBanPlayer('player-a')}>Choose Player To Exclude</button>
  ),
}));
vi.mock('../../src/services/MembershipService', () => ({
  MembershipService: {
    getEligibleForPromotion: (...args: unknown[]) => mocks.eligibleMembers(...args),
  },
}));
vi.mock('../../src/services/CreditService', () => ({ CreditService: {} }));
vi.mock('../../src/services/PermissionService', () => ({ PermissionService: {} }));
vi.mock('../../src/services/IntegrityActionService', () => ({
  adminRemovePlayerFromClubTables: vi.fn(),
  liveSeatTableIds: vi.fn(),
}));
vi.mock('../../src/lib/export', () => ({ exportToCSV: vi.fn() }));

import AgentManagementPage from '../../src/pages/AgentManagementPage';

const agent = {
  id: 'agent-a',
  userId: 'person-a',
  clubId: 'shark-club',
  role: 'agent',
  status: 'active',
  commissionRate: 0.5,
  playerRakebackRate: 0.3,
  creditLimit: 100,
  creditUsed: 25,
  isPrepaid: false,
  businessBalance: 500,
  playerBalance: 200,
  promoBalance: 50,
  totalPlayers: 4,
  activePlayerCount: 3,
  subAgentCount: 0,
  weeklyRakeGenerated: 75,
  lifetimeEarnings: 900,
  displayName: 'Agent Alpha',
  joinedAt: '2026-10-01T00:00:00Z',
};

const whaleAgent = {
  ...agent,
  id: 'agent-whale',
  userId: 'person-whale',
  clubId: 'whale-club',
  displayName: 'Whale Agent',
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function LocationProbe() {
  const location = useLocation();
  const navigate = useNavigate();
  return (
    <>
      <output data-testid="location">{location.pathname}</output>
      <button onClick={() => navigate('/clubs/whale-club/agents')}>Switch Club</button>
    </>
  );
}

function View() {
  return (
    <MemoryRouter initialEntries={['/clubs/shark-club/agents']}>
      <Routes>
        <Route
          path="/clubs/:clubId/agents"
          element={
            <>
              <LocationProbe />
              <AgentManagementPage />
            </>
          }
        />
        <Route path="/clubs/:clubId/operations" element={<LocationProbe />} />
      </Routes>
    </MemoryRouter>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getAgents.mockResolvedValue([agent]);
  mocks.setCreditLimit.mockRejectedValue({ code: '42501', message: 'Credit Access Refused' });
  mocks.updateAgentStatus.mockRejectedValue({ code: '42501', message: 'Agent Access Refused' });
  mocks.updateAgentRole.mockRejectedValue({ code: '42501', message: 'Agent Access Refused' });
  mocks.createAgent.mockRejectedValue({ code: '42501', message: 'Agent Access Refused' });
  mocks.reversibleDistributions.mockResolvedValue([]);
  mocks.claimBackDistribution.mockResolvedValue({ success: false, error: 'Refused' });
  mocks.confirmDialog.mockResolvedValue(true);
  mocks.eligibleMembers.mockResolvedValue([
    { id: 'membership-b', userId: 'person-b', displayName: 'Member Beta' },
  ]);
  mocks.rpc.mockRejectedValue({ code: '42501', message: 'Agent Access Refused' });
});

afterEach(cleanup);

describe('Agent Management same-user authority revocation', () => {
  it('clears protected agent data and exits when the credit writer returns 42501', async () => {
    render(<View />);
    expect(await screen.findByText('Agent Alpha')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: 'Credit Limits' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Credit Limit' }), {
      target: { value: '200' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(screen.getByTestId('location')).toHaveTextContent('/clubs/shark-club/operations')
    );
    expect(mocks.setCreditLimit).toHaveBeenCalledWith(
      'agent-a',
      200,
      'owner-a',
      undefined,
      'shark-club'
    );
    expect(screen.queryByText('Agent Alpha')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
    expect(screen.queryByRole('spinbutton', { name: 'Credit Limit' })).not.toBeInTheDocument();
    expect(mocks.reportError).toHaveBeenCalledWith(
      expect.objectContaining({ code: '42501' }),
      'AgentManagementPage.credit_authority_revoked',
      { clubId: 'shark-club', agentId: 'agent-a' }
    );
    expect(mocks.toast.error).not.toHaveBeenCalled();
  });

  it('retires the roster when a suspend reports revoked authority', async () => {
    render(<View />);
    expect(await screen.findByText('Agent Alpha')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Suspend' }));

    await waitFor(() =>
      expect(screen.getByTestId('location')).toHaveTextContent('/clubs/shark-club/operations')
    );
    expect(mocks.updateAgentStatus).toHaveBeenCalledWith('agent-a', 'suspended', 'shark-club');
    expect(screen.queryByText('Agent Alpha')).not.toBeInTheDocument();
    expect(mocks.toast.error).not.toHaveBeenCalled();
  });

  it('retires the roster when a role change reports revoked authority', async () => {
    render(<View />);
    expect(await screen.findByText('Agent Alpha')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Promote' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm Agent Action' }));

    await waitFor(() =>
      expect(screen.getByTestId('location')).toHaveTextContent('/clubs/shark-club/operations')
    );
    expect(mocks.updateAgentRole).toHaveBeenCalledWith('agent-a', 'super_agent', 'shark-club');
    expect(screen.queryByText('Agent Alpha')).not.toBeInTheDocument();
    expect(mocks.toast.error).not.toHaveBeenCalled();
  });

  it('retires the roster when create-agent reports revoked authority', async () => {
    render(<View />);
    expect(await screen.findByText('Agent Alpha')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Add Agent' }));
    expect(await screen.findByRole('option', { name: 'Member Beta' })).toBeInTheDocument();
    fireEvent.change(screen.getAllByRole('combobox')[0], { target: { value: 'person-b' } });
    fireEvent.change(screen.getByPlaceholderText('Enter Credit Limit'), {
      target: { value: '500' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create Agent' }));

    await waitFor(() =>
      expect(screen.getByTestId('location')).toHaveTextContent('/clubs/shark-club/operations')
    );
    expect(mocks.createAgent).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'person-b', clubId: 'shark-club', creditLimit: 500 })
    );
    expect(screen.queryByText('Agent Alpha')).not.toBeInTheDocument();
    expect(mocks.toast.error).not.toHaveBeenCalled();
  });

  it('retires the roster when the exclusion writer raises 42501', async () => {
    render(<View />);
    expect(await screen.findByText('Agent Alpha')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: 'Players' }));
    fireEvent.click(screen.getByRole('button', { name: 'Choose Player To Exclude' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Reason' }), {
      target: { value: 'Verified abuse' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Exclude Player' }));

    await waitFor(() =>
      expect(screen.getByTestId('location')).toHaveTextContent('/clubs/shark-club/operations')
    );
    expect(mocks.rpc).toHaveBeenCalledWith('fn_ca_ban_club_player', {
      p_club_id: 'shark-club',
      p_user_id: 'player-a',
      p_reason: 'Verified abuse',
      p_expires_at: null,
    });
    expect(screen.queryByText('Agent Alpha')).not.toBeInTheDocument();
    expect(mocks.toast.error).not.toHaveBeenCalled();
  });

  it('retires the roster when the claim-back writer raises 42501', async () => {
    mocks.reversibleDistributions.mockResolvedValueOnce([
      {
        transaction_id: 'transaction-a',
        to_user_id: 'player-a',
        to_name: 'Player Alpha',
        amount: 20,
        claimed_back: 0,
        remaining: 20,
        destination: 'player_wallet',
        created_at: '2026-10-05T00:00:00.000Z',
        reversible_until: '2026-10-05T00:10:00.000Z',
        seconds_left: 300,
      },
    ]);
    mocks.claimBackDistribution.mockRejectedValueOnce({
      code: '42501',
      message: 'Claim Back Access Refused',
    });

    render(<View />);
    expect(await screen.findByText('Agent Alpha')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: 'Players' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Take Back' }));

    await waitFor(() =>
      expect(screen.getByTestId('location')).toHaveTextContent('/clubs/shark-club/operations')
    );
    expect(mocks.claimBackDistribution).toHaveBeenCalledWith(
      'shark-club',
      'transaction-a',
      20,
      'Taken back from the agent network console',
      expect.stringMatching(/^[0-9a-f-]{36}$/i)
    );
    expect(screen.queryByText('Agent Alpha')).not.toBeInTheDocument();
    expect(mocks.toast.error).not.toHaveBeenCalled();
  });

  it('fails a malformed payables receipt closed instead of painting totals', async () => {
    mocks.rpc.mockResolvedValueOnce({
      data: { agents: 1, cap: 500, total_owed: null, total_rows: 0, rows: [] },
      error: null,
    });

    render(<View />);
    expect(await screen.findByText('Agent Alpha')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: 'Payouts' }));

    expect(await screen.findByText('The Commission Ledger Could Not Be Read')).toBeInTheDocument();
    expect(screen.queryByText(/Unsettled Commission Across/)).not.toBeInTheDocument();
  });

  it('keeps one claim-back retry identity until an outcome is confirmed', async () => {
    mocks.reversibleDistributions.mockResolvedValueOnce([
      {
        transaction_id: 'transaction-a',
        to_user_id: 'player-a',
        to_name: 'Player Alpha',
        amount: 20,
        claimed_back: 0,
        remaining: 20,
        destination: 'player_wallet',
        created_at: '2026-10-05T00:00:00.000Z',
        reversible_until: '2026-10-05T00:10:00.000Z',
        seconds_left: 300,
      },
    ]);
    mocks.claimBackDistribution.mockResolvedValue({ success: false, error: 'Response Unknown' });

    render(<View />);
    expect(await screen.findByText('Agent Alpha')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: 'Players' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Take Back' }));
    await waitFor(() => expect(mocks.claimBackDistribution).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Take Back' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Take Back' }));
    await waitFor(() => expect(mocks.claimBackDistribution).toHaveBeenCalledTimes(2));

    expect(mocks.claimBackDistribution.mock.calls[0][4]).toBe(
      mocks.claimBackDistribution.mock.calls[1][4]
    );
  });

  it('drops a deferred modal refresh after the club scope changes', async () => {
    const staleRefresh = deferred<(typeof agent)[]>();
    let sharkReads = 0;
    mocks.getAgents.mockImplementation((clubId: string) => {
      if (clubId === 'whale-club') return Promise.resolve([whaleAgent]);
      sharkReads += 1;
      return sharkReads === 1 ? Promise.resolve([agent]) : staleRefresh.promise;
    });

    render(<View />);
    expect(await screen.findByText('Agent Alpha')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Transfer' }));
    fireEvent.click(screen.getByRole('button', { name: 'Complete Transfer' }));
    fireEvent.click(screen.getByRole('button', { name: 'Switch Club' }));

    expect(await screen.findByText('Whale Agent')).toBeInTheDocument();
    expect(screen.queryByText('Agent Alpha')).not.toBeInTheDocument();
    staleRefresh.resolve([agent]);

    await waitFor(() => expect(mocks.getAgents).toHaveBeenCalledWith('whale-club'));
    expect(screen.queryByText('Agent Alpha')).not.toBeInTheDocument();
    expect(screen.getByText('Whale Agent')).toBeInTheDocument();
  });
});
