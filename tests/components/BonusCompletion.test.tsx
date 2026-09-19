import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import BonusCompletion from '../../src/components/games/BonusCompletion';
import MinesGrid from '../../src/components/games/MinesGrid';

const navigate = vi.hoisted(() => vi.fn());
vi.mock('react-router-dom', () => ({ useNavigate: () => navigate }));
vi.mock('../../src/services/HapticService', () => ({ triggerHaptic: vi.fn() }));
vi.mock('../../src/services/SoundService', () => ({ soundService: { playWin: vi.fn() } }));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('bonus completion presentation', () => {
  it('shows every ledger digit and automatically leaves only when the visible prize reveal completes', () => {
    render(<BonusCompletion clubId="shark-club" chips={12345.67} detail="All Drops Completed." />);
    const popup = screen.getByRole('dialog', { name: '12,345.67 Chips' });
    expect(popup).toHaveTextContent('Your Prize Is Booked.');
    expect(navigate).not.toHaveBeenCalled();
    fireEvent.animationEnd(popup.querySelector('[data-motion="keep"]')!);
    expect(navigate).toHaveBeenCalledExactlyOnceWith('/clubs/shark-club/wheel', { replace: true });
  });
  it('reveals all mines before signaling completion and ignores a child gem animation', () => {
    const onSettled = vi.fn();
    render(
      <MinesGrid
        roundId="round-1"
        picked={[0]}
        mines={[1, 3, 5, 7, 9]}
        phase="cashed"
        busy={false}
        onPick={() => {}}
        onSettled={onSettled}
      />
    );
    expect(screen.getAllByRole('button', { name: /, Mine$/ })).toHaveLength(5);
    fireEvent.animationEnd(
      screen.getByRole('button', { name: 'Tile 1, Gem' }).querySelector('svg')!
    );
    expect(onSettled).not.toHaveBeenCalled();
    fireEvent.animationEnd(screen.getByLabelText('Diamond Mines Board'));
    expect(onSettled).toHaveBeenCalledTimes(1);
  });
});
