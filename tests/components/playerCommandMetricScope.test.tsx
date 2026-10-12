import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  params: {
    clubId: 'shark-club',
    userId: '11111111-1111-4111-8111-111111111111',
  } as Record<string, string>,
  viewerId: 'viewer-1',
  navigate: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
  getMemberDetail: vi.fn(),
  getDownline: vi.fn(),
  getMemberStatistics: vi.fn(),
  getGrantableRoles: vi.fn(),
  updateMemberNotes: vi.fn(),
  rpc: vi.fn(),
  roster: vi.fn(),
  wallet: vi.fn(),
  memberChannel: null as null | { onPayload: (value: unknown) => void },
  walletChannel: null as null | { onPayload: (value: unknown) => void },
}));

vi.mock('react-router-dom', () => ({
  useParams: () => state.params,
  useSearchParams: () => [new URLSearchParams(), vi.fn()],
  useNavigate: () => state.navigate,
}));

vi.mock('../../src/hooks/useMasterBusChannel', () => ({
  useMasterBusChannel: (options: { onPayload: (value: unknown) => void }) => {
    state.memberChannel = options;
  },
}));
vi.mock('../../src/hooks/useMasterBusBroadcastChannel', () => ({
  useMasterBusBroadcastChannel: (options: { onPayload: (value: unknown) => void }) => {
    state.walletChannel = options;
  },
}));
vi.mock('../../src/hooks/useAuthUser', () => ({
  useAuthUser: () => ({ user: { id: state.viewerId }, isHydrating: false }),
}));

vi.mock('../../src/components/common/Toast', () => ({
  useToast: () => state.toast,
}));

vi.mock('../../src/utils/errorReporter', () => ({ reportError: vi.fn() }));

vi.mock('../../src/utils/strictClubIdResolver', () => ({
  ClubNotFoundError: class ClubNotFoundError extends Error {},
  resolveClubUUIDStrict: async () => '22222222-2222-4222-8222-222222222222',
}));

vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    from: (table: string) => {
      const chain: Record<string, unknown> = {};
      const self = () => chain;
      Object.assign(chain, {
        select: self,
        eq: self,
        abortSignal: self,
        maybeSingle: async () =>
          table === 'club_diamond_wallets'
            ? state.wallet()
            : { data: { role: 'owner' }, error: null },
      });
      return chain;
    },
    rpc: (...args: unknown[]) => ({ abortSignal: () => state.rpc(...args) }),
  },
}));

vi.mock('../../src/services/ClubRosterService', async () => {
  const actual = await vi.importActual<typeof import('../../src/services/ClubRosterService')>(
    '../../src/services/ClubRosterService'
  );
  return {
    ...actual,
    default: {
      ...actual.default,
      getMemberDetail: state.getMemberDetail,
      getRoster: state.roster,
      getDownline: state.getDownline,
      getMemberStatistics: state.getMemberStatistics,
      getGrantableRoles: state.getGrantableRoles,
      updateMemberNotes: state.updateMemberNotes,
    },
  };
});

import MemberManagementPage from '../../src/pages/MemberManagementPage';
import PlayerStatisticsPage from '../../src/pages/PlayerStatisticsPage';

const memberDetail = {
  identity: {
    user_id: state.params.userId,
    player_number: '1042',
    alias: 'River Shark',
    username: 'rivershark',
    display_name: 'River Shark',
    avatar_url: null,
    role: 'player',
    role_rank: 70,
    nickname: 'The Closer',
    remark: 'Strong Late Position Pressure',
    last_login: '2026-09-06T12:00:00Z',
    joined_at: '2026-08-01T12:00:00Z',
    home_club_id: '22222222-2222-4222-8222-222222222222',
    home_club_name: 'Shark Club',
    upline_user_id: null,
    upline_name: null,
    upline_player_number: null,
  },
  presence: { is_online: true, is_seated: true },
  wallets: { chip_balance: 500, player_wallet: 500, agent_wallet: 0, promo_wallet: 25 },
  downline: { downline_direct: 1, downline_total: 1 },
  stats: {
    hands: 200,
    mtt_hands: 30,
    total_fee: 18,
    mtt_fee: 4,
    claimed_back: 0,
    sent_out: 0,
    total_winnings: 120,
    mtt_winnings: 40,
  },
  range: { from: null, to: null, is_overall: true },
  capabilities: {
    access: 'staff',
    can_view_financials: true,
    can_view_notes: true,
    can_edit_notes: true,
    can_manage_role: false,
  },
};

const statistics = {
  authorized: true,
  reason: null,
  variant: 'all',
  variants: ['nlh', 'plo'],
  hands: 100,
  hands_won: 25,
  win_rate: 25,
  vpip: 30,
  pfr: 20,
  three_bet: 5,
  three_bets: 5,
  fold_to_three_bet: 40,
  faced_three_bets: 10,
  cbet: 50,
  cbet_opportunities: 12,
  net: -20,
  fees: 10,
  from: '2026-10-01',
  to: '2026-10-11',
  is_overall: false,
};
beforeEach(() => {
  vi.clearAllMocks();
  state.params = { clubId: 'shark-club', userId: '11111111-1111-4111-8111-111111111111' };
  state.getMemberDetail.mockImplementation(async (_club, _user, range) => ({
    ...memberDetail,
    range: { ...range, is_overall: range.from === null && range.to === null },
  }));
  state.getDownline.mockResolvedValue([]);
  state.getGrantableRoles.mockResolvedValue([]);
  state.getMemberStatistics.mockImplementation(async (_club, _user, variant, range) => ({
    ...statistics,
    ...range,
    variant: variant ?? 'all',
    is_overall: range.from === null && range.to === null,
  }));
});
afterEach(cleanup);

it.each(['record', 'statistics'] as const)(
  '%s keeps custom drafts out of its RPC and identifies the actual displayed scope until Confirm succeeds',
  async (kind) => {
    const read = kind === 'record' ? state.getMemberDetail : state.getMemberStatistics;
    const view = render(kind === 'record' ? <MemberManagementPage /> : <PlayerStatisticsPage />);
    const caption = await screen.findByLabelText(
      kind === 'record' ? 'Displayed Activity Scope' : 'Displayed Performance Scope'
    );
    await waitFor(() => expect(read).toHaveBeenCalledTimes(1));
    const originalScope = caption.textContent;
    expect(
      screen.getByLabelText(
        kind === 'record' ? 'Activity Metric Definitions' : 'Performance Metric Definitions'
      )
    ).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole('button', { name: kind === 'record' ? 'Select' : 'Custom', exact: true })
    );
    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-01-01' } });
    fireEvent.change(screen.getByLabelText('To'), { target: { value: '2026-01-31' } });
    expect(
      screen.getByText('Draft Dates Not Applied. Confirm To Update The Displayed Range.')
    ).toHaveAttribute('role', 'status');
    expect(caption).toHaveTextContent(originalScope!);
    expect(read).toHaveBeenCalledTimes(1);
    let finish!: (value: unknown) => void;
    read.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    fireEvent.click(screen.getByRole('button', { name: 'Confirm', exact: true }));
    await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    const args = read.mock.calls[1];
    expect(args[kind === 'record' ? 2 : 3]).toEqual({ from: '2026-01-01', to: '2026-01-31' });
    expect(screen.queryByText(/Draft Dates Not Applied/)).not.toBeInTheDocument();
    expect(caption).toHaveTextContent('Loading The Selected Range');
    await act(async () => {
      finish(
        kind === 'record'
          ? { ...memberDetail, range: { from: '2026-01-01', to: '2026-01-31', is_overall: false } }
          : { ...statistics, from: '2026-01-01', to: '2026-01-31' }
      );
    });
    expect(caption).toHaveTextContent('Showing 2026-01-01 To 2026-01-31 UTC');
    expect(read).toHaveBeenCalledTimes(2);
    view.unmount();
  }
);

it.each(['all', null])(
  'keeps the previously returned All Variants scope (%s) when a new game read fails',
  async (returnedVariant) => {
    state.getMemberStatistics.mockResolvedValueOnce({ ...statistics, variant: returnedVariant });
    render(<PlayerStatisticsPage />);
    const caption = await screen.findByLabelText('Displayed Performance Scope');
    await waitFor(() => expect(caption).toHaveTextContent('All Variants'));
    const priorScope = caption.textContent;
    state.getMemberStatistics.mockRejectedValueOnce(new Error('Unavailable'));
    fireEvent.change(screen.getByRole('combobox', { name: 'Game' }), { target: { value: 'nlh' } });
    await screen.findByText('Statistics Connection Interrupted');
    expect(caption).toHaveTextContent(priorScope!);
    expect(caption).not.toHaveTextContent('Nlh');
    expect(screen.getByRole('alert')).toHaveTextContent('Previous Successful Read');
  }
);

it('hides private metric definitions together with financial activity after authoritative denial', async () => {
  state.getMemberDetail.mockResolvedValue({
    ...memberDetail,
    wallets: null,
    stats: null,
    downline: null,
    capabilities: {
      ...memberDetail.capabilities,
      can_view_financials: false,
      can_view_notes: false,
      can_edit_notes: false,
    },
  });
  render(<MemberManagementPage />);
  await screen.findByRole('heading', { name: 'River Shark' });
  expect(screen.queryByLabelText('Activity Metric Definitions')).not.toBeInTheDocument();
  expect(screen.queryByText('Total Winnings')).not.toBeInTheDocument();
});

it('keeps definitions available for an authorized empty range without showing fabricated metrics', async () => {
  state.getMemberStatistics.mockResolvedValueOnce({ ...statistics, hands: 0, hands_won: 0 });
  render(<PlayerStatisticsPage />);
  await screen.findByText('No Hands In This Range');
  expect(screen.getByLabelText('Performance Metric Definitions')).toBeInTheDocument();
  expect(screen.queryByText('3-Bet Per Hand')).not.toBeInTheDocument();
});
