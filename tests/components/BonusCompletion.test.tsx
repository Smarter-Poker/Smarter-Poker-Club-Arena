import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import BonusCompletion from '../../src/components/games/BonusCompletion';
import MinesGrid from '../../src/components/games/MinesGrid';
import { soundService } from '../../src/services/SoundService';
import { triggerHaptic } from '../../src/services/HapticService';

const navigate = vi.hoisted(() => vi.fn());
vi.mock('react-router-dom', () => ({ useNavigate: () => navigate }));
vi.mock('../../src/services/HapticService', () => ({ triggerHaptic: vi.fn() }));
vi.mock('../../src/services/SoundService', () => ({
  soundService: { playWin: vi.fn(), playBigWin: vi.fn() },
}));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe('bonus completion presentation', () => {
  it('shows every ledger digit for five seconds instead of leaving at animation end', () => {
    vi.useFakeTimers();
    render(<BonusCompletion clubId="shark-club" chips={12345.67} detail="All Drops Completed." />);
    const popup = screen.getByRole('dialog', { name: '12,345.67 Chips' });
    expect(popup).toHaveTextContent('Your Prize Is Booked.');
    expect(navigate).not.toHaveBeenCalled();
    fireEvent.animationEnd(popup.querySelector('[data-motion="keep"]')!);
    expect(navigate).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(4999));
    expect(navigate).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));
    expect(navigate).toHaveBeenCalledExactlyOnceWith('/clubs/shark-club/wheel', { replace: true });
  });
  it('allows an earlier dismissal and never returns twice when its timer expires', () => {
    vi.useFakeTimers();
    render(<BonusCompletion clubId="shark-club" chips={5} detail="Round Complete." />);
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(navigate).toHaveBeenCalledExactlyOnceWith('/clubs/shark-club/wheel', { replace: true });
    act(() => vi.advanceTimersByTime(5000));
    expect(navigate).toHaveBeenCalledTimes(1);
  });
  it('counts only visible time so a hidden result is still readable when the player returns', () => {
    vi.useFakeTimers();
    const visibility = vi.spyOn(document, 'visibilityState', 'get');
    visibility.mockReturnValue('visible');
    render(<BonusCompletion clubId="shark-club" chips={5} detail="Round Complete." />);
    act(() => vi.advanceTimersByTime(2000));
    visibility.mockReturnValue('hidden');
    fireEvent(document, new Event('visibilitychange'));
    act(() => vi.advanceTimersByTime(6000));
    expect(navigate).not.toHaveBeenCalled();
    visibility.mockReturnValue('visible');
    fireEvent(document, new Event('visibilitychange'));
    act(() => vi.advanceTimersByTime(2999));
    expect(navigate).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));
    expect(navigate).toHaveBeenCalledTimes(1);
    visibility.mockRestore();
  });
  it('carries what the round was onto the receipt, and heads a win the usual way', () => {
    const { unmount } = render(
      <BonusCompletion
        clubId="shark-club"
        chips={0.1}
        detail="Hit At Street 3."
        eyebrow="Guarantee Paid"
      />
    );
    expect(screen.getByRole('dialog', { name: '0.10 Chips' })).toHaveTextContent('Guarantee Paid');
    expect(screen.queryByText('You Won')).toBeNull();
    unmount();
    render(<BonusCompletion clubId="shark-club" chips={5} detail="Round Complete." />);
    expect(screen.getByRole('dialog', { name: '5.00 Chips' })).toHaveTextContent('You Won');
  });
  it('passes the page request for silence through to the receipt', () => {
    render(<BonusCompletion clubId="shark-club" chips={0.1} detail="Hit At Street 3." silent />);
    expect(soundService.playWin).not.toHaveBeenCalled();
    expect(triggerHaptic).not.toHaveBeenCalled();
    cleanup();
    render(<BonusCompletion clubId="shark-club" chips={5} detail="Round Complete." />);
    expect(soundService.playWin).toHaveBeenCalledTimes(1);
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
