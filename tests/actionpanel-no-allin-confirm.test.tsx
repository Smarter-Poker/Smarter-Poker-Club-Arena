/**
 * Dan 2026-08-19, bug list item 12:
 *   "do NOT add a confirm-all-in button - accept the action."
 *
 * The panel used to render a full-screen CONFIRM ALL-IN / Cancel step, gated
 * on a `confirmAllIn` setting that DEFAULTED TO TRUE - so every player got the
 * extra tap. These tests pin the behaviour Dan asked for: the tap is the
 * action. `confirmAllIn` is still accepted as a prop (callers and stored user
 * settings still pass it) and must be ignored, including when it is true.
 *
 * There are two ways to shove, and both are covered:
 *   - the main panel's ALL IN button, shown when hero cannot raise;
 *   - the bet-sizing panel's ALL IN button.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import ActionPanel from '../src/components/table/ActionPanel';

const baseProps = {
  canFold: true,
  canCheck: false,
  canCall: true,
  canAllIn: true,
  // 2026-08-23: `currentBet` added. Every fixture here sets callAmount > 0 —
  // there IS a bet to face — but left currentBet at its 0 default, which made
  // the panel call hero's wager an opening BET. Dan reported the inverse of
  // that bug on a real table ("when you aren't facing a bet, and enter an
  // amount, it's a bet, not a raise"), and the fixture was simply incomplete:
  // a hand with something to call always has a live currentBet.
  currentBet: 10,
  callAmount: 10,
  minRaise: 20,
  maxRaise: 500,
  pot: 40,
  bigBlind: 2,
  isMyTurn: true,
};

describe('ActionPanel - main panel ALL IN', () => {
  it('fires on the first tap, even with confirmAllIn explicitly true', () => {
    const onAction = vi.fn();
    render(<ActionPanel {...baseProps} canRaise={false} confirmAllIn onAction={onAction} />);
    fireEvent.click(screen.getByLabelText('All In'));
    expect(onAction).toHaveBeenCalledTimes(1);
    expect(onAction.mock.calls[0][0]).toBe('allin');
  });

  it('never renders a confirmation step', () => {
    const onAction = vi.fn();
    render(<ActionPanel {...baseProps} canRaise={false} confirmAllIn onAction={onAction} />);
    fireEvent.click(screen.getByLabelText('All In'));
    expect(screen.queryByText(/CONFIRM ALL-IN/i)).toBeNull();
    expect(screen.queryByLabelText(/Confirm All In/i)).toBeNull();
    expect(screen.queryByLabelText(/Cancel All In/i)).toBeNull();
  });

  it('sends the real all-in amount, not the pot cap', () => {
    // PLO shape: maxRaise is the pot cap (120), allInTo is the stack (500).
    const onAction = vi.fn();
    render(
      <ActionPanel
        {...baseProps}
        canRaise={false}
        maxRaise={120}
        allInTo={500}
        confirmAllIn
        onAction={onAction}
      />
    );
    fireEvent.click(screen.getByLabelText('All In'));
    expect(onAction).toHaveBeenCalledWith('allin', 500);
  });
});

describe('ActionPanel - bet-sizing panel ALL IN', () => {
  it('fires on the first tap, even with confirmAllIn explicitly true', () => {
    const onAction = vi.fn();
    render(<ActionPanel {...baseProps} canRaise confirmAllIn onAction={onAction} />);
    fireEvent.click(screen.getByLabelText('Open Raise Panel'));
    // 2026-08-20: the label now carries the amount ("Bet All In For 500"),
    // because in pot-limit the shove and the pot cap are different numbers and
    // a screen reader was told neither. Match on the prefix.
    fireEvent.click(screen.getByLabelText(/^Bet All In/));
    expect(onAction).toHaveBeenCalledTimes(1);
    expect(onAction.mock.calls[0][0]).toBe('allin');
    expect(screen.queryByText(/CONFIRM ALL-IN/i)).toBeNull();
  });
});
