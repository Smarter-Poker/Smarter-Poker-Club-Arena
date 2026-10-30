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
  search: new URLSearchParams(),
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
  useSearchParams: () => [state.search, vi.fn()],
  useNavigate: () => state.navigate,
}));

vi.mock('../../src/hooks/useAuthUser', () => ({
  useAuthUser: () => ({ user: { id: state.viewerId }, isHydrating: false }),
}));

vi.mock('../../src/components/common/Toast', () => ({
  useToast: () => state.toast,
}));

vi.mock('../../src/utils/errorReporter', () => ({ reportError: vi.fn() }));

// These page rendering/read-ownership cases do not deliver realtime events.
// Dedicated Player Command wallet tests exercise both channel callbacks.
vi.mock('../../src/hooks/useMasterBusChannel', () => ({ useMasterBusChannel: vi.fn() }));
vi.mock('../../src/hooks/useMasterBusBroadcastChannel', () => ({
  useMasterBusBroadcastChannel: vi.fn(),
}));

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
import { supabase } from '../../src/lib/supabase';

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
  // Each independent scenario starts with an account that has no saved preferences.
  localStorage.clear();
  state.params = {
    clubId: 'shark-club',
    userId: '11111111-1111-4111-8111-111111111111',
  };
  state.viewerId = 'viewer-1';
  state.search = new URLSearchParams();
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
  it('frames the current player role and opens individual rakeback editing without promotion', async () => {
    state.getMemberDetail.mockResolvedValue({
      ...memberDetail,
      capabilities: { ...memberDetail.capabilities, can_manage_role: true },
    });
    state.getGrantableRoles.mockResolvedValue(['agent', 'player']);
    vi.mocked(supabase.rpc).mockResolvedValue({
      data: {
        success: true,
        club_id: '22222222-2222-4222-8222-222222222222',
        user_id: '11111111-1111-4111-8111-111111111111',
        role: 'player',
        rate: 0.2,
        max_rate: 0.5,
      },
      error: null,
    } as never);
    render(<MemberManagementPage />);
    const current = await screen.findByRole('button', { name: /Player \(Current\)/ });
    expect(current).toHaveAttribute('aria-current', 'true');
    expect(current).toHaveClass('mm-roles__option--current');
    await waitFor(() => expect(current).toBeEnabled());
    fireEvent.click(current);
    expect(await screen.findByRole('spinbutton', { name: 'Rakeback Percent' })).toHaveValue(20);
    expect(
      vi.mocked(supabase.rpc).mock.calls.filter(([name]) => name === 'fn_club_set_member_role')
    ).toHaveLength(0);
  });

  it('returns keyboard focus to the current player when no role changes are grantable', async () => {
    state.getMemberDetail.mockResolvedValue({
      ...memberDetail,
      capabilities: { ...memberDetail.capabilities, can_manage_role: true },
    });
    state.getGrantableRoles.mockResolvedValue([]);
    vi.mocked(supabase.rpc).mockResolvedValue({
      data: {
        success: true,
        club_id: '22222222-2222-4222-8222-222222222222',
        user_id: '11111111-1111-4111-8111-111111111111',
        role: 'player',
        rate: 0.2,
        max_rate: 0.5,
      },
      error: null,
    } as never);
    render(<MemberManagementPage />);
    fireEvent.click(await screen.findByRole('button', { name: /Player \(Current\)/ }));
    await screen.findByRole('spinbutton', { name: 'Rakeback Percent' });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByRole('button', { name: /Player \(Current\)/ })).toHaveFocus();
  });

  it.each(['agent', 'admin'] as const)(
    'keeps keyboard focus through %s role confirmation and cancel without writing',
    async (grantRole) => {
      state.getMemberDetail.mockResolvedValue({
        ...memberDetail,
        capabilities: { ...memberDetail.capabilities, can_manage_role: true },
      });
      state.getGrantableRoles.mockResolvedValue([grantRole]);
      vi.mocked(supabase.rpc).mockClear();
      render(<MemberManagementPage />);
      const roleName = grantRole === 'agent' ? /Agent/ : /Admin/;
      const role = await screen.findByRole('button', { name: roleName });
      role.focus();
      fireEvent.click(role);
      const firstControl =
        grantRole === 'agent'
          ? await screen.findByRole('spinbutton', { name: 'Agent Rakeback Percent (0 To 70)' })
          : await screen.findByRole('button', { name: 'Confirm' });
      expect(firstControl).toHaveFocus();
      const cancel = screen.getByRole('button', { name: 'Cancel' });
      cancel.focus();
      fireEvent.click(cancel);
      expect(screen.getByRole('button', { name: roleName })).toHaveFocus();
      expect(
        screen.queryByRole('spinbutton', { name: 'Agent Rakeback Percent (0 To 70)' })
      ).not.toBeInTheDocument();
      expect(state.toast.success).not.toHaveBeenCalled();
      expect(
        vi.mocked(supabase.rpc).mock.calls.filter(([name]) => name === 'fn_club_set_member_role')
      ).toHaveLength(0);
    }
  );

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
      await screen.findByText('Role Options Could Not Be Loaded. Retry To Check Them Again.')
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
      '/clubs/shark-club/members/11111111-1111-4111-8111-111111111111/statistics?range=overall'
    );
  });

  it('renders the felt instrument board with live summary readouts', async () => {
    render(<PlayerStatisticsPage />);

    // Dan 2026-10-17: the title is a hidden heading in the page bar, and the
    // eyebrow, paragraph, felt art and duplicate hero readouts are gone.
    expect(await screen.findByRole('heading', { name: 'Player Performance' })).toBeInTheDocument();
    expect(screen.queryByText('Measured From Verified Hands')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Page Help' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Go Back' })).toBeVisible();
    expect(screen.getByRole('heading', { name: 'Instrument Controls' })).toBeVisible();
    // The hero and the controls paint at once; the cards paint only after the
    // statistics resolve. Under runner load that gap was long enough for a
    // synchronous read to miss (CI run 34176461133, 2026-09-08), so wait for
    // the first card the way the header is waited for.
    expect(await screen.findByRole('heading', { name: 'Playing Style' })).toBeVisible();
    expect(screen.getByRole('heading', { name: 'Volume' })).toBeVisible();
    expect(screen.getByRole('heading', { name: 'Club Result' })).toBeVisible();
    expect(document.querySelector('.ps-hero__art')).toBeNull();
    // Each figure prints once, on its card.
    // Net is a signed result (winLossChips), Fees a fee figure (feeFigure).
    expect(screen.getAllByText('+120')).toHaveLength(1);
    expect(screen.getByText('18.00')).toBeVisible();
    expect(screen.queryByText('120.00')).not.toBeInTheDocument();
    expect(screen.queryByText('18')).not.toBeInTheDocument();
  });

  it('keeps the last verified figures visible and names a failed range refresh', async () => {
    render(<PlayerStatisticsPage />);

    expect(await screen.findByRole('heading', { name: 'Playing Style' })).toBeVisible();
    state.getMemberStatistics.mockRejectedValueOnce(new Error('range refresh failed'));

    fireEvent.click(screen.getByRole('button', { name: '7 Days' }));

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

describe('the member record survives a failed background refresh', () => {
  const authorityEvent = async () => {
    const { useMasterBusBroadcastChannel } =
      await import('../../src/hooks/useMasterBusBroadcastChannel');
    const options = vi
      .mocked(useMasterBusBroadcastChannel)
      .mock.calls.map(([options]) => options)
      .filter((options) => options.event === 'record_changed')
      .at(-1)!;
    await act(async () => options.onPayload?.({}));
  };
  it('keeps the record on screen with a stale banner and no toast', async () => {
    // Finish initial scope effects before delivering the authority event. The
    // heading can paint before the passive effect installs its refresh ref.
    await act(async () => {
      render(<MemberManagementPage />);
    });
    expect(await screen.findByRole('heading', { name: 'River Shark' })).toBeVisible();
    // The heading can paint before the resolved-club authority effect settles.
    // Flush pending passive effects before delivering the one-shot event.
    await act(async () => {});
    // Own the authority read explicitly: rendering the heading alone does not
    // finish every initial read. A range read must not consume this failure.
    let failAuthority!: (error: Error) => void;
    const authorityRead = new Promise<never>((_, reject) => {
      failAuthority = reject;
    });
    state.getMemberDetail.mockImplementation((_club, _user, range) =>
      range === undefined ? authorityRead : Promise.resolve(memberDetail)
    );
    await authorityEvent();
    await waitFor(() => expect(state.getMemberDetail).toHaveBeenCalledTimes(2));
    expect(state.getMemberDetail.mock.calls[1][2]).toBeUndefined();
    await act(async () => failAuthority(new Error('offline')));
    const banner = await screen.findByRole('alert');
    expect(banner).toHaveTextContent('Member Connection Interrupted');
    expect(banner).toHaveTextContent('The Record Below Is From The Previous Successful Read.');
    expect(screen.getByRole('heading', { name: 'River Shark' })).toBeVisible();
    expect(screen.getByText('Cash Hands')).toBeVisible();
    expect(screen.queryByText('The Member Ledger Did Not Respond')).not.toBeInTheDocument();
    expect(state.toast.error).not.toHaveBeenCalled();

    // A second failed background read still does not toast.
    state.getMemberDetail.mockImplementation((_club, _user, range) =>
      range === undefined
        ? Promise.reject(new Error('still offline'))
        : Promise.resolve(memberDetail)
    );
    await authorityEvent();
    await waitFor(() => expect(state.getMemberDetail).toHaveBeenCalledTimes(3));
    expect(state.toast.error).not.toHaveBeenCalled();
    expect(screen.getByRole('heading', { name: 'River Shark' })).toBeVisible();

    state.getMemberDetail.mockResolvedValue(memberDetail);
    fireEvent.click(screen.getByRole('button', { name: 'Try Again' }));
    await waitFor(() =>
      expect(screen.queryByText('Member Connection Interrupted')).not.toBeInTheDocument()
    );
    expect(screen.getByRole('heading', { name: 'River Shark' })).toBeVisible();
  });

  it('confines a downline failure to the downline section', async () => {
    state.getDownline.mockRejectedValue(new Error('downline down'));
    render(<MemberManagementPage />);
    expect(await screen.findByRole('heading', { name: 'River Shark' })).toBeVisible();
    expect(screen.getByText('Cash Hands')).toBeVisible();
    expect(await screen.findByText('The Downline List Could Not Be Loaded.')).toBeVisible();
    expect(screen.queryByText('The Member Ledger Did Not Respond')).not.toBeInTheDocument();
    expect(state.toast.error).not.toHaveBeenCalled();
  });

  it('keeps a shown downline when only its refresh fails', async () => {
    render(<MemberManagementPage />);
    expect(await screen.findByText('Cyan Rail')).toBeVisible();
    state.getDownline.mockRejectedValueOnce(new Error('downline down'));
    fireEvent.click(screen.getByRole('button', { name: '7 Days', exact: true }));
    expect(
      await screen.findByText(
        'Could Not Refresh The Downline. Showing The Previous Successful Read.'
      )
    ).toBeVisible();
    expect(screen.getByText('Cyan Rail')).toBeVisible();
    expect(screen.queryByText('Member Connection Interrupted')).not.toBeInTheDocument();
  });

  it('subscribes to the lower-case record topic for an upper-case URL id', async () => {
    const { useMasterBusBroadcastChannel } =
      await import('../../src/hooks/useMasterBusBroadcastChannel');
    vi.mocked(useMasterBusBroadcastChannel).mockClear();
    state.params = { ...state.params, userId: state.params.userId.toUpperCase() };
    render(<MemberManagementPage />);
    expect(await screen.findByRole('heading', { name: 'River Shark' })).toBeVisible();
    const topics = vi
      .mocked(useMasterBusBroadcastChannel)
      .mock.calls.map(([options]) => options.channelName)
      .filter((name): name is string => !!name && name.startsWith('member-record:'));
    expect(topics).toContain(
      'member-record:22222222-2222-4222-8222-222222222222:11111111-1111-4111-8111-111111111111'
    );
    expect(topics.every((name) => name === name.toLowerCase())).toBe(true);
  });

  it('prints record monetary stats to the penny without compact rounding', async () => {
    state.getMemberDetail.mockResolvedValueOnce({
      ...memberDetail,
      stats: {
        ...memberDetail.stats,
        total_fee: 12345.67,
        total_winnings: -1250.75,
        mtt_winnings: -0.4,
      },
    });
    render(<MemberManagementPage />);
    expect(await screen.findByRole('heading', { name: 'River Shark' })).toBeVisible();
    expect(screen.getAllByText('500.00').length).toBeGreaterThan(0);
    expect(screen.getByText('25.00')).toBeVisible();
    expect(screen.getByText('-1,250.75')).toBeVisible();
    expect(screen.getByText('-0.40')).toBeVisible();
    expect(screen.getByText('12,345.67')).toBeVisible();
    expect(screen.getByText('MTT Fees').closest('.mm-stat')).toHaveTextContent('4.00');
  });
});

describe('the record opens Player Statistics on its own range', () => {
  it('carries the record range in the statistics link', async () => {
    render(<MemberManagementPage />);
    expect(await screen.findByRole('heading', { name: 'River Shark' })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: '7 Days' }));
    await waitFor(() => expect(state.getMemberDetail).toHaveBeenCalledTimes(2));
    await screen.findByRole('heading', { name: 'River Shark' });
    fireEvent.click(screen.getByRole('button', { name: /Player Statistics/i }));
    expect(state.navigate).toHaveBeenCalledWith(
      '/clubs/shark-club/members/11111111-1111-4111-8111-111111111111/statistics?range=week'
    );
  });

  it('opens on the carried 7 Days window', async () => {
    state.search = new URLSearchParams('range=week');
    render(<PlayerStatisticsPage />);
    expect(await screen.findByRole('heading', { name: 'Playing Style' })).toBeVisible();
    expect(screen.getByRole('button', { name: '7 Days' })).toHaveAttribute('aria-pressed', 'true');
    const range = state.getMemberStatistics.mock.calls[0][3];
    expect(range.from).not.toBeNull();
    expect(range.to).not.toBeNull();
  });

  it('opens on a carried custom window', async () => {
    state.search = new URLSearchParams('range=custom&from=2026-09-01&to=2026-09-30');
    render(<PlayerStatisticsPage />);
    expect(await screen.findByRole('heading', { name: 'Playing Style' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Custom' })).toHaveAttribute('aria-pressed', 'true');
    expect(state.getMemberStatistics.mock.calls[0][3]).toEqual({
      from: '2026-09-01',
      to: '2026-09-30',
    });
  });

  it.each([
    '',
    'range=fortnight',
    'range=custom&from=2026-09-30&to=2026-09-01',
    'range=custom&from=2026-02-30&to=2026-03-01',
  ])('falls back to Overall for %j', async (query) => {
    state.search = new URLSearchParams(query);
    render(<PlayerStatisticsPage />);
    expect(await screen.findByRole('heading', { name: 'Playing Style' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Overall' })).toHaveAttribute('aria-pressed', 'true');
    expect(state.getMemberStatistics.mock.calls[0][3]).toEqual({ from: null, to: null });
  });
});
