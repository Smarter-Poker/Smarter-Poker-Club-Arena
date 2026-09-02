/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  TABLE BOTTOM CHROME — three defects found in the 2026-08-25 audit
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Each of these had an implementation at both ends and a broken wire in the
 * middle, which is precisely the shape that survives a code read.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { render, screen, fireEvent, act } from '@testing-library/react';
import ActionPanel from '../src/components/table/ActionPanel';
import PreActionBar from '../src/components/table/PreActionBar';
import { ActionErrorToast } from '../src/components/table/ActionErrorToast';

/** Comment-stripped, so a rule quoted in prose cannot satisfy an assertion. */
const ACTION_CSS = readFileSync(
  resolve(__dirname, '../src/components/table/ActionPanel.css'),
  'utf8'
).replace(/\/\*[\s\S]*?\*\//g, '');

// ─────────────────────────────────────────────────────────────────────────────

const panelBase = {
  canFold: true,
  canCheck: false,
  canCall: true,
  canRaise: true,
  canAllIn: true,
  callAmount: 24,
  currentBet: 24,
  minRaise: 48,
  maxRaise: 200,
  allInTo: 200,
  pot: 60,
  bigBlind: 2,
  smallBlind: 1,
  isMyTurn: true,
};

describe('the three action buttons keep their DOM contract while the overlay is open', () => {
  /**
   * ─── WHY THIS SUITE HAS BEEN REWRITTEN TWICE ───────────────────────────────
   * Three instructions, in order, each of which changed what "the row" does:
   *
   *  2026-08-25 item 5 — "these 3 action buttons should be on the bottom, and
   *    if you click Raise, the action slider and other buttons pop open and can
   *    overlay the Hero." This suite was written for that: the row stays,
   *    VISIBLE and TAPPABLE, under the overlay. The JSX had meanwhile been
   *    reverted to `{!isRaiseMode && <div className="action-row">}` while the
   *    stylesheet, the close branch in handleRaiseClick, the `action-btn--on`
   *    held-down state, `aria-expanded` and the whole premise of
   *    `--sp-bottom-row-h` were all still written for a row that stays.
   *
   *  2026-08-26 (commit 6a33a7afb7) — "the 3 buttons on the bottom of the
   *    action tab need to DISAPPEAR when you click Raise." The row was hidden
   *    with `visibility: hidden; pointer-events: none`. THIS SUITE WAS NOT
   *    UPDATED, and from that commit onward its third case — "lets a player
   *    fold straight out of the sizing overlay" — was a FALSE GREEN: it passed
   *    because happy-dom does not apply the stylesheet, while in a browser
   *    `pointer-events: none` had made that tap impossible.
   *
   *  2026-08-27 — "the action tab should be attached to the footer, that large
   *    dark padding should never be there (below raise button)." A
   *    `visibility: hidden` box keeps every pixel of its height, so the row Dan
   *    had asked to disappear was still holding 46px of dead black under the
   *    confirm button. It is `display: none` now.
   *
   * WHAT SURVIVES, AND WHY IT IS NOT WEAKER. The 2026-08-25 assertions were
   * really about one thing: the row must stay MOUNTED, because five separate
   * mechanisms read it. That is still true and still pinned below — the fix
   * collapses a box, it does not unmount a component. What is dropped is the
   * one assertion that stopped being true a day after it was written, and it is
   * replaced by the behaviour that took its place: Back is the way out, and the
   * row is live again the moment the overlay closes.
   */
  it('keeps Fold and Call mounted once the sizing overlay is open', () => {
    render(<ActionPanel {...panelBase} onAction={vi.fn()} />);
    fireEvent.click(screen.getByLabelText('Open Raise Panel'));

    // The overlay is up …
    expect(screen.getByLabelText('Raise Amount')).toBeTruthy();
    // … and the row is still in the DOM under it, which is what
    // `aria-expanded`, `action-btn--on` and `--sp-bottom-row-h` all rely on.
    expect(screen.getByLabelText('Fold')).toBeTruthy();
    expect(screen.getByLabelText(/^Call /)).toBeTruthy();
  });

  it('gives that mounted row no height and no taps', () => {
    // The half a render cannot see. Asserted against the stylesheet, because
    // happy-dom lays nothing out — and it is exactly the blind spot that let
    // the old "fold from the overlay" case pass for a day after it stopped
    // being true.
    const at = ACTION_CSS.indexOf('.action-panel--raise .action-row {');
    expect(at).toBeGreaterThan(-1);
    const block = ACTION_CSS.slice(at, ACTION_CSS.indexOf('}', at));
    expect(block).toMatch(/display:\s*none/);
    expect(block).not.toMatch(/visibility/);
  });

  it('makes the raise button a toggle that closes the overlay again', () => {
    render(<ActionPanel {...panelBase} onAction={vi.fn()} />);
    fireEvent.click(screen.getByLabelText('Open Raise Panel'));

    const closer = screen.getByLabelText('Close Raise Panel');
    expect(closer.getAttribute('aria-expanded')).toBe('true');

    fireEvent.click(closer);
    expect(screen.queryByLabelText('Raise Amount')).toBeNull();
    expect(screen.getByLabelText('Open Raise Panel').getAttribute('aria-expanded')).toBe('false');
  });

  it('lets a player fold the moment they step back out of the overlay', () => {
    // The successor to "fold straight out of the sizing overlay". Folding from
    // UNDER the overlay has not been possible since 2026-08-26; Back is the
    // documented way out, and the row has to be live again on the other side
    // of it or the player is trapped in the sizing panel on a shot clock.
    const onAction = vi.fn();
    render(<ActionPanel {...panelBase} onAction={onAction} />);
    fireEvent.click(screen.getByLabelText('Open Raise Panel'));
    fireEvent.click(screen.getByLabelText('Back'));
    fireEvent.click(screen.getByLabelText('Fold'));
    expect(onAction).toHaveBeenCalledWith('fold');
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('a pre-action whose toggle disappears is disarmed, not stranded', () => {
  /**
   * Arm "Check" in the big blind, then somebody raises. `canCheck` goes false
   * and the Check toggle unmounts — but `preAction` stayed 'check', the engine
   * stayed armed, and the "AUTO FOLD / Cancel" strip that used to be the escape
   * hatch was deliberately removed on 2026-08-21. The player was left holding a
   * pre-action they could neither see nor cancel.
   */
  it('clears an armed Check the moment checking stops being free', () => {
    const onPreActionChange = vi.fn();
    const { rerender } = render(
      <PreActionBar
        canCheck
        isMyTurn={false}
        preAction="check"
        onPreActionChange={onPreActionChange}
        currentBet={0}
      />
    );
    expect(onPreActionChange).not.toHaveBeenCalled();

    rerender(
      <PreActionBar
        canCheck={false}
        isMyTurn={false}
        preAction="check"
        onPreActionChange={onPreActionChange}
        currentBet={24}
      />
    );
    expect(onPreActionChange).toHaveBeenCalledWith(null);
  });

  it('clears an armed Call when there is no longer a bet to call', () => {
    const onPreActionChange = vi.fn();
    const { rerender } = render(
      <PreActionBar
        canCheck={false}
        isMyTurn={false}
        preAction="call"
        onPreActionChange={onPreActionChange}
        currentBet={24}
      />
    );
    expect(onPreActionChange).not.toHaveBeenCalled();

    rerender(
      <PreActionBar
        canCheck={false}
        isMyTurn={false}
        preAction="call"
        onPreActionChange={onPreActionChange}
        currentBet={0}
      />
    );
    expect(onPreActionChange).toHaveBeenCalledWith(null);
  });

  /**
   * Dan 2026-08-28 (CRITICAL, verbatim): "I was in the small blind and
   * clicked the Call 15 button (NOT the Call Any button), it auto called a
   * raise which was more than the 15. THAT CAN NEVER EVER EVER HAPPEN."
   * The engine now refuses it server-side; this is the client half — the
   * armed toggle disarms on screen the moment the price rises.
   */
  it('clears an armed Call the moment the price RISES (a raise arrived)', () => {
    const onPreActionChange = vi.fn();
    const { rerender } = render(
      <PreActionBar
        canCheck={false}
        isMyTurn={false}
        preAction="call"
        onPreActionChange={onPreActionChange}
        currentBet={15}
      />
    );
    expect(onPreActionChange).not.toHaveBeenCalled();

    rerender(
      <PreActionBar
        canCheck={false}
        isMyTurn={false}
        preAction="call"
        onPreActionChange={onPreActionChange}
        currentBet={65}
      />
    );
    expect(onPreActionChange).toHaveBeenCalledWith(null);
  });

  it('an armed Call survives an unchanged price', () => {
    const onPreActionChange = vi.fn();
    const { rerender } = render(
      <PreActionBar
        canCheck={false}
        isMyTurn={false}
        preAction="call"
        onPreActionChange={onPreActionChange}
        currentBet={15}
      />
    );
    rerender(
      <PreActionBar
        canCheck={false}
        isMyTurn={false}
        preAction="call"
        onPreActionChange={onPreActionChange}
        currentBet={15}
      />
    );
    expect(onPreActionChange).not.toHaveBeenCalled();
  });

  it('leaves Fold and Call Any alone — they are on the bar in every state', () => {
    const onPreActionChange = vi.fn();
    const { rerender } = render(
      <PreActionBar
        canCheck
        isMyTurn={false}
        preAction="callAny"
        onPreActionChange={onPreActionChange}
        currentBet={0}
      />
    );
    rerender(
      <PreActionBar
        canCheck={false}
        isMyTurn={false}
        preAction="callAny"
        onPreActionChange={onPreActionChange}
        currentBet={24}
      />
    );
    expect(onPreActionChange).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('the action-error toast clears itself', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  /**
   * The 4-second timeout depended on `onClear`, and TablePage passes an inline
   * arrow — a new identity on every render of a component that re-renders on
   * every snapshot. The effect tore its own timer down and restarted it forever,
   * so the toast sat over the middle of the felt covering the board until the
   * player found the small x on it.
   */
  it('fires after four seconds even when the parent re-renders constantly', () => {
    const onClear = vi.fn();
    /* `errorData` is hoisted so its IDENTITY is stable across the re-renders
       below — which is exactly how TablePage passes it (`errorData={actionErrorData}`,
       a piece of state). Identity is the right dependency for it: a second
       refusal is a new object and SHOULD restart the four seconds.
       `onClear` is the one that was wrong, and it is left inline here on
       purpose, because inline is how the real call site writes it. */
    const errorData = { error: 'raise below minimum' };
    const { rerender } = render(
      <ActionErrorToast errorData={errorData} onClear={() => onClear()} />
    );

    // Twenty parent renders inside the four seconds, each with a fresh callback
    // identity — exactly what a live table does.
    for (let i = 0; i < 20; i += 1) {
      act(() => void vi.advanceTimersByTime(100));
      rerender(<ActionErrorToast errorData={errorData} onClear={() => onClear()} />);
    }
    expect(onClear).not.toHaveBeenCalled();

    act(() => void vi.advanceTimersByTime(2100));
    expect(onClear).toHaveBeenCalledTimes(1);
  });

  it('renders the engine message under the house popup rule', () => {
    // Dan 2026-08-20, binding: First Letter Of Every Word Capitalized, and no
    // em dashes. The engine writes ordinary sentence case, so this was the one
    // popup at the table that did not look like the others.
    render(
      <ActionErrorToast
        errorData={{ error: 'raise below minimum — try again' }}
        onClear={vi.fn()}
      />
    );
    const msg = screen.getByRole('alert').textContent || '';
    expect(msg).toContain('Raise Below Minimum. Try Again');
    expect(msg).not.toContain('—');
  });

  it('formats the suggested amount rather than printing a raw number', () => {
    render(
      <ActionErrorToast
        errorData={{
          error: 'raise below minimum',
          hint: { suggestedAction: 'raise', suggestedAmount: 12500 },
        }}
        onClear={vi.fn()}
        onApplyHint={vi.fn()}
      />
    );
    expect(screen.getByRole('button', { name: /Snap To/i }).textContent).toContain(
      (12500).toLocaleString()
    );
  });
});
