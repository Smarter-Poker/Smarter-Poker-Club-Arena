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
  // Don't render when it's the player's turn (they should use main action buttons)
  if (isMyTurn) {
    return null;
  }

  const handleToggle = (action: PreActionType) => {
    // If clicking the same action, deselect it
    if (preAction === action) {
      onPreActionChange(null);
    } else {
      onPreActionChange(action);
    }
  };

  // Bible V8 §4.15: auto_check_fold — "check if possible, otherwise fold"
  const foldLabel = canCheck ? 'Check/Fold' : 'Fold';

  // Phase 2 T1-08: spec §5.3 — "You can also SLIDE between them (swipe gesture
  // to switch selection)". The active button list is computed dynamically
  // because the middle slot swaps between Check / Call <amount> based on
  // whether a bet is pending. Swipe distance >= 40px steps to the adjacent
  // toggle in the rendered order; left = next, right = previous.
  const swipeStartX = useRef<number | null>(null);
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

  return (
    <div
      className="pre-action-bar"
      onPointerDown={onPointerDown}
      onPointerUp={onPointerUp}
      onPointerCancel={() => (swipeStartX.current = null)}
    >
      <div className="pre-action-buttons">
        {/* Bible V8 §4.15: auto_fold / auto_check_fold */}
        <button
          className={`pre-action-btn fold ${preAction === 'fold' ? 'active' : ''}`}
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
            className={`pre-action-btn check ${preAction === 'check' ? 'active' : ''}`}
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
            className={`pre-action-btn call ${preAction === 'call' ? 'active' : ''}`}
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
          className={`pre-action-btn call-any ${preAction === 'callAny' ? 'active' : ''}`}
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
