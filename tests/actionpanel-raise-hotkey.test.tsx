/**
 * The documented raise hotkey has to actually open the raise UI.
 *
 * TablePage advertises F / C / R / A plus 1/2/3/4 pot-fraction keys. R, E and
 * all four preset keys called `setShowRaiseSlider(true)` — state that NO
 * component in the repo rendered. So on hero's turn the key did nothing
 * visible; and because `showRaiseSlider` also fed TablePage's `isModalOpen`,
 * which gates `useTableKeyboard` entirely, the key that appeared to do nothing
 * ALSO silenced F, C and A until the player pressed Escape. Hero could be
 * facing a bet, press the shortcut the UI tells them to press, and lose every
 * shortcut they had.
 *
 * ActionPanel owns the sizing UI, so the hotkeys now arrive here as a
 * `raiseIntent` nonce.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import ActionPanel from '../src/components/table/ActionPanel';

const base = {
  canFold: true,
  canCheck: false,
  canCall: true,
  canRaise: true,
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
  maxRaise: 200,
  pot: 30,
  bigBlind: 2,
  isMyTurn: true,
};

// Raise mode is what puts the confirm control on screen.
const inRaiseMode = () => screen.queryByLabelText(/^Confirm/i) ?? screen.queryByText(/^Raise /i);

describe('raise hotkey opens the raise panel', () => {
  it('does not open on mount just because an intent object exists', () => {
    render(<ActionPanel {...base} onAction={vi.fn()} raiseIntent={{ nonce: 0, open: false }} />);
    expect(document.body.classList.contains('ca-raising')).toBe(false);
  });

  it('opens raise mode when the nonce bumps', () => {
    const { rerender } = render(
      <ActionPanel {...base} onAction={vi.fn()} raiseIntent={{ nonce: 0, open: false }} />
    );
    expect(document.body.classList.contains('ca-raising')).toBe(false);

    rerender(<ActionPanel {...base} onAction={vi.fn()} raiseIntent={{ nonce: 1, open: true }} />);
    expect(document.body.classList.contains('ca-raising')).toBe(true);
    expect(inRaiseMode()).toBeTruthy();
  });

  it('preselects a pot-fraction amount, clamped to the legal range', () => {
    const { rerender } = render(
      <ActionPanel {...base} onAction={vi.fn()} raiseIntent={{ nonce: 0, open: false }} />
    );
    // Half pot of 30 is 15, which is BELOW minRaise 20 — it must clamp up, not
    // offer an amount the server will refuse.
    rerender(
      <ActionPanel
        {...base}
        onAction={vi.fn()}
        raiseIntent={{ nonce: 1, open: true, amount: 15 }}
      />
    );
    expect(screen.getByLabelText(/^Edit Bet Amount 20\b/)).toBeTruthy();
  });

  it('clamps a preset above the maximum down to maxRaise', () => {
    const { rerender } = render(
      <ActionPanel {...base} onAction={vi.fn()} raiseIntent={{ nonce: 0, open: false }} />
    );
    rerender(
      <ActionPanel
        {...base}
        onAction={vi.fn()}
        raiseIntent={{ nonce: 1, open: true, amount: 9999 }}
      />
    );
    expect(screen.getByLabelText(/^Edit Bet Amount 200\b/)).toBeTruthy();
  });

  it('closes raise mode when the parent asks (fold / check / call / Escape)', () => {
    const { rerender } = render(
      <ActionPanel {...base} onAction={vi.fn()} raiseIntent={{ nonce: 0, open: false }} />
    );
    rerender(<ActionPanel {...base} onAction={vi.fn()} raiseIntent={{ nonce: 1, open: true }} />);
    expect(document.body.classList.contains('ca-raising')).toBe(true);

    rerender(<ActionPanel {...base} onAction={vi.fn()} raiseIntent={{ nonce: 2, open: false }} />);
    expect(document.body.classList.contains('ca-raising')).toBe(false);
  });

  it('refuses to open when it is not hero turn', () => {
    const { rerender } = render(
      <ActionPanel
        {...base}
        isMyTurn={false}
        onAction={vi.fn()}
        raiseIntent={{ nonce: 0, open: false }}
      />
    );
    rerender(
      <ActionPanel
        {...base}
        isMyTurn={false}
        onAction={vi.fn()}
        raiseIntent={{ nonce: 1, open: true }}
      />
    );
    expect(document.body.classList.contains('ca-raising')).toBe(false);
  });

  it('refuses to open when raising is not legal', () => {
    const noRaise = { ...base, canRaise: false, canAllIn: false };
    const { rerender } = render(
      <ActionPanel {...noRaise} onAction={vi.fn()} raiseIntent={{ nonce: 0, open: false }} />
    );
    rerender(
      <ActionPanel {...noRaise} onAction={vi.fn()} raiseIntent={{ nonce: 1, open: true }} />
    );
    expect(document.body.classList.contains('ca-raising')).toBe(false);
  });
});
