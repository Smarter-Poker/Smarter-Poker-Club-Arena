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
import PromoVaultPage from '../../src/pages/PromoVaultPage';
import { MemberAccessDeniedError } from '../../src/services/ClubRosterService';

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
  expect(screen.getByText('777')).toBeInTheDocument();
  expect(name).toHaveValue('Keep This Draft');
  expect(state.updateMemberNotes).not.toHaveBeenCalled();
  expect(state.getMemberDetail).toHaveBeenCalledTimes(1);
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
  expect(screen.queryByText('Total Fee')).not.toBeInTheDocument();
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
  expect(screen.queryByText('Total Fee')).not.toBeInTheDocument();
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
  expect(screen.queryByText('Total Fee')).not.toBeInTheDocument();
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
