import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
}));

vi.mock('react-router-dom', () => ({
  useParams: () => state.params,
  useSearchParams: () => [new URLSearchParams(), vi.fn()],
  useNavigate: () => state.navigate,
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
    from: () => {
      const chain: Record<string, unknown> = {};
      const self = () => chain;
      Object.assign(chain, {
        select: self,
        eq: self,
        abortSignal: self,
        maybeSingle: async () => ({ data: { role: 'owner' }, error: null }),
      });
      return chain;
    },
    rpc: vi.fn().mockResolvedValue({ data: { roles: [] }, error: null }),
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
    can_edit_notes: false,
    can_manage_role: false,
  },
};

const memberStats = {
  authorized: true,
  reason: null,
  variant: 'all',
  variants: ['no_limit_holdem'],
  hands: 200,
  hands_won: 44,
  win_rate: 22,
  vpip: 31.2,
  pfr: 22.1,
  three_bet: 8.4,
  three_bets: 17,
  fold_to_three_bet: 42,
  faced_three_bets: 12,
  cbet: 61,
  cbet_opportunities: 31,
  net: 120,
  fees: 18,
  from: '2026-08-08',
  to: '2026-09-06',
  is_overall: false,
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
  state.getMemberStatistics.mockResolvedValue(memberStats);
});

afterEach(() => cleanup());

describe('Players detail surfaces', () => {
  it('ignores an older member response after a newer refresh has completed', async () => {
    let finishOld!: (value: typeof memberDetail) => void;
    state.getMemberDetail.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishOld = resolve;
        })
    );
    const view = render(<MemberManagementPage />);
    await waitFor(() => expect(state.getMemberDetail).toHaveBeenCalledTimes(1));
    const oldSignal = state.getMemberDetail.mock.calls[0][3] as AbortSignal;
    state.params = { ...state.params, userId: '33333333-3333-4333-8333-333333333333' };
    state.getMemberDetail.mockResolvedValue({
      ...memberDetail,
      identity: { ...memberDetail.identity, alias: 'New Player' },
    });
    view.rerender(<MemberManagementPage />);
    expect(await screen.findByRole('heading', { name: 'New Player' })).toBeVisible();
    expect(oldSignal.aborted).toBe(true);
    await act(async () => finishOld(memberDetail));
    expect(screen.queryByRole('heading', { name: 'River Shark' })).not.toBeInTheDocument();
  });

  it('reports a role-options outage distinctly from missing permission', async () => {
    state.getMemberDetail.mockResolvedValue({
      ...memberDetail,
      capabilities: { ...memberDetail.capabilities, can_manage_role: true },
    });
    state.getGrantableRoles.mockRejectedValueOnce(new Error('transport failed'));
    render(<MemberManagementPage />);
    expect(
      await screen.findByText(
        'Role Options Could Not Be Loaded. Refresh This Player Record To Retry.'
      )
    ).toBeVisible();
    expect(
      screen.queryByText('Your Role Does Not Allow Changing Anyone Else’s.')
    ).not.toBeInTheDocument();
  });

  it('keeps an unknown note operation identity and payload for explicit retry', async () => {
    state.getMemberDetail.mockResolvedValue({
      ...memberDetail,
      capabilities: { ...memberDetail.capabilities, can_edit_notes: true },
    });
    state.updateMemberNotes.mockRejectedValueOnce(new Error('Unknown Acknowledgement'));
    state.updateMemberNotes.mockResolvedValue({
      nickname: 'Saved Draft',
      remark: memberDetail.identity.remark,
      replayed: true,
    });
    render(<MemberManagementPage />);
    const name = await screen.findByRole('textbox', { name: 'Nickname' });
    fireEvent.change(name, { target: { value: 'Saved Draft' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Notes' }));
    await waitFor(() => expect(state.toast.error).toHaveBeenCalled());
    expect(state.updateMemberNotes).toHaveBeenCalledTimes(1);
    const first = state.updateMemberNotes.mock.calls[0];
    expect(screen.getByRole('button', { name: 'Revert' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Save Notes' })).toBeEnabled();
    expect(screen.getByText('Save Outcome Is Unconfirmed. Retry The Same Request.')).toBeVisible();
    fireEvent.change(name, { target: { value: 'Newer Draft' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Notes' }));
    await waitFor(() => expect(state.updateMemberNotes).toHaveBeenCalledTimes(2));
    expect(state.updateMemberNotes.mock.calls[1]).toEqual(first);
    expect(name).toHaveValue('Newer Draft');
  });

  it('does not label old ledger figures with a failed new range', async () => {
    render(<MemberManagementPage />);
    await screen.findByRole('heading', { name: 'River Shark' });
    state.getMemberDetail.mockRejectedValueOnce(new Error('range unavailable'));
    fireEvent.click(screen.getByRole('button', { name: '7 Days' }));
    expect(await screen.findByText('The Member Ledger Did Not Respond')).toBeVisible();
    expect(screen.queryByText('Cash Hands')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry Member' }));
    expect(await screen.findByRole('heading', { name: 'River Shark' })).toBeVisible();
  });

  it('clears the prior player figures and variants on a statistics route change', async () => {
    const view = render(<PlayerStatisticsPage />);
    expect(await screen.findByRole('heading', { name: 'Playing Style' })).toBeVisible();
    state.params = { ...state.params, userId: '33333333-3333-4333-8333-333333333333' };
    state.getMemberStatistics.mockImplementation(() => new Promise(() => {}));
    view.rerender(<PlayerStatisticsPage />);
    await waitFor(() =>
      expect(screen.queryByRole('heading', { name: 'Playing Style' })).not.toBeInTheDocument()
    );
    expect(screen.queryByRole('option', { name: 'No Limit Holdem' })).not.toBeInTheDocument();
  });

  it('renders the audited credential and wires every player destination', async () => {
    render(<MemberManagementPage />);

    expect(await screen.findByRole('heading', { name: 'River Shark' })).toBeVisible();
    expect(screen.getByText('Audited Player Credential')).toBeVisible();
    expect(screen.getByText('At A Table')).toBeVisible();
    expect(screen.getByText('ID: 1042')).toBeVisible();
    expect(document.querySelector<HTMLImageElement>('.mm-credential__art')?.src).toContain(
      'member-credential-v1.webp'
    );

    fireEvent.click(screen.getByRole('button', { name: 'Open Cyan Rail, Player' }));
    expect(state.navigate).toHaveBeenCalledWith(
      '/clubs/shark-club/members/33333333-3333-4333-8333-333333333333'
    );
    fireEvent.click(screen.getByRole('button', { name: /Player Statistics/i }));
    expect(state.navigate).toHaveBeenCalledWith(
      '/clubs/shark-club/members/11111111-1111-4111-8111-111111111111/statistics'
    );
  });

  it('renders the felt instrument board with live summary readouts', async () => {
    render(<PlayerStatisticsPage />);

    expect(await screen.findByRole('heading', { name: 'Player Performance' })).toBeVisible();
    expect(screen.getByText('Measured From Verified Hands')).toBeVisible();
    expect(screen.getByRole('heading', { name: 'Instrument Controls' })).toBeVisible();
    // The hero and the controls paint at once; the cards paint only after the
    // statistics resolve. Under runner load that gap was long enough for a
    // synchronous read to miss (CI run 34176461133, 2026-09-08), so wait for
    // the first card the way the header is waited for.
    expect(await screen.findByRole('heading', { name: 'Playing Style' })).toBeVisible();
    expect(screen.getByRole('heading', { name: 'Volume' })).toBeVisible();
    expect(screen.getByRole('heading', { name: 'Club Result' })).toBeVisible();
    expect(document.querySelector<HTMLImageElement>('.ps-hero__art')?.src).toContain(
      'player-instrument-felt-v1.webp'
    );
    expect(screen.getAllByText('120')).toHaveLength(2);
    expect(screen.getByText('18')).toBeVisible();
    expect(screen.queryByText('120.00')).not.toBeInTheDocument();
    expect(screen.queryByText('18.00')).not.toBeInTheDocument();
  });

  it('keeps the last verified figures visible and names a failed range refresh', async () => {
    render(<PlayerStatisticsPage />);

    expect(await screen.findByRole('heading', { name: 'Playing Style' })).toBeVisible();
    state.getMemberStatistics.mockRejectedValueOnce(new Error('range refresh failed'));

    fireEvent.click(screen.getByRole('button', { name: 'Week' }));

    const warning = await screen.findByRole('alert');
    expect(warning).toHaveTextContent('Statistics Connection Interrupted');
    expect(warning).toHaveTextContent('The Figures Below Are From The Previous Successful Read.');
    expect(screen.getByRole('heading', { name: 'Playing Style' })).toBeVisible();
    expect(screen.queryByText('!')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Try Again' }));
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
    expect(state.getMemberStatistics).toHaveBeenCalledTimes(3);
  });

  it('uses the integrated connection status instead of a floating error glyph', async () => {
    state.getMemberStatistics.mockRejectedValueOnce(new Error('initial read failed'));
    render(<PlayerStatisticsPage />);

    const errorState = await screen.findByRole('alert');
    expect(errorState).toHaveTextContent('Statistics Connection Interrupted');
    expect(errorState).toHaveTextContent('Could Not Load Statistics');
    expect(errorState).not.toHaveTextContent('!');
    expect(screen.getByRole('button', { name: 'Try Again' })).toBeVisible();
  });

  it('settles malformed route states instead of leaving either page in a skeleton', async () => {
    state.params = {};
    const member = render(<MemberManagementPage />);
    expect(await screen.findByText('Member Not Found')).toBeVisible();
    member.unmount();

    render(<PlayerStatisticsPage />);
    expect(await screen.findByText('Member Not Found')).toBeVisible();
    expect(state.getMemberDetail).not.toHaveBeenCalled();
    expect(state.getMemberStatistics).not.toHaveBeenCalled();
  });
});

describe('Players Casino Realism asset and interaction contracts', () => {
  const root = resolve(__dirname, '../..');
  const files = [
    'public/images/club-members/roster-ledger-desk-v2.webp',
    'public/images/club-members/member-credential-v1.webp',
    'public/images/club-members/player-instrument-felt-v1.webp',
  ];

  it.each(files)('%s exists and is web-sized', (file) => {
    const path = resolve(root, file);
    expect(existsSync(path)).toBe(true);
    expect(statSync(path).size).toBeLessThan(200_000);
  });

  it('keeps three distinct compositions and accessible responsive controls', () => {
    const member = readFileSync(resolve(root, 'src/pages/MemberManagementPage.css'), 'utf8');
    const stats = readFileSync(resolve(root, 'src/pages/PlayerStatisticsPage.css'), 'utf8');
    const roster = readFileSync(resolve(root, 'src/pages/ClubMembersPage.css'), 'utf8');
    const cashier = readFileSync(
      resolve(root, 'src/components/agent/ChipTransferModal.css'),
      'utf8'
    );

    expect(new Set(files).size).toBe(3);
    for (const css of [member, stats, roster, cashier]) {
      expect(css).toContain(':focus-visible');
      expect(css).toContain('prefers-reduced-motion');
      expect(css).toMatch(/min-height:\s*(44|46|48|50|52)px/);
    }
    expect(cashier).toContain('.chip-transfer-modal .form-group');
    expect(cashier).not.toMatch(/(^|\})\s*\.form-group\s*\{/m);
  });
});

it('clears private statistics when the signed-in viewer changes and ignores their late answer', async () => {
  let finishOld!: (value: typeof memberStats) => void;
  state.getMemberStatistics.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishOld = resolve;
      })
  );
  const view = render(<PlayerStatisticsPage />);
  await waitFor(() => expect(state.getMemberStatistics).toHaveBeenCalledTimes(1));
  const oldSignal = state.getMemberStatistics.mock.calls[0][4] as AbortSignal;
  state.viewerId = 'viewer-2';
  state.getMemberStatistics.mockResolvedValue({
    ...memberStats,
    authorized: false,
    reason: 'restricted',
  });
  view.rerender(<PlayerStatisticsPage />);
  expect(await screen.findByText('Statistics Restricted')).toBeVisible();
  expect(oldSignal.aborted).toBe(true);
  await act(async () => finishOld(memberStats));
  expect(screen.queryByRole('heading', { name: 'Playing Style' })).not.toBeInTheDocument();
});

it('preserves unsaved notes when a range refresh returns newer remote notes', async () => {
  state.getMemberDetail.mockResolvedValue({
    ...memberDetail,
    capabilities: { ...memberDetail.capabilities, can_edit_notes: true },
  });
  render(<MemberManagementPage />);
  const name = await screen.findByRole('textbox', { name: 'Nickname' });
  fireEvent.change(name, { target: { value: 'Local Draft' } });
  state.getMemberDetail.mockResolvedValue({
    ...memberDetail,
    identity: { ...memberDetail.identity, nickname: 'Remote Name', remark: 'Remote Remark' },
    capabilities: { ...memberDetail.capabilities, can_edit_notes: true },
  });
  fireEvent.click(screen.getByRole('button', { name: '7 Days' }));
  await waitFor(() => expect(state.getMemberDetail).toHaveBeenCalledTimes(2));
  await waitFor(() =>
    expect(screen.getByRole('textbox', { name: 'Remark' })).toHaveValue('Remote Remark')
  );
  expect(name).toHaveValue('Local Draft');
  expect(screen.getByRole('button', { name: 'Save Notes' })).toBeEnabled();
});

it('keeps a local draft and original note receipt through a failed range read and retry', async () => {
  state.getMemberDetail.mockResolvedValue({
    ...memberDetail,
    capabilities: { ...memberDetail.capabilities, can_edit_notes: true },
  });
  state.updateMemberNotes.mockRejectedValueOnce(new Error('Unknown Acknowledgement'));
  state.updateMemberNotes.mockResolvedValue({
    nickname: 'Local Draft',
    remark: memberDetail.identity.remark,
    replayed: true,
  });
  render(<MemberManagementPage />);
  const name = await screen.findByRole('textbox', { name: 'Nickname' });
  fireEvent.change(name, { target: { value: 'Local Draft' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save Notes' }));
  await waitFor(() => expect(state.toast.error).toHaveBeenCalled());
  const original = state.updateMemberNotes.mock.calls[0];
  state.getMemberDetail.mockRejectedValueOnce(new Error('range unavailable'));
  fireEvent.click(screen.getByRole('button', { name: '7 Days' }));
  expect(await screen.findByText('The Member Ledger Did Not Respond')).toBeVisible();
  expect(screen.queryByText('Cash Hands')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Retry Member' }));
  expect(await screen.findByRole('textbox', { name: 'Nickname' })).toHaveValue('Local Draft');
  fireEvent.click(screen.getByRole('button', { name: 'Save Notes' }));
  await waitFor(() => expect(state.updateMemberNotes).toHaveBeenCalledTimes(2));
  expect(state.updateMemberNotes.mock.calls[1]).toEqual(original);
});
