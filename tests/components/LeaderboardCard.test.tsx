import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const { getLeaderboard, auth } = vi.hoisted(() => ({
  getLeaderboard: vi.fn(),
  auth: { user: { id: 'me' } },
}));
vi.mock('../../src/services/PromotionService', () => ({ promotionService: { getLeaderboard } }));
vi.mock('../../src/hooks/useAuthUser', () => ({ useAuthUser: () => auth }));
vi.mock('../../src/hooks/useMasterBusSubscription', () => ({ useMasterBusSubscription: vi.fn() }));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: vi.fn() }));
import LeaderboardCard from '../../src/components/leaderboard/LeaderboardCard';

const entry = (userId: string, rank = 1) => ({
  userId,
  rank,
  username: userId,
  score: 19255.12,
  prize: 250,
});
describe('Promotion Leaderboard Console', () => {
  beforeEach(() => getLeaderboard.mockReset());
  it('uses one painted frame, or none when embedded on existing glass', async () => {
    getLeaderboard.mockResolvedValue([entry('me')]);
    const { container, rerender } = render(<LeaderboardCard promotionId="a" />);
    await screen.findByText('19.2K');
    expect(container.querySelectorAll('.sc')).toHaveLength(1);
    expect(screen.getByText('Prize 250')).toBeInTheDocument();
    rerender(<LeaderboardCard promotionId="a" variant="glass" />);
    expect(container.querySelectorAll('.sc')).toHaveLength(0);
  });
  it('does not render a load error as an empty leaderboard and supports retry', async () => {
    getLeaderboard.mockRejectedValueOnce(new Error('Offline')).mockResolvedValue([entry('me')]);
    render(<LeaderboardCard promotionId="a" />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Rankings Could Not Be Updated');
    expect(screen.queryByText('No Entries Yet')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Retry Rankings' }));
    await screen.findByText('19.2K');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
  it('ignores an older promotion response after the selection changes', async () => {
    let finishOld!: (rows: unknown[]) => void;
    getLeaderboard.mockImplementation((id: string) =>
      id === 'old'
        ? new Promise((resolve) => {
            finishOld = resolve;
          })
        : Promise.resolve([entry('New Board')])
    );
    const { rerender } = render(<LeaderboardCard promotionId="old" showCurrentUser={false} />);
    rerender(<LeaderboardCard promotionId="new" showCurrentUser={false} />);
    await screen.findByText('New Board');
    await act(async () => finishOld([entry('Old Board')]));
    expect(screen.queryByText('Old Board')).not.toBeInTheDocument();
    expect(screen.getByText('New Board')).toBeInTheDocument();
  });
  it('clears the pinned rank when the new promotion has no matching player', async () => {
    getLeaderboard.mockImplementation((id: string, limit: number) =>
      Promise.resolve(id === 'old' && limit === 1000 ? [entry('me', 15)] : [entry('Leader')])
    );
    const { rerender } = render(<LeaderboardCard promotionId="old" />);
    await screen.findByText('Your Position');
    rerender(<LeaderboardCard promotionId="new" />);
    await waitFor(() => expect(getLeaderboard).toHaveBeenCalledWith('new', 1000));
    await waitFor(() => expect(screen.queryByText('Your Position')).not.toBeInTheDocument());
    expect(screen.queryByText('#15')).not.toBeInTheDocument();
  });
});
