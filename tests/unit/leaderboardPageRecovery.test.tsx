import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import {
  LEADERBOARD_CACHE_PREFIX,
  leaderboardCacheKey,
  setCachedLeaderboardEntries,
} from '../../src/utils/leaderboardCache';

const h = vi.hoisted(() => ({
  user: { id: 'leaderboard-player' },
  getMemberships: vi.fn(),
  getClubLeaderboard: vi.fn(),
  getUserRank: vi.fn(),
  getLeaderboardRewardSetup: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock('../../src/hooks/useAuthUser', () => ({
  useAuthUser: () => ({ user: h.user, isHydrating: false }),
}));

vi.mock('../../src/services/ClubsService', () => ({
  getUserMemberships: h.getMemberships,
}));

vi.mock('../../src/services/LeaderboardService', () => ({
  LeaderboardService: {
    getClubLeaderboard: h.getClubLeaderboard,
    getGlobalLeaderboard: vi.fn().mockResolvedValue([]),
    getClubTournamentStats: vi.fn().mockResolvedValue([]),
    getUserRank: h.getUserRank,
    getGlobalUserRank: h.getUserRank,
    getPeriodWindow: vi.fn().mockResolvedValue({ start_date: '2026-09-28' }),
    getLeaderboardSettlementStatus: vi.fn().mockResolvedValue({ program: null }),
    getManageableRewardContexts: vi.fn().mockResolvedValue([]),
    getLeaderboardRewardSetup: h.getLeaderboardRewardSetup,
    getRewardProgramHistory: vi.fn().mockResolvedValue([]),
  },
}));

vi.mock('../../src/components/common/Toast', () => ({
  useToast: () => ({ error: h.toastError, success: vi.fn(), info: vi.fn(), warning: vi.fn() }),
}));

vi.mock('../../src/core/MasterBus', () => ({
  masterBus: { subscribeDebounced: vi.fn(() => vi.fn()) },
}));

vi.mock('../../src/hooks/useVisibilityRefresh', () => ({
  useVisibilityRefresh: () => ({ isRefreshing: false }),
}));

vi.mock('../../src/components/console/SpadeConsole', () => ({
  SpadeConsole: ({ children }: { children: React.ReactNode }) => <main>{children}</main>,
}));

vi.mock('../../src/components/avatars/PlayerAvatar', () => ({
  PlayerAvatar: () => <span>Player Avatar</span>,
}));

vi.mock('../../src/components/leaderboard/LeaderboardPrizeWizard', () => ({
  LeaderboardPrizeWizard: ({ isOpen }: { isOpen: boolean }) =>
    isOpen ? <div data-testid="leaderboard-prize-wizard" /> : null,
}));

vi.mock('../../src/components/leaderboard/LeaderboardSettlementCard', () => ({
  LeaderboardSettlementCard: () => null,
}));

import LeaderboardPage from '../../src/pages/LeaderboardPage';

function renderPage(path = '/leaderboard') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <CurrentSearch />
      <Routes>
        <Route path="/leaderboard" element={<LeaderboardPage />} />
      </Routes>
    </MemoryRouter>
  );
}

function CurrentSearch() {
  const location = useLocation();
  return <output data-testid="current-search">{location.search}</output>;
}

const memberships = [
  {
    club_id: 'club-one',
    role: 'player',
    club: { id: 'club-one', name: 'The Club', slug: 'the-club', club_id: '100001' },
  },
];

const cacheKey = leaderboardCacheKey(
  { kind: 'club', clubId: 'club-one', userId: 'leaderboard-player' },
  'profit',
  'weekly',
  0
);

function boardRow(username: string, value: number) {
  return {
    rank: 1,
    userId: 'leaderboard-player',
    username,
    value,
    metric: 'profit' as const,
    change: 0,
  };
}

describe('Leaderboard Page Recovery States', () => {
  beforeEach(() => {
    sessionStorage.clear();
    h.user.id = 'leaderboard-player';
    h.getMemberships.mockReset().mockResolvedValue(memberships);
    h.getClubLeaderboard.mockReset().mockResolvedValue([boardRow('Live Player', 100)]);
    h.getUserRank.mockReset().mockResolvedValue({ rank: 6, total: 20, value: 100 });
    h.getLeaderboardRewardSetup.mockReset().mockResolvedValue(null);
    h.toastError.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('shows A Retryable Membership Error Instead Of A False Empty Club State', async () => {
    h.getMemberships.mockRejectedValueOnce(new Error('Network Unavailable'));
    renderPage();

    expect(await screen.findByText('Your Club List Could Not Be Loaded.')).toBeInTheDocument();
    expect(
      screen.queryByText('Join A Club To See Leaderboard Rankings, Or Switch To Global.')
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Retry Club List' }));

    await waitFor(() => expect(screen.getByText('The Club')).toBeInTheDocument());
    expect(screen.queryByText('Your Club List Could Not Be Loaded.')).not.toBeInTheDocument();
  });

  it('Keeps Membership Recovery Pending Beyond Five Seconds Until The Read Resolves', async () => {
    vi.useFakeTimers();
    let resolveMemberships!: (value: typeof memberships) => void;
    h.getMemberships.mockReturnValueOnce(
      new Promise<typeof memberships>((resolve) => {
        resolveMemberships = resolve;
      })
    );
    renderPage();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(8000);
    });

    expect(screen.queryByText('Your Club List Could Not Be Loaded.')).not.toBeInTheDocument();

    await act(async () => {
      resolveMemberships(memberships);
    });

    expect(screen.getByText('The Club')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry Club List' })).not.toBeInTheDocument();
  });

  it('Reports A Personal-Rank Failure And Clears It After Retry', async () => {
    h.getUserRank
      .mockRejectedValueOnce(new Error('Rank Read Unavailable'))
      .mockResolvedValueOnce({ rank: 6, total: 20, value: 100 });
    renderPage();

    expect(await screen.findByText('Your Position Could Not Be Loaded.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry Position' }));

    await waitFor(() => expect(screen.getByText('Of 20')).toBeInTheDocument());
    expect(screen.queryByText('Your Position Could Not Be Loaded.')).not.toBeInTheDocument();
  });

  it('Disables Position Retry While The Rank-Only Request Is In Flight', async () => {
    let resolveRank!: (value: { rank: number; total: number; value: number }) => void;
    h.getUserRank.mockRejectedValueOnce(new Error('Rank Read Unavailable')).mockReturnValueOnce(
      new Promise((resolve) => {
        resolveRank = resolve;
      })
    );
    renderPage();

    const retryButton = await screen.findByRole('button', { name: 'Retry Position' });
    fireEvent.click(retryButton);

    await waitFor(() => expect(retryButton).toBeDisabled());
    expect(h.getUserRank).toHaveBeenCalledTimes(2);
    fireEvent.click(retryButton);
    expect(h.getUserRank).toHaveBeenCalledTimes(2);

    await act(async () => {
      resolveRank({ rank: 6, total: 20, value: 100 });
    });

    await waitFor(() => expect(screen.getByText('Of 20')).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: 'Retry Position' })).not.toBeInTheDocument();
  });

  it('Keeps A Cold Board Empty Until The Live Read Resolves Then Caches It', async () => {
    let resolveBoard!: (rows: ReturnType<typeof boardRow>[]) => void;
    h.getClubLeaderboard.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveBoard = resolve;
      })
    );
    renderPage();

    await waitFor(() => expect(h.getClubLeaderboard).toHaveBeenCalledTimes(1));
    expect(screen.queryByText('Live Player')).not.toBeInTheDocument();
    expect(screen.queryByText('Cached Player')).not.toBeInTheDocument();

    await act(async () => {
      resolveBoard([boardRow('Live Player', 100)]);
    });

    expect(await screen.findByText('Live Player')).toBeInTheDocument();
    expect(sessionStorage.getItem(LEADERBOARD_CACHE_PREFIX + cacheKey)).not.toBeNull();
  });

  it('Paints A Fresh Cached Board Before The Held Live Read Then Revalidates It', async () => {
    const cached = boardRow('Cached Player', 75);
    setCachedLeaderboardEntries(cacheKey, [cached]);
    let resolveBoard!: (rows: ReturnType<typeof boardRow>[]) => void;
    h.getClubLeaderboard.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveBoard = resolve;
      })
    );
    renderPage();

    expect(await screen.findByText('Cached Player')).toBeInTheDocument();
    await waitFor(() => expect(h.getClubLeaderboard).toHaveBeenCalledTimes(1));
    expect(screen.queryByText('Live Player')).not.toBeInTheDocument();

    await act(async () => {
      resolveBoard([boardRow('Live Player', 100)]);
    });

    expect(await screen.findByText('Live Player')).toBeInTheDocument();
    expect(screen.queryByText('Cached Player')).not.toBeInTheDocument();
  });

  it('Evicts An Expired Board And Never Paints Its Stale Rows', async () => {
    const now = 1_790_000_000_000;
    const dateNow = vi.spyOn(Date, 'now').mockReturnValue(now);
    setCachedLeaderboardEntries(cacheKey, [boardRow('Expired Player', 50)]);
    dateNow.mockReturnValue(now + 5 * 60 * 1000 + 1);
    let resolveBoard!: (rows: ReturnType<typeof boardRow>[]) => void;
    h.getClubLeaderboard.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveBoard = resolve;
      })
    );
    renderPage();

    await waitFor(() => expect(h.getClubLeaderboard).toHaveBeenCalledTimes(1));
    expect(screen.queryByText('Expired Player')).not.toBeInTheDocument();
    expect(sessionStorage.getItem(LEADERBOARD_CACHE_PREFIX + cacheKey)).toBeNull();

    await act(async () => {
      resolveBoard([boardRow('Live Player', 100)]);
    });
    expect(await screen.findByText('Live Player')).toBeInTheDocument();
    dateNow.mockRestore();
  });

  it('Shows The Empty State After A Successful Read With No Rankings', async () => {
    h.getClubLeaderboard.mockResolvedValueOnce([]);
    renderPage();

    expect(await screen.findByText('No Rankings Yet For This Period.')).toBeInTheDocument();
    expect(screen.queryByRole('status', { name: 'Loading Rankings...' })).not.toBeInTheDocument();
    expect(screen.queryByText('Rankings Could Not Be Loaded.')).not.toBeInTheDocument();
  });

  it('Reports A Ranking Read Failure And Recovers After Retry', async () => {
    h.getClubLeaderboard.mockRejectedValue(new Error('Read Unavailable'));
    renderPage();

    expect(
      await screen.findByText('Rankings Could Not Be Loaded.', {}, { timeout: 5000 })
    ).toBeInTheDocument();
    h.getClubLeaderboard.mockReset().mockResolvedValue([boardRow('Recovered Player', 120)]);
    fireEvent.click(screen.getByRole('button', { name: 'Retry Rankings' }));

    expect(await screen.findByText('Recovered Player')).toBeInTheDocument();
    expect(screen.queryByText('Rankings Could Not Be Loaded.')).not.toBeInTheDocument();
  });

  it('Resets The Period Offset When A Different Period Is Selected', async () => {
    renderPage();
    expect(await screen.findByText('Live Player')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Previous Period' }));
    await waitFor(() =>
      expect(h.getClubLeaderboard).toHaveBeenLastCalledWith(
        'club-one',
        'profit',
        'weekly',
        50,
        0,
        -1,
        true
      )
    );

    fireEvent.click(screen.getByRole('button', { name: 'Today' }));
    await waitFor(() =>
      expect(h.getClubLeaderboard).toHaveBeenLastCalledWith(
        'club-one',
        'profit',
        'daily',
        50,
        0,
        0,
        true
      )
    );
  });

  it('Discards An Older Period Response After The Selected Period Changes', async () => {
    renderPage();
    expect(await screen.findByText('Live Player')).toBeInTheDocument();

    let resolveOldPeriod!: (rows: ReturnType<typeof boardRow>[]) => void;
    h.getClubLeaderboard.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveOldPeriod = resolve;
      })
    );
    fireEvent.click(screen.getByRole('button', { name: 'Previous Period' }));
    await waitFor(() =>
      expect(h.getClubLeaderboard).toHaveBeenLastCalledWith(
        'club-one',
        'profit',
        'weekly',
        50,
        0,
        -1,
        true
      )
    );

    fireEvent.click(screen.getByRole('button', { name: 'Today' }));
    await waitFor(() =>
      expect(h.getClubLeaderboard).toHaveBeenLastCalledWith(
        'club-one',
        'profit',
        'daily',
        50,
        0,
        0,
        true
      )
    );
    expect(await screen.findByText('Live Player')).toBeInTheDocument();

    await act(async () => {
      resolveOldPeriod([boardRow('Stale Weekly Player', 40)]);
    });

    expect(screen.queryByText('Stale Weekly Player')).not.toBeInTheDocument();
    expect(screen.getByText('Live Player')).toBeInTheDocument();
  });

  it('Does Not Cache A Ranking Response That Resolves After Unmount', async () => {
    let resolveBoard!: (rows: ReturnType<typeof boardRow>[]) => void;
    h.getClubLeaderboard.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveBoard = resolve;
      })
    );
    const page = renderPage();

    await waitFor(() => expect(h.getClubLeaderboard).toHaveBeenCalledTimes(1));
    page.unmount();

    await act(async () => {
      resolveBoard([boardRow('Unmounted Player', 80)]);
    });

    expect(sessionStorage.getItem(LEADERBOARD_CACHE_PREFIX + cacheKey)).toBeNull();
  });

  it('Uses The New Account Cache And Rejects The Previous Account Read', async () => {
    const otherAccountKey = leaderboardCacheKey(
      { kind: 'club', clubId: 'club-one', userId: 'leaderboard-player-two' },
      'profit',
      'weekly',
      0
    );
    setCachedLeaderboardEntries(cacheKey, [boardRow('First Account Cache', 100)]);
    setCachedLeaderboardEntries(otherAccountKey, [boardRow('Second Account Cache', 200)]);

    let resolveFirstAccount!: (rows: ReturnType<typeof boardRow>[]) => void;
    h.getClubLeaderboard.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveFirstAccount = resolve;
      })
    );
    const firstAccountPage = renderPage();
    expect(await screen.findByText('First Account Cache')).toBeInTheDocument();
    await waitFor(() => expect(h.getClubLeaderboard).toHaveBeenCalledTimes(1));

    h.user.id = 'leaderboard-player-two';
    firstAccountPage.unmount();
    let resolveSecondAccount!: (rows: ReturnType<typeof boardRow>[]) => void;
    h.getClubLeaderboard.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveSecondAccount = resolve;
      })
    );
    renderPage();

    expect(await screen.findByText('Second Account Cache')).toBeInTheDocument();
    expect(screen.queryByText('First Account Cache')).not.toBeInTheDocument();

    await act(async () => {
      resolveFirstAccount([boardRow('Stale First Account Player', 10)]);
    });

    expect(screen.queryByText('Stale First Account Player')).not.toBeInTheDocument();
    expect(screen.getByText('Second Account Cache')).toBeInTheDocument();

    await act(async () => {
      resolveSecondAccount([boardRow('Second Account Live Player', 220)]);
    });

    expect(await screen.findByText('Second Account Live Player')).toBeInTheDocument();
    expect(screen.queryByText('Second Account Cache')).not.toBeInTheDocument();
  });

  it('Clears An Unavailable Club Deep Link Instead Of Loading That Club', async () => {
    renderPage('/leaderboard?club=not-a-member-club');

    expect(await screen.findByText('The Club')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('current-search')).toHaveTextContent(''));
    expect(h.toastError).toHaveBeenCalledWith(
      'That Club Leaderboard Is Not Available To You. Showing Your Clubs Instead.'
    );
    expect(h.getClubLeaderboard).toHaveBeenCalledWith(
      'club-one',
      'profit',
      'weekly',
      50,
      0,
      0,
      true
    );
    expect(h.getClubLeaderboard).not.toHaveBeenCalledWith(
      'not-a-member-club',
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything()
    );
  });

  it('Keeps Prize Setup Hidden For A Member Even When They Follow An Owner Deep Link', async () => {
    h.getLeaderboardRewardSetup.mockResolvedValueOnce({
      club_id: 'club-one',
      club_name: 'The Club',
      can_manage: false,
      setup_complete: false,
      funding_label: 'Club Promo Wallet',
      funding_owner_type: 'club',
      program_version: 0,
    });
    renderPage('/leaderboard?club=the-club&setup=prizes');

    await waitFor(() => expect(h.getLeaderboardRewardSetup).toHaveBeenCalledWith('club-one'));
    expect(screen.queryByRole('button', { name: 'Set Up Prizes' })).not.toBeInTheDocument();
    expect(screen.queryByTestId('leaderboard-prize-wizard')).not.toBeInTheDocument();
  });

  it('Opens Prize Setup For A Club Owner Authorized By The Server', async () => {
    h.getLeaderboardRewardSetup.mockResolvedValueOnce({
      club_id: 'club-one',
      club_name: 'The Club',
      can_manage: true,
      setup_complete: false,
      funding_label: 'Club Promo Wallet',
      funding_owner_type: 'club',
      program_version: 0,
    });
    renderPage();

    const setupButtons = await screen.findAllByRole('button', { name: 'Set Up Prizes' });
    expect(setupButtons).toHaveLength(2);
    fireEvent.click(setupButtons[0]);
    expect(await screen.findByTestId('leaderboard-prize-wizard')).toBeInTheDocument();
  });
});
