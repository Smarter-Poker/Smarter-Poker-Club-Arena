import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import BonusCompletion, { bonusGameRoute } from '../../src/components/games/BonusCompletion';
import MinesGrid from '../../src/components/games/MinesGrid';
import { soundService } from '../../src/services/SoundService';
import { triggerHaptic } from '../../src/services/HapticService';

const navigate = vi.hoisted(() => vi.fn());
const wheel = vi.hoisted(() => ({ getStateV2: vi.fn() }));
vi.mock('react-router-dom', () => ({ useNavigate: () => navigate }));
vi.mock('../../src/services/HapticService', () => ({ triggerHaptic: vi.fn() }));
vi.mock('../../src/services/SoundService', () => ({
  soundService: { playWin: vi.fn(), playBigWin: vi.fn() },
}));
vi.mock('../../src/services/DiamondWheelService', () => ({ default: wheel }));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: vi.fn() }));
const CLUB = '00000000-0000-0000-0000-000000000003';
const waiting = {
  id: '00000000-0000-0000-0000-000000000088',
  game: 'mines' as const,
  base_diamonds: 100,
  boost_multiplier: 1,
  entry_diamonds: 100,
};
beforeEach(() => {
  wheel.getStateV2.mockReset().mockResolvedValue({ pending_awards: [] });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.useRealTimers();
});
const reveal = (popup: HTMLElement) =>
  fireEvent.animationEnd(popup.querySelector('[data-motion="keep"]')!);

/**
 * GAMES CAN NEVER AUTO START (Dan 2026-09-21, R1). This popup used to leave for
 * the wheel by itself after five seconds, and the wheel's own countdown then
 * spun for the player: a finished game rolled into a paid spin with no tap.
 * Now the receipt stays until the player taps, and every way off it is a tap.
 */
describe('bonus completion presentation', () => {
  it('shows every ledger digit and stays put: no timer returns to the wheel', () => {
    vi.useFakeTimers();
    render(<BonusCompletion clubId="shark-club" chips={12345.67} detail="All Drops Completed." />);
    const popup = screen.getByRole('dialog', { name: '12,345.67 Chips' });
    expect(popup).toHaveTextContent('Your Prize Is Booked.');
    expect(popup).toHaveTextContent('All Drops Completed.');
    expect(within(popup).getByRole('button', { name: 'Back To The Wheel' })).toBeDisabled();
    reveal(popup);
    expect(within(popup).getByRole('button', { name: 'Back To The Wheel' })).toBeEnabled();
    // Two minutes of nothing: still here, still nowhere else.
    act(() => vi.advanceTimersByTime(120_000));
    expect(navigate).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: '12,345.67 Chips' })).toBeInTheDocument();
    expect(popup.querySelector('[data-bonus-step="completed"]')).not.toBeNull();
  });
  it('returns to the wheel on Back To The Wheel, once, and only after the reveal', () => {
    render(<BonusCompletion clubId="shark-club" chips={5} detail="Round Complete." />);
    const popup = screen.getByRole('dialog', { name: '5.00 Chips' });
    const back = within(popup).getByRole('button', { name: 'Back To The Wheel' });
    fireEvent.click(back);
    expect(navigate).not.toHaveBeenCalled();
    reveal(popup);
    fireEvent.click(back);
    fireEvent.click(back);
    expect(navigate).toHaveBeenCalledExactlyOnceWith('/clubs/shark-club/wheel', { replace: true });
  });
  it('offers Play Next Bonus Game when another won game is waiting, and opens that game', async () => {
    wheel.getStateV2.mockResolvedValue({ pending_awards: [waiting] });
    render(
      <BonusCompletion
        clubId="shark-club"
        clubUuid={CLUB}
        awardId="00000000-0000-0000-0000-000000000077"
        chips={0}
        detail="The Flight Crashed At 1.20x."
      />
    );
    await act(async () => {});
    expect(wheel.getStateV2).toHaveBeenCalledExactlyOnceWith(CLUB);
    const popup = screen.getByRole('dialog', { name: '0.00 Chips' });
    expect(popup).toHaveTextContent('No Chips Won This Round.');
    expect(popup).toHaveTextContent('Another Bonus Game Is Waiting For You.');
    reveal(popup);
    expect(within(popup).getByRole('button', { name: 'Back To The Wheel' })).toBeEnabled();
    fireEvent.click(within(popup).getByRole('button', { name: 'Play Next Bonus Game' }));
    expect(navigate).toHaveBeenCalledExactlyOnceWith(
      '/clubs/shark-club/mines?wheelAward=00000000-0000-0000-0000-000000000088',
      { replace: true }
    );
    expect(bonusGameRoute('c', { ...waiting, game: 'plinko' })).toBe(
      `/clubs/c/plinko?wheelAward=${waiting.id}`
    );
  });
  it('never offers the award just settled as the next game, and tolerates a wheel state without the list', async () => {
    wheel.getStateV2.mockResolvedValueOnce({ pending_awards: [{ ...waiting, id: 'same' }] });
    render(
      <BonusCompletion
        clubId="shark-club"
        clubUuid={CLUB}
        awardId="same"
        chips={1}
        detail="Done."
      />
    );
    await act(async () => {});
    expect(screen.queryByRole('button', { name: 'Play Next Bonus Game' })).toBeNull();
    cleanup();
    wheel.getStateV2.mockResolvedValueOnce({});
    render(<BonusCompletion clubId="shark-club" clubUuid={CLUB} chips={1} detail="Done." />);
    await act(async () => {});
    expect(screen.queryByRole('button', { name: 'Play Next Bonus Game' })).toBeNull();
    cleanup();
    wheel.getStateV2.mockRejectedValueOnce(new Error('Offline'));
    render(<BonusCompletion clubId="shark-club" clubUuid={CLUB} chips={1} detail="Done." />);
    await act(async () => {});
    expect(screen.queryByRole('button', { name: 'Play Next Bonus Game' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Back To The Wheel' })).toBeInTheDocument();
  });
  it('does not read the wheel when it has no club to ask about', async () => {
    render(<BonusCompletion clubId="shark-club" chips={1} detail="Done." />);
    await act(async () => {});
    expect(wheel.getStateV2).not.toHaveBeenCalled();
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
