/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  TABLE BOTTOM CHROME — three defects found in the 2026-08-25 audit
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Each of these had an implementation at both ends and a broken wire in the
 * middle, which is precisely the shape that survives a code read.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import ActionPanel from '../src/components/table/ActionPanel';
import PreActionBar from '../src/components/table/PreActionBar';
import { ActionErrorToast } from '../src/components/table/ActionErrorToast';

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

describe('the three action buttons stay on the bottom while the sizing overlay is open', () => {
  /**
   * Dan 2026-08-25, item 5: "these 3 action buttons should be on the bottom,
   * and if you click Raise, the action slider and other buttons pop open and
   * can overlay the Hero and other things when clicked to open."
   *
   * The JSX had been reverted to `{!isRaiseMode && <div className="action-row">}`
   * — raise mode replaced the whole panel again — while the stylesheet, the
   * close branch in handleRaiseClick, the `action-btn--on` held-down state, the
   * `aria-expanded` and the whole premise of `--sp-bottom-row-h` were all still
   * written for a row that stays. Five dead things, one live conditional.
   */
  it('still shows Fold and Call once the sizing overlay is open', () => {
    render(<ActionPanel {...panelBase} onAction={vi.fn()} />);
    fireEvent.click(screen.getByLabelText('Open raise panel'));

    // The overlay is up …
    expect(screen.getByLabelText('Raise amount')).toBeTruthy();
    // … and the pinned row is still under it.
    expect(screen.getByLabelText('Fold')).toBeTruthy();
    expect(screen.getByLabelText(/^Call /)).toBeTruthy();
  });

  it('makes the raise button a toggle that closes the overlay again', () => {
    render(<ActionPanel {...panelBase} onAction={vi.fn()} />);
    fireEvent.click(screen.getByLabelText('Open raise panel'));

    const closer = screen.getByLabelText('Close raise panel');
    expect(closer.getAttribute('aria-expanded')).toBe('true');

    fireEvent.click(closer);
    expect(screen.queryByLabelText('Raise amount')).toBeNull();
    expect(screen.getByLabelText('Open raise panel').getAttribute('aria-expanded')).toBe('false');
  });

  it('lets a player fold straight out of the sizing overlay', () => {
    const onAction = vi.fn();
    render(<ActionPanel {...panelBase} onAction={onAction} />);
    fireEvent.click(screen.getByLabelText('Open raise panel'));
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
