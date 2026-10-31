import { render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import ClubScopeConsole from '../../src/pages/stats/ClubScopeConsole';

it('prints and sorts only comparison measures from the selected game mode', () => {
  const props = {
    statsScope: 'chips',
    clubLabel: 'All Clubs',
    selectedClubId: null,
    changeClub: vi.fn(),
    clubs: [],
    clubsLoading: false,
    clubsError: false,
    onRetryClubs: vi.fn(),
    comparisonOpen: true,
    setComparisonOpen: vi.fn(),
    onRetryComparison: vi.fn(),
    comparisonSort: 'hands' as const,
    changeComparisonSort: vi.fn(),
    comparisonLoading: false,
    comparisonError: false,
    sortedComparisonRows: [
      {
        club: { id: 'club-a', name: 'Alpha' },
        hands: 10,
        profit: 20,
        bb100: 2,
        vpip: 0.25,
        pfr: 0.2,
        hours: null,
        rake: 1,
        tournamentEntries: 2,
        tournamentCashes: 1,
        tournamentWins: 1,
        tournamentWinnings: 25,
        lastPlayedAt: null,
      },
    ],
  };
  const { rerender } = render(<ClubScopeConsole {...props} gameMode="cash" />);
  expect(screen.getByRole('columnheader', { name: 'Profit' })).toBeInTheDocument();
  expect(
    screen.queryByRole('columnheader', { name: 'Tournament Results' })
  ).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Tournaments' })).not.toBeInTheDocument();
  rerender(<ClubScopeConsole {...props} gameMode="tournament" />);
  expect(screen.getByRole('columnheader', { name: 'Tournament Results' })).toBeInTheDocument();
  for (const name of ['Profit', 'BB/100', 'Rake']) {
    expect(screen.queryByRole('columnheader', { name })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name })).not.toBeInTheDocument();
  }
});
