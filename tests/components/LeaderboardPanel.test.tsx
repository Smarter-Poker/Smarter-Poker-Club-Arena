import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
vi.mock('../../src/services/SoundService', () => ({ haptic: { light: vi.fn() } }));
import { LeaderboardPanel } from '../../src/components/table/LeaderboardPanel';
const players = [
  {
    rank: 1,
    playerId: 'a',
    playerName: 'A Long Player Name',
    amount: 19255.12,
    isPositive: true,
    handsPlayed: 1500,
  },
];
describe('Table Leaderboard Console', () => {
  it('exposes all periods, preserves callbacks and prints compact rankings', () => {
    const onPeriodChange = vi.fn();
    const onClose = vi.fn();
    const { container } = render(
      <LeaderboardPanel
        isOpen
        onClose={onClose}
        title="Table Leaderboard"
        players={players}
        period="session"
        onPeriodChange={onPeriodChange}
      />
    );
    expect(screen.getByRole('dialog', { name: 'Table Leaderboard' })).toBeInTheDocument();
    expect(container.querySelectorAll('.sc')).toHaveLength(1);
    expect(screen.getByText('+19.2K')).toBeInTheDocument();
    expect(screen.getByText('1.5K Hands')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'All Time' }));
    expect(onPeriodChange).toHaveBeenCalledWith('allTime');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
  it('restores the body scroll state on close and distinguishes loading from empty', () => {
    document.body.style.overflow = 'auto';
    const props = {
      onClose: vi.fn(),
      title: 'Table Leaderboard',
      players: [],
      period: 'session' as const,
      onPeriodChange: vi.fn(),
    };
    const { rerender } = render(<LeaderboardPanel {...props} isOpen isLoading />);
    expect(screen.getByRole('status')).toHaveTextContent('Loading Rankings');
    expect(document.body.style.overflow).toBe('hidden');
    rerender(<LeaderboardPanel {...props} isOpen />);
    expect(screen.getByText('No Rankings Yet')).toBeInTheDocument();
    rerender(<LeaderboardPanel {...props} isOpen={false} />);
    expect(document.body.style.overflow).toBe('auto');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
