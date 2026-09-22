/**
 * THE DIAMONDS THREE-CARD GAME (owner ruling 2026-09-21, R15).
 *
 * Dan: "If 'Diamonds' is won it plays a game where 3 cards pop up: one is 50%
 * of diamonds risked, one is 2x, one is 3x. After the user selects a card it
 * awards that prize and reveals all 3 prizes behind the cards."
 *
 * What this pins, one per line of that sentence and one per way it could go
 * wrong in a hand a player actually plays:
 *
 *   - three cards, face down, with nothing on them to read;
 *   - ONE pick out of a double tap, because a second call is a second RPC and
 *     the player would watch a card turn over twice;
 *   - all three turned over afterwards, the picked one named as the pick;
 *   - the paid diamonds printed as the server sent them;
 *   - a refusal shown in the server's own words, with the cards back face down
 *     so the player can pick again;
 *   - the keyboard plays the game (R15 is a popup, not a pointer gesture);
 *   - and, with the clock under control, two minutes of nothing: no card is
 *     picked for the player and nothing closes itself (R1).
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DiamondCardPick } from '../../src/components/wheel/DiamondCardPick';
import type { WheelCardPick } from '../../src/services/DiamondWheelService';

vi.mock('../../src/components/common/Modal', () => ({
  Modal: ({ children }: { children: React.ReactNode }) => <div role="dialog">{children}</div>,
}));
vi.mock('../../src/components/console/SpadeConsole', () => ({
  SpadeConsole: ({ children, title }: { children: React.ReactNode; title: string }) => (
    <div>
      <h2>{title}</h2>
      {children}
    </div>
  ),
}));
vi.mock('../../src/utils/animationSpeed', () => ({ getAnimationSpeed: () => 1 }));
vi.mock('../../src/services/SoundService', () => ({ soundService: { playWin: vi.fn() } }));
vi.mock('../../src/services/HapticService', () => ({ triggerHaptic: vi.fn() }));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: vi.fn() }));

const AWARD = {
  id: 'd1000000-0000-4000-8000-0000000000c1',
  spin_id: 'd1000000-0000-4000-8000-0000000000c2',
  risk_diamonds: 100,
};
/** Card 2 is the triple here, so a pick is never confused with a position. */
const PAID: WheelCardPick = {
  ok: true,
  award_id: AWARD.id,
  picked: 2,
  cards: [200, 300, 50],
  paid_diamonds: 300,
  balances: { diamonds: 1300 },
};

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const open = (onPick: (awardId: string, card: number) => Promise<WheelCardPick>) => {
  const onClose = vi.fn();
  render(<DiamondCardPick award={AWARD} onPick={onPick} onClose={onClose} />);
  return onClose;
};

describe('the diamonds card game', () => {
  it('opens on three face-down cards that give nothing away', () => {
    open(vi.fn());
    const cards = ['Card One', 'Card Two', 'Card Three'].map((name) =>
      screen.getByRole('button', { name })
    );
    expect(cards).toHaveLength(3);
    for (const card of cards) {
      expect(card).toBeEnabled();
      expect(card).not.toHaveAttribute('data-revealed');
    }
    expect(screen.getByText('Tap A Card. Nothing Is Picked For You.')).toBeInTheDocument();
    // Nothing on screen names a value before a card is turned over.
    expect(screen.queryByText(/200|300|50 Diamonds/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Continue' })).toBeNull();
  });

  it('picks once on a double tap, then turns all three over and pays what the server paid', async () => {
    const onPick = vi.fn().mockResolvedValue(PAID);
    open(onPick);
    const second = screen.getByRole('button', { name: 'Card Two' });
    fireEvent.click(second);
    fireEvent.click(second);
    fireEvent.click(screen.getByRole('button', { name: 'Card Three' }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('You Won 300'));
    expect(onPick).toHaveBeenCalledTimes(1);
    expect(onPick).toHaveBeenCalledWith(AWARD.id, 2);
    // Every card is face up, each named by what it hid, the pick named as one.
    expect(screen.getByRole('button', { name: 'Card One, 2x, 200 Diamonds' })).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Card Two, 3x, 300 Diamonds, Your Pick' })
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Card Three, Half, 50 Diamonds' })
    ).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('You Won 300 Diamonds');
    for (const name of ['Card One', 'Card Two', 'Card Three']) {
      const card = screen.getByRole('button', { name: new RegExp(`^${name},`) });
      expect(card).toHaveAttribute('data-revealed');
      expect(card).toBeDisabled();
    }
  });

  it('reveals the pick the server recorded when the same award is picked again', async () => {
    const onPick = vi.fn().mockResolvedValue(PAID);
    open(onPick);
    fireEvent.click(screen.getByRole('button', { name: 'Card One' }));
    await waitFor(() => expect(screen.getByRole('status')).toBeInTheDocument());
    // The award was already picked: card two is the pick, and it paid 300.
    expect(onPick).toHaveBeenCalledWith(AWARD.id, 1);
    expect(
      screen.getByRole('button', { name: 'Card Two, 3x, 300 Diamonds, Your Pick' })
    ).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('You Won 300 Diamonds');
  });

  it('shows the server reason for a refusal and lets the player pick again', async () => {
    const onPick = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        error: 'This Card Pick Is Not Yours',
        award_id: AWARD.id,
        picked: 0,
        cards: [],
        paid_diamonds: 0,
        balances: { diamonds: 0 },
      })
      .mockResolvedValueOnce(PAID);
    open(onPick);
    fireEvent.click(screen.getByRole('button', { name: 'Card One' }));
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('This Card Pick Is Not Yours')
    );
    for (const name of ['Card One', 'Card Two', 'Card Three'])
      expect(screen.getByRole('button', { name })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Card Three' }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('You Won 300'));
    expect(onPick).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('says so and lets the player pick again when the pick could not be sent at all', async () => {
    const onPick = vi.fn().mockRejectedValueOnce(new Error('network')).mockResolvedValue(PAID);
    open(onPick);
    fireEvent.click(screen.getByRole('button', { name: 'Card Two' }));
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(
        'The Card Pick Could Not Be Confirmed. Try Again.'
      )
    );
    fireEvent.click(screen.getByRole('button', { name: 'Card Two' }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('You Won 300'));
    expect(onPick).toHaveBeenCalledTimes(2);
  });

  it('is played with a keyboard: every card is a button and Continue closes it', async () => {
    const onPick = vi.fn().mockResolvedValue(PAID);
    const onClose = open(onPick);
    const card = screen.getByRole('button', { name: 'Card Three' });
    card.focus();
    expect(card).toHaveFocus();
    // happy-dom turns Enter and Space on a focused button into a click, as a
    // browser does; the point of the pin is that the card IS a button.
    fireEvent.click(card);
    await waitFor(() => expect(screen.getByRole('status')).toBeInTheDocument());
    expect(onPick).toHaveBeenCalledWith(AWARD.id, 3);
    const cont = screen.getByRole('button', { name: 'Continue' });
    cont.focus();
    fireEvent.click(cont);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('picks nothing and closes nothing through two minutes of clock', async () => {
    const onPick = vi.fn().mockResolvedValue(PAID);
    const onClose = open(onPick);
    vi.useFakeTimers();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_000);
    });
    expect(onPick).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Card One' })).toBeEnabled();
    // And after a pick the Continue plate waits just as long.
    vi.useRealTimers();
    fireEvent.click(screen.getByRole('button', { name: 'Card One' }));
    await waitFor(() => expect(screen.getByRole('status')).toBeInTheDocument());
    vi.useFakeTimers();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_000);
    });
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Continue' })).toBeInTheDocument();
  });
});
