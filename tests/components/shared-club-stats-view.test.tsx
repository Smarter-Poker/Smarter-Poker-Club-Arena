import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  listClubs: vi.fn(),
  getOverview: vi.fn(),
  reportError: vi.fn(),
}));
vi.mock('../../src/services/SharedClubStatsService', () => ({
  SharedClubStatsService: { listClubs: mocks.listClubs, getOverview: mocks.getOverview },
}));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: mocks.reportError }));

import SharedClubStatsView from '../../src/pages/stats/SharedClubStatsView';

const clubs = [
  { id: 'club-a', name: 'Alpha' },
  { id: 'club-b', name: 'Bravo' },
];
const overview = { overview: { hands: 1 }, tournaments: {} };

const props = {
  targetUserId: 'target',
  asset: 'chips',
  timezone: 'UTC',
  rangeKey: 'all',
  windowDays: null,
  onClubChange: vi.fn(),
  onRangeChange: vi.fn(),
};

describe('SharedClubStatsView', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listClubs.mockResolvedValue(clubs);
    mocks.getOverview.mockResolvedValue(overview);
  });

  it('synchronizes browser back/forward club scope including the default URL', async () => {
    const { rerender } = render(<SharedClubStatsView {...props} initialClubId="club-a" />);
    await waitFor(() =>
      expect(mocks.getOverview).toHaveBeenLastCalledWith('target', 'club-a', null, 'UTC', 'chips')
    );

    rerender(<SharedClubStatsView {...props} initialClubId="club-b" />);
    await waitFor(() =>
      expect(mocks.getOverview).toHaveBeenLastCalledWith('target', 'club-b', null, 'UTC', 'chips')
    );
    expect(screen.getByRole('button', { name: 'Bravo' })).toHaveAttribute('aria-pressed', 'true');

    rerender(<SharedClubStatsView {...props} initialClubId={null} />);
    await waitFor(() =>
      expect(mocks.getOverview).toHaveBeenLastCalledWith('target', 'club-a', null, 'UTC', 'chips')
    );
    expect(props.onClubChange).toHaveBeenLastCalledWith('club-a', true);
  });

  it('retries the failed access layer instead of a stale overview', async () => {
    mocks.listClubs.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(clubs);
    render(<SharedClubStatsView {...props} initialClubId={null} />);
    const retry = await screen.findByRole('button', { name: 'Retry Shared Clubs' });
    fireEvent.click(retry);
    await waitFor(() => expect(mocks.listClubs).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(mocks.getOverview).toHaveBeenCalled());
  });
});
