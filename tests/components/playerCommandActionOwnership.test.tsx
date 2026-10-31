vi.unmock('../../src/core/MasterBus');
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  params: {
    clubId: 'shark-club',
    userId: '11111111-1111-4111-8111-111111111111',
  } as Record<string, string>,
  viewerId: 'viewer-1',
  viewerRole: 'owner',
  viewerRoleError: null as Error | null,
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
  memberChannel: null as null | {
    onPayload: (value: unknown) => void;
    onSubscriptionStatus?: (status: string) => void;
  },
  recordChannel: null as null | {
    onPayload: (value: unknown) => void;
    onSubscriptionStatus?: (status: string) => void;
  },
  walletChannel: null as null | {
    onPayload: (value: unknown) => void;
    onSubscriptionStatus?: (status: string) => void;
  },
}));

vi.mock('react-router-dom', () => ({
  useParams: () => state.params,
  useLocation: () => ({ pathname: `/clubs/${state.params.clubId}/members/${state.params.userId}` }),
  useSearchParams: () => [new URLSearchParams(), vi.fn()],
  useNavigate: () => state.navigate,
}));

vi.mock('../../src/hooks/useMasterBusChannel', () => ({
  useMasterBusChannel: (options: { onPayload: (value: unknown) => void }) => {
    state.memberChannel = options;
  },
}));
vi.mock('../../src/hooks/useMasterBusBroadcastChannel', () => ({
  useMasterBusBroadcastChannel: (options: {
    event: string;
    onPayload: (value: unknown) => void;
  }) => {
    if (options.event === 'record_changed') state.recordChannel = options;
    if (options.event === 'wallet_changed') state.walletChannel = options;
  },
}));
vi.mock('../../src/contexts/ClubWorkspaceContext', () => ({
  useClubWorkspace: () => ({ clubUUID: '22222222-2222-4222-8222-222222222222' }),
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
        maybeSingle: async () => {
          if (table === 'club_diamond_wallets') return state.wallet();
          if (state.viewerRoleError) throw state.viewerRoleError;
          return { data: { role: state.viewerRole }, error: null };
        },
      });
      return chain;
    },
    rpc: (...args: unknown[]) => ({
      setHeader() {
        return this;
      },
      abortSignal: () => state.rpc(...args),
    }),
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

import ClubPrivateDataBoundary from '../../src/components/auth/ClubPrivateDataBoundary';
import { masterBus } from '../../src/core/MasterBus';
import { useUserStore } from '../../src/stores/useUserStore';
import { STATS_CACHE_PREFIX } from '../../src/lib/statsCache';
import MemberManagementPage from '../../src/pages/MemberManagementPage';
import PromoVaultPage from '../../src/pages/PromoVaultPage';
import { MemberAccessDeniedError } from '../../src/services/ClubRosterService';

const memberDetail = {
  identity: {
    user_id: state.params.userId,
    player_number: '1042',
    alias: 'River Shark',
    username: 'rivershark',
    display_name: 'River Shark',
    avatar_url: null as string | null,
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

beforeEach(() => {
  state.params = {
    clubId: 'shark-club',
    userId: '11111111-1111-4111-8111-111111111111',
  };
  state.viewerId = 'viewer-1';
  state.navigate.mockReset();
  state.toast.success.mockReset();
  state.toast.error.mockReset();
  state.toast.info.mockReset();
  state.getMemberDetail.mockReset();
  state.getDownline.mockReset();
  state.getMemberStatistics.mockReset();
  state.getGrantableRoles.mockReset();
  state.updateMemberNotes.mockReset();
  state.getGrantableRoles.mockResolvedValue([]);
  state.getMemberDetail.mockResolvedValue(memberDetail);
  state.getDownline.mockResolvedValue([
    {
      user_id: '33333333-3333-4333-8333-333333333333',
      player_number: '2050',
      alias: 'Cyan Rail',
      username: 'cyanrail',
      role: 'player',
      role_rank: 70,
      depth: 1,
      chip_balance: 100,
      total_fees: 4,
      is_online: false,
    },
  ]);
});

afterEach(() => cleanup());

const catalog = [
  { item_key: 'time-bank', category: 'feature', label: 'Time Bank', quantity: 3, diamond_cost: 10 },
];
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
beforeEach(() => {
  state.viewerRole = 'owner';
  state.viewerRoleError = null;
  state.memberChannel = null;
  state.walletChannel = null;
  state.wallet.mockResolvedValue({ data: { balance: 100 }, error: null });
  state.rpc.mockReset();
  state.roster.mockReset();
  state.rpc.mockResolvedValue({ data: catalog, error: null });
  state.roster.mockResolvedValue([
    { user_id: 'viewer-1', alias: 'Recipient', username: 'recipient', role: 'owner' },
  ]);
});
it('Revert discards a focused dirty note without starting the blur write', async () => {
  const pending = deferred<{ nickname: string; remark: string }>();
  state.updateMemberNotes.mockReturnValue(pending.promise);
  const user = userEvent.setup();
  render(<MemberManagementPage />);
  const name = await screen.findByRole('textbox', { name: 'Nickname' });
  await user.click(name);
  await user.clear(name);
  await user.type(name, 'Local Draft');
  await user.click(screen.getByRole('button', { name: 'Revert' }));
  expect(state.updateMemberNotes).not.toHaveBeenCalled();
  expect(name).toHaveValue('The Closer');
});
it('a completed grant cannot close a newly opened dialog for the same item', async () => {
  const pending = deferred<{ data: Record<string, unknown>; error: null }>();
  state.rpc.mockImplementation((name) =>
    name === 'ca_promo_vault_grant'
      ? pending.promise
      : Promise.resolve({ data: catalog, error: null })
  );
  const user = userEvent.setup();
  render(<PromoVaultPage />);
  await user.click(await screen.findByRole('button', { name: 'Grant Time Bank' }));
  await user.click(screen.getByRole('button', { name: /Recipient/ }));
  await user.click(screen.getByRole('button', { name: 'Confirm' }));
  await waitFor(() =>
    expect(state.rpc).toHaveBeenCalledWith('ca_promo_vault_grant', expect.anything())
  );
  await user.click(screen.getByRole('button', { name: 'Cancel' }));
  await user.click(screen.getByRole('button', { name: 'Grant Time Bank' }));
  await user.click(screen.getByRole('button', { name: /Recipient/ }));
  await user.click(screen.getByRole('button', { name: 'More' }));
  await act(async () =>
    pending.resolve({ data: { success: true, remaining: 2, delivered_uses: 1 }, error: null })
  );
  expect(screen.getByRole('dialog', { name: 'Send Time Bank' })).toBeInTheDocument();
  expect(screen.getByRole('spinbutton', { name: 'Quantity To Send' })).toHaveValue(2);
  expect(screen.getByRole('button', { name: 'Confirm' })).toBeEnabled();
  expect(state.toast.success).toHaveBeenCalled();
});
it('keyboard focus on Revert preserves the local draft until explicit activation', async () => {
  const user = userEvent.setup();
  render(<MemberManagementPage />);
  const name = await screen.findByRole('textbox', { name: 'Nickname' });
  await user.click(name);
  await user.clear(name);
  await user.type(name, 'Keyboard Draft');
  const revert = screen.getByRole('button', { name: 'Revert' });
  act(() => revert.focus());
  expect(state.updateMemberNotes).not.toHaveBeenCalled();
  expect(name).toHaveValue('Keyboard Draft');
  await user.keyboard('{Enter}');
  expect(name).toHaveValue('The Closer');
  expect(state.updateMemberNotes).not.toHaveBeenCalled();
});
it('normal field-to-field blur still saves and Revert cannot cancel an already started write', async () => {
  const pending = deferred<{ nickname: string; remark: string }>();
  state.updateMemberNotes.mockReturnValue(pending.promise);
  const user = userEvent.setup();
  render(<MemberManagementPage />);
  const name = await screen.findByRole('textbox', { name: 'Nickname' });
  await user.click(name);
  await user.clear(name);
  await user.type(name, 'Saved Draft');
  await user.click(screen.getByRole('textbox', { name: 'Remark' }));
  expect(state.updateMemberNotes).toHaveBeenCalledTimes(1);
  expect(screen.getByRole('button', { name: 'Revert' })).toBeDisabled();
  await act(async () =>
    pending.resolve({ nickname: 'Saved Draft', remark: 'Strong Late Position Pressure' })
  );
  expect(name).toHaveValue('Saved Draft');
});
it('an unknown note receipt stays protected from Revert and retries the same request', async () => {
  state.updateMemberNotes.mockRejectedValueOnce(new Error('Unknown Acknowledgement'));
  state.updateMemberNotes.mockResolvedValueOnce({
    nickname: 'Unknown Draft',
    remark: 'Strong Late Position Pressure',
  });
  const user = userEvent.setup();
  render(<MemberManagementPage />);
  const name = await screen.findByRole('textbox', { name: 'Nickname' });
  await user.click(name);
  await user.clear(name);
  await user.type(name, 'Unknown Draft');
  await user.click(screen.getByRole('textbox', { name: 'Remark' }));
  await screen.findByText('Save Outcome Is Unconfirmed. Retry The Same Request.');
  expect(screen.getByRole('button', { name: 'Revert' })).toBeDisabled();
  await user.click(screen.getByRole('button', { name: 'Save Notes' }));
  expect(state.updateMemberNotes).toHaveBeenCalledTimes(2);
  expect(state.updateMemberNotes.mock.calls[1][4]).toBe(state.updateMemberNotes.mock.calls[0][4]);
});

it('a late purchase answer does not close a newly opened purchase dialog', async () => {
  const pending = deferred<{ data: Record<string, unknown>; error: null }>();
  state.rpc.mockImplementation((name) =>
    name === 'ca_promo_vault_buy'
      ? pending.promise
      : Promise.resolve({ data: catalog, error: null })
  );
  const user = userEvent.setup();
  render(<PromoVaultPage />);
  await user.click(await screen.findByRole('button', { name: 'Buy More Time Bank' }));
  await user.click(screen.getByRole('button', { name: 'Confirm' }));
  await waitFor(() =>
    expect(state.rpc).toHaveBeenCalledWith('ca_promo_vault_buy', expect.anything())
  );
  await user.click(screen.getByRole('button', { name: 'Cancel' }));
  await user.click(screen.getByRole('button', { name: 'Buy More Time Bank' }));
  await user.click(screen.getByRole('button', { name: 'More' }));
  await act(async () =>
    pending.resolve({
      data: { success: true, quantity: 4, diamond_balance: 90, diamonds_spent: 10 },
      error: null,
    })
  );
  expect(screen.getByRole('dialog', { name: 'Buy Time Bank' })).toBeInTheDocument();
  expect(screen.getByRole('spinbutton', { name: 'Quantity To Buy' })).toHaveValue(2);
  expect(screen.getByTitle('Club Diamond Balance')).toHaveTextContent('90');
});
it('failed role options can be explicitly retried for the same record', async () => {
  const pending = deferred<'admin'[]>();
  state.getMemberDetail.mockResolvedValue({
    ...memberDetail,
    capabilities: { ...memberDetail.capabilities, can_manage_role: true },
  });
  state.getGrantableRoles
    .mockRejectedValueOnce(new Error('Read unavailable'))
    .mockReturnValueOnce(pending.promise);
  const user = userEvent.setup();
  render(<MemberManagementPage />);
  await screen.findByText(/Role Options Could Not Be Loaded/);
  await user.click(screen.getByRole('button', { name: 'Retry Role Options' }));
  await screen.findByText('Checking What You May Grant...');
  expect(state.getGrantableRoles).toHaveBeenCalledTimes(2);
  await act(async () => pending.resolve(['admin']));
  expect(screen.queryByText(/Role Options Could Not Be Loaded/)).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: /Admin/ })).toBeEnabled();
});

it('wallet events update the displayed member without replacing a dirty note or reloading the record', async () => {
  const user = userEvent.setup();
  render(<MemberManagementPage />);
  const name = await screen.findByRole('textbox', { name: 'Nickname' });
  await user.click(name);
  await user.clear(name);
  await user.type(name, 'Keep This Draft');
  const cardReads = state.rpc.mock.calls.filter(([name]) =>
    ['ca_club_member_win_loss', 'ca_club_member_upline_chain'].includes(name)
  ).length;
  await act(async () =>
    state.memberChannel?.onPayload({
      eventType: 'UPDATE',
      new: {
        club_id: '22222222-2222-4222-8222-222222222222',
        user_id: state.params.userId,
        chip_balance: 777,
      },
    })
  );
  expect(screen.getByText('777.00')).toBeInTheDocument();
  expect(name).toHaveValue('Keep This Draft');
  expect(
    state.rpc.mock.calls.filter(([name]) =>
      ['ca_club_member_win_loss', 'ca_club_member_upline_chain'].includes(name)
    )
  ).toHaveLength(cardReads);
  expect(state.updateMemberNotes).not.toHaveBeenCalled();
  expect(state.getMemberDetail).toHaveBeenCalledTimes(1);
  expect(state.getDownline).toHaveBeenCalledTimes(1);
});
it('late wallet refresh cannot restore old-viewer financial access', async () => {
  const pending = deferred<typeof memberDetail>();
  const view = render(<MemberManagementPage />);
  await screen.findByRole('textbox', { name: 'Nickname' });
  state.getMemberDetail.mockReturnValueOnce(pending.promise);
  await act(async () =>
    state.walletChannel?.onPayload({
      payload: { club_id: '22222222-2222-4222-8222-222222222222', user_id: state.params.userId },
    })
  );
  await waitFor(() => expect(state.getMemberDetail).toHaveBeenCalledTimes(2));
  state.viewerId = 'viewer-denied';
  state.getMemberDetail.mockResolvedValue({
    ...memberDetail,
    wallets: null,
    capabilities: {
      ...memberDetail.capabilities,
      can_view_financials: false,
      can_edit_notes: false,
    },
  });
  view.rerender(<MemberManagementPage />);
  await waitFor(() => expect(state.getMemberDetail).toHaveBeenCalledTimes(3));
  await act(async () =>
    pending.resolve({ ...memberDetail, wallets: { ...memberDetail.wallets, player_wallet: 999 } })
  );
  expect(screen.queryByText('999')).not.toBeInTheDocument();
  expect(screen.queryByText('Player Wallet')).not.toBeInTheDocument();
});
it('same-viewer wallet denial clears activity and downline while preserving dirty notes against a delayed range read', async () => {
  const rangeAnswer = deferred<typeof memberDetail>();
  const rangeDownline = deferred<unknown[]>();
  const denied = deferred<unknown>();
  const user = userEvent.setup();
  render(<MemberManagementPage />);
  const name = await screen.findByRole('textbox', { name: 'Nickname' });
  await user.click(name);
  await user.clear(name);
  await user.type(name, 'Private Local Draft');
  state.getMemberDetail
    .mockReturnValueOnce(rangeAnswer.promise)
    .mockReturnValueOnce(denied.promise);
  state.getDownline.mockReturnValueOnce(rangeDownline.promise);
  // A range read is pending when authoritative wallet access is withdrawn.
  fireEvent.click(screen.getByRole('button', { name: '7 Days' }));
  await waitFor(() => expect(state.getMemberDetail).toHaveBeenCalledTimes(2));
  await act(async () =>
    state.walletChannel?.onPayload({
      payload: { club_id: '22222222-2222-4222-8222-222222222222', user_id: state.params.userId },
    })
  );
  await waitFor(() => expect(state.getMemberDetail).toHaveBeenCalledTimes(3));
  await act(async () =>
    denied.resolve({
      ...memberDetail,
      wallets: null,
      stats: null,
      downline: null,
      capabilities: { ...memberDetail.capabilities, can_view_financials: false },
    })
  );
  expect(screen.queryByText('Cash Fees')).not.toBeInTheDocument();
  expect(screen.queryByText('Downlines Total')).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /Open Cyan Rail/ })).not.toBeInTheDocument();
  expect(name).toHaveValue('Private Local Draft');
  await act(async () => {
    rangeAnswer.resolve(memberDetail);
    rangeDownline.resolve([
      {
        user_id: '33333333-3333-4333-8333-333333333333',
        alias: 'Late Financial Downline',
        role: 'player',
        total_fees: 999,
      },
    ]);
  });
  expect(screen.queryByText('Cash Fees')).not.toBeInTheDocument();
  expect(screen.queryByText('Downlines Total')).not.toBeInTheDocument();
  expect(screen.queryByText('Late Financial Downline')).not.toBeInTheDocument();
  expect(screen.queryByText('Player Wallet')).not.toBeInTheDocument();
  expect(name).toHaveValue('Private Local Draft');
});
it('structured access withdrawal removes private notes and role controls immediately', async () => {
  state.getMemberDetail.mockResolvedValueOnce({
    ...memberDetail,
    capabilities: { ...memberDetail.capabilities, can_manage_role: true },
  });
  state.getGrantableRoles.mockResolvedValue(['admin']);
  const user = userEvent.setup();
  render(<MemberManagementPage />);
  const name = await screen.findByRole('textbox', { name: 'Nickname' });
  await user.click(name);
  await user.clear(name);
  await user.type(name, 'Private Revoked Draft');
  state.getMemberDetail.mockResolvedValueOnce({
    ...memberDetail,
    wallets: null,
    stats: null,
    downline: null,
    identity: { ...memberDetail.identity, nickname: null, remark: null },
    capabilities: {
      access: 'identity',
      can_view_financials: false,
      can_view_notes: false,
      can_edit_notes: false,
      can_manage_role: false,
    },
  });
  await act(async () =>
    state.walletChannel?.onPayload({
      payload: { club_id: '22222222-2222-4222-8222-222222222222', user_id: state.params.userId },
    })
  );
  expect(screen.queryByRole('textbox', { name: 'Nickname' })).not.toBeInTheDocument();
  expect(screen.queryByText('Strong Late Position Pressure')).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /Admin/ })).not.toBeInTheDocument();
  expect(screen.queryByText('Cash Fees')).not.toBeInTheDocument();
  expect(screen.getByText('River Shark')).toBeInTheDocument();
});

it('complete access loss removes the old record and cannot be restored by a delayed range answer', async () => {
  const pending = deferred<typeof memberDetail>();
  render(<MemberManagementPage />);
  await screen.findByRole('textbox', { name: 'Nickname' });
  state.getMemberDetail
    .mockReturnValueOnce(pending.promise)
    .mockRejectedValueOnce(new MemberAccessDeniedError());
  fireEvent.click(screen.getByRole('button', { name: '7 Days' }));
  await waitFor(() => expect(state.getMemberDetail).toHaveBeenCalledTimes(2));
  await act(async () =>
    state.walletChannel?.onPayload({
      payload: { club_id: '22222222-2222-4222-8222-222222222222', user_id: state.params.userId },
    })
  );
  await waitFor(() => expect(state.getMemberDetail).toHaveBeenCalledTimes(3));
  expect(screen.queryByText('River Shark')).not.toBeInTheDocument();
  expect(screen.queryByRole('textbox', { name: 'Nickname' })).not.toBeInTheDocument();
  await act(async () => pending.resolve(memberDetail));
  expect(screen.queryByText('River Shark')).not.toBeInTheDocument();
});

it('updates live stats and downline fees without replacing identity or an unsaved note', async () => {
  render(<MemberManagementPage />);
  await screen.findByText('River Shark');
  fireEvent.click(screen.getByRole('button', { name: '7 Days' }));
  await waitFor(() => expect(state.getMemberDetail).toHaveBeenCalledTimes(2));
  const selectedRange = state.getMemberDetail.mock.calls.at(-1)?.[2];
  const cardReads = state.rpc.mock.calls.filter(
    ([name]) => name === 'ca_club_member_win_loss'
  ).length;
  const nickname = screen.getByDisplayValue('The Closer');
  fireEvent.change(nickname, { target: { value: 'Unsaved Local Name' } });
  state.getMemberDetail.mockImplementation(async (_club, _member, activeRange) => ({
    ...memberDetail,
    identity: { ...memberDetail.identity, alias: 'Updated Shark', nickname: 'Remote Name' },
    presence: { is_online: false, is_seated: false },
    stats: { ...memberDetail.stats, hands: 321, total_winnings: -44 },
    downline: { downline_direct: 3, downline_total: 8 },
    range: { ...activeRange, is_overall: activeRange?.from === null },
  }));
  await act(async () =>
    state.recordChannel?.onPayload({ payload: { user_id: state.params.userId } })
  );
  expect(screen.getByText('River Shark')).toBeInTheDocument();
  expect(screen.queryByText('Updated Shark')).not.toBeInTheDocument();
  expect(state.getMemberDetail.mock.calls.at(-1)?.[2]).toEqual(selectedRange);
  expect(screen.getByText('321')).toBeInTheDocument();
  expect(state.rpc.mock.calls.filter(([name]) => name === 'ca_club_member_win_loss')).toHaveLength(
    cardReads + 1
  );
  expect(screen.getByText('-44.00')).toBeInTheDocument();
  expect(state.getDownline).toHaveBeenCalledTimes(3);
  expect(state.getDownline.mock.calls.at(-1)?.[3]).toEqual(selectedRange);
  expect(screen.getByDisplayValue('Unsaved Local Name')).toBeInTheDocument();
});

it.each(['record_changed', 'SUBSCRIBED'])(
  'applies the verified avatar on %s without replacing identity or note drafts',
  async (event) => {
    const view = render(<MemberManagementPage />);
    await screen.findByText('River Shark');
    fireEvent.change(screen.getByDisplayValue('The Closer'), {
      target: { value: 'Unsaved Local Name' },
    });
    fireEvent.change(screen.getByDisplayValue('Strong Late Position Pressure'), {
      target: { value: 'Unsaved Local Remark' },
    });
    state.getMemberDetail.mockImplementation(async (_club, _member, activeRange) => ({
      ...memberDetail,
      identity: {
        ...memberDetail.identity,
        alias: 'Remote Alias',
        nickname: 'Remote Nickname',
        remark: 'Remote Remark',
        avatar_url: '/avatars/table/free_shark@2x.webp',
      },
      range: { ...activeRange, is_overall: activeRange?.from === null },
    }));
    await act(async () => {
      if (event === 'record_changed') state.recordChannel?.onPayload({});
      else state.recordChannel?.onSubscriptionStatus?.('SUBSCRIBED');
    });
    expect(view.container.querySelector('.mm-avatar img')).toHaveAttribute(
      'src',
      expect.stringContaining('/avatars/table/free_shark@2x.webp')
    );
    expect(screen.getByText('River Shark')).toBeInTheDocument();
    expect(screen.queryByText('Remote Alias')).not.toBeInTheDocument();
    expect(screen.getByDisplayValue('Unsaved Local Name')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Unsaved Local Remark')).toBeInTheDocument();
  }
);

it('applies an authoritative avatar removal without retaining the old image', async () => {
  const initial = deferred<typeof memberDetail>();
  state.getMemberDetail.mockReturnValueOnce(initial.promise);
  const view = render(<MemberManagementPage />);
  await waitFor(() => expect(state.getMemberDetail).toHaveBeenCalledTimes(1));
  // Settle bootstrap and its effect-owned refresh handler before delivering
  // the record event exposed during render by the subscription mock.
  await act(async () =>
    initial.resolve({
      ...memberDetail,
      identity: { ...memberDetail.identity, avatar_url: '/avatars/table/free_ninja@2x.webp' },
    })
  );
  await screen.findByText('River Shark');
  expect(view.container.querySelector('.mm-avatar img')).toHaveAttribute(
    'src',
    expect.stringContaining('free_ninja')
  );
  const authoritativeRemoval = deferred<typeof memberDetail>();
  const initialReadCount = state.getMemberDetail.mock.calls.length;
  state.getMemberDetail.mockImplementation(() => authoritativeRemoval.promise);
  await act(async () => state.recordChannel?.onPayload({}));
  await waitFor(() => expect(state.getMemberDetail).toHaveBeenCalledTimes(initialReadCount + 1));
  expect(view.container.querySelector('.mm-avatar img')).toHaveAttribute(
    'src',
    expect.stringContaining('free_ninja')
  );
  const activeRange = state.getMemberDetail.mock.calls.at(-1)?.[2];
  await act(async () => {
    authoritativeRemoval.resolve({
      ...memberDetail,
      range: { ...activeRange, is_overall: activeRange?.from === null },
    });
  });
  await waitFor(() => expect(view.container.querySelector('.mm-avatar img')).toBeNull());
  expect(screen.getByText('River Shark')).toBeInTheDocument();
});

it('does not apply another member avatar from an unmatched record response', async () => {
  const view = render(<MemberManagementPage />);
  await screen.findByText('River Shark');
  state.getMemberDetail.mockImplementation(async (_club, _member, activeRange) => ({
    ...memberDetail,
    identity: {
      ...memberDetail.identity,
      user_id: '33333333-3333-4333-8333-333333333333',
      avatar_url: '/avatars/table/free_shark@2x.webp',
    },
    range: { ...activeRange, is_overall: activeRange?.from === null },
  }));
  await act(async () => state.recordChannel?.onPayload({}));
  expect(view.container.querySelector('.mm-avatar img')).toBeNull();
  expect(screen.getByText('River Shark')).toBeInTheDocument();
});

it('ignores focus and checks only authority on a recovered record subscription', async () => {
  render(<MemberManagementPage />);
  await screen.findByText('River Shark');
  const baseline = state.getMemberDetail.mock.calls.length;
  await act(async () => window.dispatchEvent(new Event('focus')));
  expect(state.getMemberDetail).toHaveBeenCalledTimes(baseline);
  const focused = baseline;
  await act(async () => state.recordChannel?.onSubscriptionStatus?.('SUBSCRIBED'));
  await waitFor(() => expect(state.getMemberDetail.mock.calls.length).toBeGreaterThan(focused));
  expect(state.getDownline).toHaveBeenCalledTimes(1);
});

it('coalesces source bursts and reads again after an event arrives during a read', async () => {
  const initial = deferred<typeof memberDetail>();
  state.getMemberDetail.mockReturnValueOnce(initial.promise);
  render(<MemberManagementPage />);
  await waitFor(() => expect(state.getMemberDetail).toHaveBeenCalledTimes(1));
  // The hook mock exposes callbacks during render. Finish bootstrap and its
  // authority effect before delivering events to the subscribed record.
  await act(async () => initial.resolve(memberDetail));
  await screen.findByText('River Shark');
  const pending = deferred<typeof memberDetail>();
  state.getMemberDetail.mockReturnValueOnce(pending.promise);
  const before = state.getMemberDetail.mock.calls.length;
  await act(async () => {
    state.recordChannel?.onPayload({});
    state.recordChannel?.onPayload({});
    state.recordChannel?.onPayload({});
  });
  await waitFor(() => expect(state.getMemberDetail.mock.calls.length).toBe(before + 1));
  await act(async () => pending.resolve(memberDetail));
  await waitFor(() => expect(state.getMemberDetail.mock.calls.length).toBe(before + 2));
});

it('refreshes role options when the viewer authority changes on the mounted record', async () => {
  state.getMemberDetail.mockResolvedValue({
    ...memberDetail,
    capabilities: { ...memberDetail.capabilities, can_manage_role: true },
  });
  state.getGrantableRoles.mockResolvedValue(['admin']);
  render(<MemberManagementPage />);
  await screen.findByRole('button', { name: /^Admin/ });
  state.viewerRole = 'agent';
  state.getGrantableRoles.mockResolvedValue(['sub_agent']);
  await act(async () => state.recordChannel?.onPayload({}));
  expect(await screen.findByRole('button', { name: /^Sub Agent/ })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /^Admin/ })).not.toBeInTheDocument();
});

it('keeps an edited record and its sections stable across ambient browser events', async () => {
  render(<MemberManagementPage />);
  await screen.findByText('River Shark');
  const input = screen.getByDisplayValue('The Closer');
  fireEvent.change(input, { target: { value: 'Unsaved Local Draft' } });
  const detailReads = state.getMemberDetail.mock.calls.length;
  const downlineReads = state.getDownline.mock.calls.length;
  await act(async () => {
    window.dispatchEvent(new Event('focus'));
    window.dispatchEvent(new Event('online'));
    document.dispatchEvent(new Event('visibilitychange'));
  });
  expect(state.getMemberDetail).toHaveBeenCalledTimes(detailReads);
  expect(state.getDownline).toHaveBeenCalledTimes(downlineReads);
  expect(screen.getByDisplayValue('Unsaved Local Draft')).toBe(input);
});

it('withdraws note and role authority on a record event without refreshing the workspace', async () => {
  state.getMemberDetail.mockResolvedValue({
    ...memberDetail,
    capabilities: { ...memberDetail.capabilities, can_manage_role: true },
  });
  state.getGrantableRoles.mockResolvedValue(['admin']);
  render(<MemberManagementPage />);
  await screen.findByRole('button', { name: /^Admin/ });
  const downlineReads = state.getDownline.mock.calls.length;
  state.getMemberDetail.mockResolvedValue({
    ...memberDetail,
    capabilities: {
      ...memberDetail.capabilities,
      can_view_notes: false,
      can_edit_notes: false,
      can_manage_role: false,
    },
  });
  state.viewerRole = 'player';
  await act(async () => state.recordChannel?.onPayload({}));
  await waitFor(() =>
    expect(screen.queryByRole('textbox', { name: 'Nickname' })).not.toBeInTheDocument()
  );
  expect(screen.queryByRole('button', { name: /^Admin/ })).not.toBeInTheDocument();
  expect(state.getDownline).toHaveBeenCalledTimes(downlineReads);
  expect(screen.getByText('River Shark')).toBeInTheDocument();
});

it('keeps the chosen ledger dates fixed across a day boundary until an explicit choice', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-29T23:59:59Z'));
  try {
    await act(async () => {
      render(<MemberManagementPage />);
    });
    await act(async () =>
      fireEvent.click(screen.getByRole('button', { name: '7 Days', exact: true }))
    );
    const reads = state.getMemberDetail.mock.calls.length;
    const downlineReads = state.getDownline.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(state.getMemberDetail).toHaveBeenCalledTimes(reads);
    expect(state.getDownline).toHaveBeenCalledTimes(downlineReads);
  } finally {
    vi.useRealTimers();
  }
});

it('keeps the real boundary and record mounted on recipient access invalidation while clearing caches', async () => {
  const initial = deferred<typeof memberDetail>();
  state.getMemberDetail.mockReturnValueOnce(initial.promise);
  const priorUser = useUserStore.getState().user;
  useUserStore.setState({ user: { id: state.viewerId } as never });
  const view = render(
    <ClubPrivateDataBoundary>
      <MemberManagementPage />
    </ClubPrivateDataBoundary>
  );
  try {
    // Visible notes can precede the cards' deferred initial reads. Finish the
    // bootstrap and observe each initial RPC before measuring ambient rereads.
    await waitFor(() => expect(state.getMemberDetail).toHaveBeenCalledTimes(1));
    await act(async () => initial.resolve(memberDetail));
    await waitFor(() => {
      expect(
        state.rpc.mock.calls.filter(([name]) => name === 'ca_club_member_win_loss')
      ).toHaveLength(1);
      expect(
        state.rpc.mock.calls.filter(([name]) => name === 'ca_club_member_upline_chain')
      ).toHaveLength(1);
    });
    const nickname = await screen.findByRole('textbox', { name: 'Nickname' });
    fireEvent.change(nickname, { target: { value: 'Mounted Boundary Draft' } });
    const downlineReads = state.getDownline.mock.calls.length;
    const cardReads = state.rpc.mock.calls.filter(([name]) =>
      ['ca_club_member_win_loss', 'ca_club_member_upline_chain'].includes(name)
    ).length;
    const key =
      STATS_CACHE_PREFIX +
      JSON.stringify([
        2,
        state.viewerId,
        state.params.userId,
        '22222222-2222-4222-8222-222222222222',
      ]);
    localStorage.setItem(key, 'private');
    const authorityReads = state.getMemberDetail.mock.calls.length;
    await act(async () => {
      masterBus.emit('GAME_MANAGEMENT_ACCESS_CHANGED', {
        clubId: 'other-club',
        userId: state.viewerId,
      });
      masterBus.emit('GAME_MANAGEMENT_ACCESS_CHANGED', {
        clubId: '22222222-2222-4222-8222-222222222222',
        userId: 'other-viewer',
      });
    });
    expect(localStorage.getItem(key)).toBe('private');
    expect(state.getMemberDetail).toHaveBeenCalledTimes(authorityReads);
    await act(async () => {
      masterBus.emit('GAME_MANAGEMENT_ACCESS_CHANGED', {
        clubId: '22222222-2222-4222-8222-222222222222',
        userId: state.viewerId,
      });
    });
    expect(localStorage.getItem(key)).toBeNull();
    expect(screen.getByRole('textbox', { name: 'Nickname' })).toBe(nickname);
    expect(nickname).toHaveValue('Mounted Boundary Draft');
    expect(state.getDownline).toHaveBeenCalledTimes(downlineReads);
    expect(
      state.rpc.mock.calls.filter(([name]) =>
        ['ca_club_member_win_loss', 'ca_club_member_upline_chain'].includes(name)
      )
    ).toHaveLength(cardReads);
  } finally {
    view.unmount();
    useUserStore.setState({ user: priorUser });
  }
});

it('the mounted boundary delivers authoritative access withdrawal without rereading downline', async () => {
  const initial = deferred<typeof memberDetail>();
  state.getMemberDetail.mockReturnValueOnce(initial.promise);
  const priorUser = useUserStore.getState().user;
  useUserStore.setState({ user: { id: state.viewerId } as never });
  const view = render(
    <ClubPrivateDataBoundary>
      <MemberManagementPage />
    </ClubPrivateDataBoundary>
  );
  try {
    // Resolve bootstrap inside act so the resolved-club authority effect owns
    // the next event, matching the coalescing fixture above. Visible markup
    // alone does not establish that passive-effect handoff.
    await waitFor(() => expect(state.getMemberDetail).toHaveBeenCalledTimes(1));
    await act(async () => initial.resolve(memberDetail));
    await screen.findByRole('textbox', { name: 'Nickname' });
    const authorityReads = state.getMemberDetail.mock.calls.length;
    const reads = state.getDownline.mock.calls.length;
    state.getMemberDetail.mockRejectedValueOnce(new MemberAccessDeniedError());
    await act(async () => {
      masterBus.emit('GAME_MANAGEMENT_ACCESS_CHANGED', {
        clubId: '22222222-2222-4222-8222-222222222222',
        userId: state.viewerId,
        scope: 'club',
        scopeId: '22222222-2222-4222-8222-222222222222',
      });
    });
    expect(state.getMemberDetail).toHaveBeenCalledTimes(authorityReads + 1);
    const authorityCall = state.getMemberDetail.mock.calls.at(-1);
    expect(authorityCall?.[2]).toBeUndefined();
    expect(authorityCall?.[3]).toBeInstanceOf(AbortSignal);
    expect(authorityCall?.[3].aborted).toBe(false);
    expect(await screen.findByText('Member Not Found')).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'Nickname' })).not.toBeInTheDocument();
    expect(screen.queryByText('River Shark')).not.toBeInTheDocument();
    expect(state.getDownline).toHaveBeenCalledTimes(reads);
  } finally {
    view.unmount();
    useUserStore.setState({ user: priorUser });
  }
});

it('an all-club recipient invalidation withdraws mounted note and role authority in place', async () => {
  const priorUser = useUserStore.getState().user;
  useUserStore.setState({ user: { id: state.viewerId } as never });
  state.getMemberDetail.mockResolvedValue({
    ...memberDetail,
    capabilities: { ...memberDetail.capabilities, can_manage_role: true },
  });
  state.getGrantableRoles.mockResolvedValue(['admin']);
  const view = render(
    <ClubPrivateDataBoundary>
      <MemberManagementPage />
    </ClubPrivateDataBoundary>
  );
  try {
    await screen.findByRole('button', { name: /^Admin/ });
    const heading = screen.getByText('River Shark');
    const reads = state.getDownline.mock.calls.length;
    state.getMemberDetail.mockResolvedValue({
      ...memberDetail,
      capabilities: {
        ...memberDetail.capabilities,
        can_view_notes: false,
        can_edit_notes: false,
        can_manage_role: false,
      },
    });
    state.viewerRole = 'player';
    await act(async () => {
      masterBus.emit('GAME_MANAGEMENT_ACCESS_CHANGED', { userId: state.viewerId });
    });
    await waitFor(() =>
      expect(screen.queryByRole('textbox', { name: 'Nickname' })).not.toBeInTheDocument()
    );
    expect(screen.queryByRole('button', { name: /^Admin/ })).not.toBeInTheDocument();
    expect(screen.getByText('River Shark')).toBe(heading);
    expect(state.getDownline).toHaveBeenCalledTimes(reads);
  } finally {
    view.unmount();
    useUserStore.setState({ user: priorUser });
  }
});

it('a boundary access denial during the initial read cannot be undone by its late allowed answer', async () => {
  state.viewerId = 'initial-denial-viewer';
  const priorUser = useUserStore.getState().user;
  useUserStore.setState({ user: { id: state.viewerId } as never });
  const initial = deferred<typeof memberDetail>();
  state.getMemberDetail.mockReturnValueOnce(initial.promise);
  const view = render(
    <ClubPrivateDataBoundary>
      <MemberManagementPage />
    </ClubPrivateDataBoundary>
  );
  try {
    await waitFor(() => expect(state.getMemberDetail).toHaveBeenCalledTimes(1));
    state.getMemberDetail.mockRejectedValueOnce(new MemberAccessDeniedError());
    await act(async () => {
      masterBus.emit('GAME_MANAGEMENT_ACCESS_CHANGED', {
        clubId: '22222222-2222-4222-8222-222222222222',
        userId: state.viewerId,
      });
    });
    expect(await screen.findByText('Member Not Found')).toBeInTheDocument();
    await act(async () => initial.resolve(memberDetail));
    expect(screen.getByText('Member Not Found')).toBeInTheDocument();
    expect(screen.queryByText('River Shark')).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'Nickname' })).not.toBeInTheDocument();
  } finally {
    view.unmount();
    useUserStore.setState({ user: priorUser });
  }
});

it('a positive boundary authority check fences the old initial response and admits one fresh record', async () => {
  state.viewerId = 'initial-allowed-viewer';
  const priorUser = useUserStore.getState().user;
  useUserStore.setState({ user: { id: state.viewerId } as never });
  const initial = deferred<typeof memberDetail>();
  const authority = deferred<typeof memberDetail>();
  const fresh = deferred<typeof memberDetail>();
  state.getMemberDetail
    .mockReturnValueOnce(initial.promise)
    .mockReturnValueOnce(authority.promise)
    .mockReturnValueOnce(fresh.promise);
  const view = render(
    <ClubPrivateDataBoundary>
      <MemberManagementPage />
    </ClubPrivateDataBoundary>
  );
  try {
    await waitFor(() => expect(state.getMemberDetail).toHaveBeenCalledTimes(1));
    await act(async () => {
      masterBus.emit('GAME_MANAGEMENT_ACCESS_CHANGED', {
        clubId: '22222222-2222-4222-8222-222222222222',
        userId: state.viewerId,
      });
    });
    expect(state.getMemberDetail).toHaveBeenCalledTimes(2);
    await act(async () => initial.resolve(memberDetail));
    expect(screen.queryByText('River Shark')).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'Nickname' })).not.toBeInTheDocument();
    await act(async () => authority.resolve(memberDetail));
    expect(state.getMemberDetail).toHaveBeenCalledTimes(3);
    expect(screen.queryByText('River Shark')).not.toBeInTheDocument();
    await act(async () => fresh.resolve(memberDetail));
    expect(await screen.findByText('River Shark')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Nickname' })).toHaveValue('The Closer');
    expect(state.getDownline).toHaveBeenCalledTimes(2);
  } finally {
    view.unmount();
    useUserStore.setState({ user: priorUser });
  }
});

it('an old initial answer arriving before the authority denial remains unverified', async () => {
  state.viewerId = 'initial-reverse-denial-viewer';
  const priorUser = useUserStore.getState().user;
  useUserStore.setState({ user: { id: state.viewerId } as never });
  const initial = deferred<typeof memberDetail>();
  let deny!: (reason: unknown) => void;
  const authority = new Promise<typeof memberDetail>((_resolve, reject) => {
    deny = reject;
  });
  state.getMemberDetail.mockReturnValueOnce(initial.promise).mockReturnValueOnce(authority);
  const view = render(
    <ClubPrivateDataBoundary>
      <MemberManagementPage />
    </ClubPrivateDataBoundary>
  );
  try {
    await waitFor(() => expect(state.getMemberDetail).toHaveBeenCalledTimes(1));
    await act(async () => {
      masterBus.emit('GAME_MANAGEMENT_ACCESS_CHANGED', {
        clubId: '22222222-2222-4222-8222-222222222222',
        userId: state.viewerId,
      });
    });
    await act(async () => initial.resolve(memberDetail));
    expect(screen.queryByText('River Shark')).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'Nickname' })).not.toBeInTheDocument();
    await act(async () => deny(new MemberAccessDeniedError()));
    expect(await screen.findByText('Member Not Found')).toBeInTheDocument();
    expect(screen.queryByText('River Shark')).not.toBeInTheDocument();
    expect(state.getDownline).toHaveBeenCalledTimes(1);
  } finally {
    view.unmount();
    useUserStore.setState({ user: priorUser });
  }
});

it('renders the member before an independent downline request settles', async () => {
  const downline = deferred<never[]>();
  state.getDownline.mockReturnValueOnce(downline.promise);
  render(<MemberManagementPage />);
  expect(await screen.findByText('River Shark')).toBeInTheDocument();
  await act(async () => downline.resolve([]));
});

it('does not apply a delayed live stats response after a newer explicit range read', async () => {
  render(<MemberManagementPage />);
  await screen.findByText('River Shark');
  const pending = deferred<typeof memberDetail>();
  state.getMemberDetail.mockReturnValueOnce(pending.promise);
  await act(async () => state.recordChannel?.onPayload({}));
  state.getMemberDetail.mockImplementation(async (_club, _member, activeRange) => ({
    ...memberDetail,
    identity: { ...memberDetail.identity, avatar_url: '/avatars/table/free_ninja@2x.webp' },
    stats: { ...memberDetail.stats, hands: 777 },
    range: { ...activeRange, is_overall: false },
  }));
  fireEvent.click(screen.getByRole('button', { name: '7 Days' }));
  expect(await screen.findByText('777')).toBeInTheDocument();
  await act(async () =>
    pending.resolve({
      ...memberDetail,
      identity: { ...memberDetail.identity, avatar_url: '/avatars/table/free_shark@2x.webp' },
      stats: { ...memberDetail.stats, hands: 999 },
    })
  );
  expect(screen.getByText('777')).toBeInTheDocument();
  expect(screen.queryByText('999')).not.toBeInTheDocument();
  expect(document.querySelector('.mm-avatar img')).toHaveAttribute(
    'src',
    expect.stringContaining('free_ninja')
  );
});

it('keeps a verified member visible when its separate viewer-role read fails closed', async () => {
  state.viewerRoleError = new Error('role transport unavailable');
  render(<MemberManagementPage />);
  expect(await screen.findByText('River Shark')).toBeInTheDocument();
  await act(async () => {});
  expect(screen.queryByText('The Member Ledger Did Not Respond')).not.toBeInTheDocument();
  expect(state.toast.error).not.toHaveBeenCalled();
  expect(screen.queryByRole('button', { name: /^Admin/ })).not.toBeInTheDocument();
});

it('cannot restore a downline that settles after financial access is withdrawn', async () => {
  const downline = deferred<Array<{ user_id: string; alias: string }>>();
  state.getDownline.mockReturnValueOnce(downline.promise);
  render(<MemberManagementPage />);
  await screen.findByText('River Shark');
  state.getMemberDetail.mockResolvedValue({
    ...memberDetail,
    stats: null,
    wallets: null,
    downline: null,
    capabilities: { ...memberDetail.capabilities, can_view_financials: false },
  });
  await act(async () => state.recordChannel?.onPayload({}));
  await act(async () =>
    downline.resolve([{ user_id: '33333333-3333-4333-8333-333333333333', alias: 'Cyan Rail' }])
  );
  expect(screen.queryByText('Cash Hands')).not.toBeInTheDocument();
  expect(screen.queryByText('Cyan Rail')).not.toBeInTheDocument();
});

it('coalesces all member lifecycle catchups and keeps the post-start invalidation and newer wallet', async () => {
  render(<MemberManagementPage />);
  await screen.findByText('River Shark');
  fireEvent.click(screen.getByRole('button', { name: '7 Days' }));
  await waitFor(() => expect(state.getMemberDetail).toHaveBeenCalledTimes(2));
  const range = state.getMemberDetail.mock.calls.at(-1)?.[2];
  const nickname = screen.getByDisplayValue('The Closer');
  fireEvent.change(nickname, { target: { value: 'Lifecycle Local Draft' } });
  const first = deferred<typeof memberDetail>();
  const latest = deferred<typeof memberDetail>();
  state.getMemberDetail.mockReturnValueOnce(first.promise).mockReturnValueOnce(latest.promise);
  const before = state.getMemberDetail.mock.calls.length;
  await act(async () => {
    state.memberChannel?.onSubscriptionStatus?.('SUBSCRIBED');
    state.walletChannel?.onSubscriptionStatus?.('SUBSCRIBED');
    state.recordChannel?.onSubscriptionStatus?.('SUBSCRIBED');
  });
  expect(state.getMemberDetail).toHaveBeenCalledTimes(before + 1);
  await act(async () => first.resolve(memberDetail));
  await waitFor(() => expect(state.getMemberDetail).toHaveBeenCalledTimes(before + 2));
  expect(state.getMemberDetail.mock.calls.at(-1)?.[2]).toEqual(range);
  await act(async () =>
    state.memberChannel?.onPayload({
      eventType: 'UPDATE',
      new: {
        club_id: '22222222-2222-4222-8222-222222222222',
        user_id: state.params.userId,
        chip_balance: 777,
      },
    })
  );
  await act(async () =>
    latest.resolve({
      ...memberDetail,
      wallets: { chip_balance: 600, player_wallet: 600, agent_wallet: 1234, promo_wallet: 25 },
      stats: { ...memberDetail.stats, hands: 321 },
      range: { ...range, is_overall: false },
    })
  );
  expect(state.getMemberDetail).toHaveBeenCalledTimes(before + 2);
  expect(screen.getByText('777.00')).toBeInTheDocument();
  expect(screen.getByText('1,234.00')).toBeInTheDocument();
  expect(screen.getByText('321')).toBeInTheDocument();
  expect(screen.getByDisplayValue('Lifecycle Local Draft')).toBe(nickname);
});

it('keeps real wallet broadcasts in the wallet-only read lane', async () => {
  const initial = deferred<typeof memberDetail>();
  state.getMemberDetail.mockReturnValueOnce(initial.promise);
  render(<MemberManagementPage />);
  await waitFor(() => expect(state.getMemberDetail).toHaveBeenCalledTimes(1));
  await act(async () => initial.resolve(memberDetail));
  // Member text can appear before the child cards begin their initial reads.
  // Observe both bootstrap RPCs before measuring wallet-triggered rereads.
  await waitFor(() => {
    expect(
      state.rpc.mock.calls.filter(([name]) => name === 'ca_club_member_win_loss')
    ).toHaveLength(1);
    expect(
      state.rpc.mock.calls.filter(([name]) => name === 'ca_club_member_upline_chain')
    ).toHaveLength(1);
  });
  await screen.findByText('River Shark');
  const downlineReads = state.getDownline.mock.calls.length;
  const cardReads = state.rpc.mock.calls.length;
  state.getMemberDetail.mockResolvedValue({
    ...memberDetail,
    wallets: { ...memberDetail.wallets, agent_wallet: 1234 },
    stats: { ...memberDetail.stats, hands: 999 },
  });
  await act(async () =>
    state.walletChannel?.onPayload({
      payload: {
        club_id: '22222222-2222-4222-8222-222222222222',
        user_id: state.params.userId,
      },
    })
  );
  expect(screen.getByText('1,234.00')).toBeInTheDocument();
  expect(screen.queryByText('999')).not.toBeInTheDocument();
  expect(state.getDownline).toHaveBeenCalledTimes(downlineReads);
  expect(state.rpc).toHaveBeenCalledTimes(cardReads);
  expect(state.getMemberDetail.mock.calls.at(-1)?.[2]).toBeUndefined();
});

it('withdraws financial data when a lifecycle catchup denies access', async () => {
  render(<MemberManagementPage />);
  await screen.findByText('River Shark');
  await screen.findByText('500.00');
  await screen.findByText('Cyan Rail');
  const readsBeforeCatchup = state.getMemberDetail.mock.calls.length;
  state.getMemberDetail.mockResolvedValue({
    ...memberDetail,
    wallets: null,
    stats: null,
    downline: null,
    capabilities: { ...memberDetail.capabilities, can_view_financials: false },
  });
  await act(async () => state.walletChannel?.onSubscriptionStatus?.('SUBSCRIBED'));
  await waitFor(() => {
    expect(state.getMemberDetail.mock.calls.length).toBeGreaterThan(readsBeforeCatchup);
    expect(screen.queryByText('500.00')).not.toBeInTheDocument();
    expect(screen.queryByText('200')).not.toBeInTheDocument();
    expect(screen.queryByText('Cyan Rail')).not.toBeInTheDocument();
    expect(screen.getByText('River Shark')).toBeInTheDocument();
  });
});
