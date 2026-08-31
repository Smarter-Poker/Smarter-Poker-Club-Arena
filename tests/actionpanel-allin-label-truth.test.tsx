/**
 * The ALL IN button told a pot-limit player the wrong number.
 *
 * In POT-LIMIT (PLO4/5/6) `maxRaise` is the POT CAP, not the stack. That is why
 * `allInTo` exists as a separate prop, and why handleAllIn was changed in
 * August to dispatch it — with the note that "sending an amount that
 * contradicts the action is a trap for anything that reads it".
 *
 * The LABEL kept the trap. It printed `maxRaise`, so a PLO player holding 300
 * behind at a table whose pot cap is 47 saw "All In 47" on a button that shoves
 * 300. The label is the part the player actually reads.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import ActionPanel from '../src/components/table/ActionPanel';

const potLimit = {
  canFold: true,
  canCheck: false,
  canCall: true,
  canRaise: false, // forces the main-panel ALL IN button to render
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
  maxRaise: 47, // the POT CAP
  allInTo: 300, // hero's actual stack
  pot: 27,
  bigBlind: 2,
  isPotLimit: true,
  isMyTurn: true,
};

describe('ALL IN shows the amount it actually bets', () => {
  it('shows the stack, not the pot cap, in pot-limit', () => {
    render(<ActionPanel {...potLimit} onAction={vi.fn()} />);
    const btn = screen.getByLabelText('All In');
    expect(btn.textContent).toContain('300');
    expect(btn.textContent).not.toContain('47');
  });

  it('sends exactly what it showed', () => {
    const onAction = vi.fn();
    render(<ActionPanel {...potLimit} onAction={onAction} />);
    fireEvent.click(screen.getByLabelText('All In'));
    expect(onAction).toHaveBeenCalledWith('allin', 300);
  });

  it('is unchanged in no-limit, where the cap IS the stack', () => {
    const onAction = vi.fn();
    render(
      <ActionPanel
        {...potLimit}
        isPotLimit={false}
        maxRaise={300}
        allInTo={300}
        onAction={onAction}
      />
    );
    const btn = screen.getByLabelText('All In');
    expect(btn.textContent).toContain('300');
    fireEvent.click(btn);
    expect(onAction).toHaveBeenCalledWith('allin', 300);
  });

  it('falls back to maxRaise when allInTo is not supplied', () => {
    const { allInTo: _drop, ...noAllInTo } = potLimit;
    render(<ActionPanel {...noAllInTo} onAction={vi.fn()} />);
    expect(screen.getByLabelText('All In').textContent).toContain('47');
  });
});

describe('the bet-sizing panel does not offer a shove hero cannot make', () => {
  it('disables ALL IN when canAllIn is false', () => {
    render(
      <ActionPanel
        {...potLimit}
        canRaise
        canAllIn={false}
        maxRaise={120}
        allInTo={120}
        onAction={vi.fn()}
      />
    );
    fireEvent.click(screen.getByLabelText('Open Raise Panel'));
    expect(screen.getByRole('button', { name: /Bet All In/i })).toBeDisabled();
  });

  it('labels the shove with the real all-in amount', () => {
    render(<ActionPanel {...potLimit} canRaise onAction={vi.fn()} />);
    fireEvent.click(screen.getByLabelText('Open Raise Panel'));
    expect(screen.getByRole('button', { name: /Bet All In For 300/i })).toBeInTheDocument();
  });
});
