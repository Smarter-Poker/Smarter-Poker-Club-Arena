/**
 * Dan 2026-08-23, with a screenshot of the sizing panel reading "RAISE 24" on a
 * street nobody had bet into:
 *
 *   "when you aren't facing a bet, and enter an amount, it's a bet, not a raise"
 *
 * The MAIN action bar already switched between the two words. The BET-SIZING
 * PANEL — the screen you are actually looking at while you choose the number —
 * hardcoded "Raise", on the confirm button, the presets and the slider.
 *
 * The predicate is `currentBet`, the highest wager on the CURRENT street, not
 * `callAmount`. They come apart in exactly one place and it is a place that
 * happens every orbit: the big blind preflop with no raisers has callAmount 0
 * and currentBet = the blind. Putting in more there is a RAISE, because the
 * blind is already a bet. Keying off callAmount — which the main bar used to do
 * — calls that a bet, which is the same error pointing the other way.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import ActionPanel from '../src/components/table/ActionPanel';

const base = {
  canFold: true,
  canCheck: false,
  canCall: true,
  canRaise: true,
  canAllIn: true,
  minRaise: 20,
  maxRaise: 200,
  pot: 30,
  bigBlind: 2,
  isMyTurn: true,
};

/** Nobody has bet this street: first in, postflop. */
const unopened = { ...base, currentBet: 0, callAmount: 0, canCheck: true, canCall: false };
/** Someone bet and hero is facing it. */
const facingBet = { ...base, currentBet: 24, callAmount: 24 };
/** Big blind preflop, no raisers: nothing to call, but the blind IS a bet. */
const bigBlindOption = { ...base, currentBet: 2, callAmount: 0, canCheck: true, canCall: false };

const openPanel = () => {
  const opener =
    screen.queryByLabelText('Open Bet Panel') ?? screen.getByLabelText('Open Raise Panel');
  fireEvent.click(opener);
};

describe('an unfaced wager is a bet, never a raise', () => {
  it('calls it Bet on the main bar when nobody has bet the street', () => {
    render(<ActionPanel {...unopened} onAction={vi.fn()} />);
    expect(screen.getByLabelText('Open Bet Panel').textContent).toContain('Bet');
    expect(screen.queryByLabelText('Open Raise Panel')).toBeNull();
  });

  it('calls it Bet on the confirm button inside the sizing panel', () => {
    render(<ActionPanel {...unopened} onAction={vi.fn()} />);
    openPanel();
    const confirm = screen.getByRole('button', { name: /^Bet \d/i });
    expect(confirm.textContent).toMatch(/^Bet /);
    // The word that was on screen in Dan's screenshot must not be anywhere.
    expect(screen.queryByText(/^Raise /i)).toBeNull();
  });

  it('still calls it Raise when there is a bet to face', () => {
    render(<ActionPanel {...facingBet} onAction={vi.fn()} />);
    openPanel();
    expect(screen.getByRole('button', { name: /^Raise \d/i })).toBeTruthy();
  });

  it('calls the big blind option a Raise, even with nothing to call', () => {
    // callAmount is 0 here. Anything that keys off callAmount gets this wrong.
    render(<ActionPanel {...bigBlindOption} onAction={vi.fn()} />);
    expect(screen.getByLabelText('Open Raise Panel')).toBeTruthy();
    openPanel();
    expect(screen.getByRole('button', { name: /^Raise \d/i })).toBeTruthy();
  });

  it('sends the same wire action either way — this is a label, not a protocol', () => {
    const onAction = vi.fn();
    render(<ActionPanel {...unopened} onAction={onAction} />);
    openPanel();
    fireEvent.click(screen.getByRole('button', { name: /^Bet \d/i }));
    expect(onAction.mock.calls[0][0]).toBe('raise');
  });
});
