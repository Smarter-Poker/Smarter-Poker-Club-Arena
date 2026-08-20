/**
 * ♠ CLUB ARENA — Pre-Action Bar Component
 * Allows players to queue actions before it's their turn
 */

import { useRef, useCallback } from 'react';
import './PreActionBar.css';

// Phase 2 T1-08: spec §5.3 calls for a circular dot ABOVE the label that
// fills when the toggle is active. Replaces the inline check character.
type PreActionType = 'fold' | 'check' | 'call' | 'callAny';
const ToggleDot = ({ active }: { active: boolean }) => (
  <span className={`pre-action-btn__dot${active ? ' pre-action-btn__dot--on' : ''}`} aria-hidden />
);

/** FIX 185: Bible V8 §4.15 — Added 'call' (auto_call) distinct from 'callAny' (auto_call_any) */
interface PreActionBarProps {
  canCheck: boolean;
  isMyTurn: boolean;
  preAction: 'fold' | 'check' | 'call' | 'callAny' | null;
  onPreActionChange: (action: 'fold' | 'check' | 'call' | 'callAny' | null) => void;
  /** Current bet amount to display on the Call button */
  currentBet?: number;
}

export default function PreActionBar({
  canCheck,
  isMyTurn,
  preAction,
  onPreActionChange,
  currentBet = 0,
}: PreActionBarProps) {
  // ── Hooks MUST be called unconditionally (React rules-of-hooks) ──────────
  const swipeStartX = useRef<number | null>(null);
  const suppressNextClickRef = useRef(false);

  // Phase 2 T1-08: spec §5.3 — "You can also SLIDE between them (swipe gesture
  // to switch selection)". The active button list is computed dynamically
  // because the middle slot swaps between Check / Call <amount> based on
  // whether a bet is pending. Swipe distance >= 40px steps to the adjacent
  // toggle in the rendered order; left = next, right = previous.
  const visibleOrder: PreActionType[] = canCheck
    ? ['fold', 'check', 'callAny']
    : currentBet > 0
      ? ['fold', 'call', 'callAny']
      : ['fold', 'callAny'];

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    // Mouse drag is fine, but ignore secondary buttons / touch-pen contexts.
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    swipeStartX.current = e.clientX;
  }, []);

  const onPointerUp = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const startX = swipeStartX.current;
      swipeStartX.current = null;
      if (startX === null) return;
      const dx = e.clientX - startX;
      if (Math.abs(dx) < 40) return; // tap, not swipe — let the button click fire
      // A swipe that begins and ends on the SAME button still produces a
      // click, so the gesture would both step the selection and toggle the
      // button under the finger. Suppress that one click.
      suppressNextClickRef.current = true;
      window.setTimeout(() => {
        suppressNextClickRef.current = false;
      }, 0);
      const currentIdx = preAction ? visibleOrder.indexOf(preAction) : -1;
      // Swipe left (negative dx) → step right in the row; swipe right → step left.
      const direction = dx < 0 ? 1 : -1;
      let nextIdx: number;
      if (currentIdx === -1) {
        // No selection yet — start at left edge for swipe-left, right edge for swipe-right.
        nextIdx = direction > 0 ? 0 : visibleOrder.length - 1;
      } else {
        nextIdx = currentIdx + direction;
        if (nextIdx < 0 || nextIdx >= visibleOrder.length) return; // edge stop
      }
      onPreActionChange(visibleOrder[nextIdx]);
    },
    [preAction, visibleOrder, onPreActionChange]
  );

  // Don't render when it's the player's turn (they should use main action buttons)
  if (isMyTurn) {
    return null;
  }

  const handleToggle = (action: PreActionType) => {
    if (suppressNextClickRef.current) return; // this click is the tail of a swipe
    // If clicking the same action, deselect it
    if (preAction === action) {
      onPreActionChange(null);
    } else {
      onPreActionChange(action);
    }
  };

  // Bible V8 §4.15: auto_check_fold — "check if possible, otherwise fold"
  const foldLabel = canCheck ? 'Check/Fold' : 'Fold';

  // Dan 2026-04-17 (BUG 024): players complained the bar gave no clear
  // visual feedback that a pre-action was armed — the button color shift
  // alone was too subtle. Show an "ARMED" header strip above the buttons
  // whenever preAction !== null. The strip uses the same accent color as
  // the selected button and pulses to draw the eye.
  const armedLabel: string | null =
    preAction === 'fold'
      ? canCheck
        ? 'Auto check / fold'
        : 'Auto fold'
      : preAction === 'check'
        ? 'Auto check'
        : preAction === 'call'
          ? `Auto call ${currentBet > 0 ? currentBet.toLocaleString() : ''}`.trim()
          : preAction === 'callAny'
            ? 'Auto call any'
            : null;

  return (
    <div
      className={`pre-action-bar${preAction ? ' pre-action-bar--armed' : ''}`}
      data-armed={preAction || undefined}
      onPointerDown={onPointerDown}
      onPointerUp={onPointerUp}
      onPointerCancel={() => (swipeStartX.current = null)}
    >
      {armedLabel && (
        <div className="pre-action-bar__armed-strip" aria-live="polite">
          <span className="pre-action-bar__armed-dot" aria-hidden="true" />
          <span className="pre-action-bar__armed-label">{armedLabel}</span>
          <button
            type="button"
            className="pre-action-bar__armed-clear"
            onClick={() => onPreActionChange(null)}
            aria-label="Clear pre-action"
          >
            Cancel
          </button>
        </div>
      )}
      <div className="pre-action-buttons">
        {/* Bible V8 §4.15: auto_fold / auto_check_fold */}
        <button
          type="button"
          className={`pre-action-btn fold ${preAction === 'fold' ? 'active' : ''}`}
          aria-pressed={preAction === 'fold'}
          onClick={() => handleToggle('fold')}
          title={
            canCheck ? 'Check if possible, fold if forced to act' : 'Fold when action reaches you'
          }
        >
          <ToggleDot active={preAction === 'fold'} />
          <span className="pre-action-btn__label">{foldLabel}</span>
        </button>

        {/* Bible V8 §4.15: auto_check */}
        {canCheck && (
          <button
            type="button"
            className={`pre-action-btn check ${preAction === 'check' ? 'active' : ''}`}
            aria-pressed={preAction === 'check'}
            onClick={() => handleToggle('check')}
            title="Check when action reaches you"
          >
            <ToggleDot active={preAction === 'check'} />
            <span className="pre-action-btn__label">Check</span>
          </button>
        )}

        {/* FIX 185: Bible V8 §4.15: auto_call — call current bet (distinct from call any) */}
        {!canCheck && currentBet > 0 && (
          <button
            type="button"
            className={`pre-action-btn call ${preAction === 'call' ? 'active' : ''}`}
            aria-pressed={preAction === 'call'}
            onClick={() => handleToggle('call')}
            title={`Call ${currentBet} when action reaches you`}
          >
            <ToggleDot active={preAction === 'call'} />
            <span className="pre-action-btn__label">
              Call {currentBet > 0 ? currentBet.toLocaleString() : ''}
            </span>
          </button>
        )}

        {/* Bible V8 §4.15: auto_call_any — call any bet including subsequent raises */}
        <button
          type="button"
          className={`pre-action-btn call-any ${preAction === 'callAny' ? 'active' : ''}`}
          aria-pressed={preAction === 'callAny'}
          onClick={() => handleToggle('callAny')}
          title="Call any bet when action reaches you"
        >
          <ToggleDot active={preAction === 'callAny'} />
          <span className="pre-action-btn__label">Call Any</span>
        </button>
      </div>
    </div>
  );
}

export { PreActionBar };
