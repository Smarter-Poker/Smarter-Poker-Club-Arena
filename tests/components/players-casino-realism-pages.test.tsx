import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  params: {
    clubId: 'shark-club',
    userId: '11111111-1111-4111-8111-111111111111',
  } as Record<string, string>,
  navigate: vi.fn(),
  getMemberDetail: vi.fn(),
  getDownline: vi.fn(),
  getMemberStatistics: vi.fn(),
}));

vi.mock('react-router-dom', () => ({
  useParams: () => state.params,
  useSearchParams: () => [new URLSearchParams(), vi.fn()],
  useNavigate: () => state.navigate,
}));

vi.mock('../../src/hooks/useAuthUser', () => ({
  useAuthUser: () => ({ user: { id: 'viewer-1' }, isHydrating: false }),
}));

vi.mock('../../src/components/common/Toast', () => ({
  useToast: () => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }),
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
  state.navigate.mockReset();
  state.getMemberDetail.mockReset();
  state.getDownline.mockReset();
  state.getMemberStatistics.mockReset();
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
    expect(screen.getByRole('heading', { name: 'Playing Style' })).toBeVisible();
    expect(screen.getByRole('heading', { name: 'Volume' })).toBeVisible();
    expect(screen.getByRole('heading', { name: 'Club Result' })).toBeVisible();
    expect(document.querySelector<HTMLImageElement>('.ps-hero__art')?.src).toContain(
      'player-instrument-felt-v1.webp'
    );
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
