import React from 'react';
import { act, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  fetchClubs: vi.fn(),
  readCachedClubs: vi.fn(),
  readLastClubId: vi.fn(),
}));

vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>();
  return { ...actual, useNavigate: () => mocks.navigate };
});

vi.mock('../../src/hooks/useAuthUser', () => ({
  useAuthUser: () => ({ user: { id: 'player-1' }, isHydrating: false }),
}));

vi.mock('../../src/utils/clubQuickLink', () => ({
  fetchQuickLinkClubs: mocks.fetchClubs,
  readCachedQuickLinkClubs: mocks.readCachedClubs,
  readLastClubId: mocks.readLastClubId,
  resolveTargetClub: (clubs: Array<{ id: string }>) => clubs[0] ?? null,
}));

vi.mock('../../src/components/common/EmptyState', () => ({
  LoadingState: ({ message }: { message: string }) => <div>{message}</div>,
  ErrorState: ({ message }: { message: string }) => <div>{message}</div>,
  EmptyState: ({ title }: { title: string }) => <div>{title}</div>,
}));

import LegacyClubToolRedirect from '../../src/components/navigation/LegacyClubToolRedirect';

describe('LegacyClubToolRedirect', () => {
  beforeEach(() => {
    mocks.navigate.mockReset();
    mocks.fetchClubs.mockReset();
    mocks.readCachedClubs.mockReset();
    mocks.readLastClubId.mockReset();
    mocks.readCachedClubs.mockReturnValue([]);
    mocks.readLastClubId.mockReturnValue(null);
    mocks.fetchClubs.mockResolvedValue([]);
  });

  it('opens the cached club roster without waiting for another network read', async () => {
    mocks.readCachedClubs.mockReturnValue([{ id: 'club-1' }]);

    render(<LegacyClubToolRedirect destination="members" toolName="Players" />);

    await waitFor(() => {
      expect(mocks.navigate).toHaveBeenCalledWith('/clubs/club-1/members', { replace: true });
    });
    expect(mocks.fetchClubs).not.toHaveBeenCalled();
  });

  it('replaces an unbounded spinner with a recoverable error state', async () => {
    vi.useFakeTimers();
    mocks.fetchClubs.mockReturnValue(new Promise(() => undefined));
    try {
      render(<LegacyClubToolRedirect destination="members" toolName="Players" />);
      expect(screen.getByText('Opening Players')).toBeInTheDocument();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(8_000);
      });

      expect(
        screen.getByText('Club Arena could not determine which club should open Players.')
      ).toBeInTheDocument();
      expect(mocks.navigate).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
