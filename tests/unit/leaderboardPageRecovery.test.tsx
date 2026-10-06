import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
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
    getLeaderboardRewardSetup: vi.fn().mockResolvedValue(null),
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
  LeaderboardPrizeWizard: () => null,
}));

vi.mock('../../src/components/leaderboard/LeaderboardSettlementCard', () => ({
  LeaderboardSettlementCard: () => null,
}));

import LeaderboardPage from '../../src/pages/LeaderboardPage';

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/leaderboard']}>
      <Routes>
        <Route path="/leaderboard" element={<LeaderboardPage />} />
      </Routes>
    </MemoryRouter>
  );
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
    h.getMemberships.mockReset().mockResolvedValue(memberships);
    h.getClubLeaderboard.mockReset().mockResolvedValue([boardRow('Live Player', 100)]);
    h.getUserRank.mockReset().mockResolvedValue({ rank: 6, total: 20, value: 100 });
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
});
