/**
 * ♠ CLUB ARENA — Pre-Action Bar Component
 * Allows players to queue actions before it's their turn
 */

import { useRef, useCallback, useEffect } from 'react';
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

  /**
   * ═══ AN ARMED PRE-ACTION THE PLAYER CANNOT SEE OR CANCEL ═══════════════════
   * AUDIT 2026-08-25.
   *
   * The middle slot is conditional: Check exists only while `canCheck`, and
   * Call exists only while a bet is outstanding. Both of those change DURING a
   * street, and the armed selection did not follow them.
   *
   * Arm "Check" in the big blind with no raisers, then somebody raises. The
   * Check button unmounts. `preAction` is still 'check', so the bar is still in
   * its armed state and the engine is still holding `auto_check` for this hand
   * — but there is no lit toggle on screen, and no button left to tap to turn
   * it off. Dan removed the "AUTO FOLD / Cancel" strip on 2026-08-21 (it read
   * as a standing instruction across hands), which is right, and it means the
   * lit toggle is now the ONLY way to disarm. Take the toggle away and the
   * player is holding a pre-action they can neither see nor cancel.
   *
   * Facing a bet with auto_check armed is also not a thing the engine can
   * honour, so the arm was worthless as well as invisible.
   *
   * Clearing it goes through the parent, which is what tells the ENGINE to
   * clear too — a local-only reset would leave the server still holding it,
   * which is the same trap with the display fixed.
   *
   * The effect runs before the `isMyTurn` early return below on purpose:
   * hooks cannot be conditional, and this is exactly the case where the bar is
   * about to stop rendering.
   */
  /**
   * Dan 2026-08-28 (CRITICAL, companion to the engine guard): the moment the
   * armed 'call' price RISES — a raise arrived — the toggle disarms on
   * screen, immediately, through the parent (which also tells the engine to
   * clear). The engine independently refuses to fire an auto_call past the
   * armed price, so this is the visible half of that guarantee, not the only
   * half. The price at arm time is snapshotted here because `currentBet` is
   * a live prop: comparing it to itself would never trip.
   */
  const armedCallPriceRef = useRef<number | null>(null);
  useEffect(() => {
    if (preAction === 'call') {
      if (armedCallPriceRef.current === null) armedCallPriceRef.current = currentBet;
    } else {
      armedCallPriceRef.current = null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preAction]);

  useEffect(() => {
    if (preAction && !visibleOrder.includes(preAction)) {
      onPreActionChange(null);
    } else if (
      preAction === 'call' &&
      armedCallPriceRef.current !== null &&
      currentBet > armedCallPriceRef.current
    ) {
      // The price went up — the button the player pressed no longer exists.
      onPreActionChange(null);
    }
    // visibleOrder is rebuilt every render; depend on what actually decides it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preAction, canCheck, currentBet]);

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

  /**
   * Dan 2026-08-21 (bug list item 15): the "AUTO FOLD / Cancel" strip is gone.
   *
   * It read as a standing instruction that outlived the hand — players saw
   * "AUTO FOLD" and reasonably believed every future hand would be folded for
   * them. A pre-action only ever applies to the hand in progress, so the armed
   * state now shows exactly where the player set it: the lit toggle itself
   * (filled dot, accent border), which clears the moment the hand ends.
   * Tapping the lit toggle again disarms it — the old Cancel button's job.
   *
   * Do not reintroduce the strip.
   */

  return (
    <div
      className={`pre-action-bar${preAction ? ' pre-action-bar--armed' : ''}`}
      data-armed={preAction || undefined}
      onPointerDown={onPointerDown}
      onPointerUp={onPointerUp}
      onPointerCancel={() => (swipeStartX.current = null)}
    >
      <div className="pre-action-buttons">
        {/* Bible V8 §4.15: auto_fold / auto_check_fold */}
        <button
          type="button"
          className={`pre-action-btn fold ${preAction === 'fold' ? 'active' : ''}`}
          aria-pressed={preAction === 'fold'}
          onClick={() => handleToggle('fold')}
          title={
            canCheck ? 'Check If Possible, Fold If Forced To Act' : 'Fold When Action Reaches You'
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
            title="Check When Action Reaches You"
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
            /* House rule 5: never print a raw number. This tooltip was the one
               place on the bar that did - a 12,500 call read "Call 12500". */
            title={`Call ${currentBet.toLocaleString()} When Action Reaches You`}
          >
            <ToggleDot active={preAction === 'call'} />
            {/* The branch is already inside `currentBet > 0`; the second test
                that used to be here could never be false. */}
            <span className="pre-action-btn__label">Call {currentBet.toLocaleString()}</span>
          </button>
        )}

        {/* Bible V8 §4.15: auto_call_any — call any bet including subsequent raises */}
        <button
          type="button"
          className={`pre-action-btn call-any ${preAction === 'callAny' ? 'active' : ''}`}
          aria-pressed={preAction === 'callAny'}
          onClick={() => handleToggle('callAny')}
          title="Call Any Bet When Action Reaches You"
        >
          <ToggleDot active={preAction === 'callAny'} />
          <span className="pre-action-btn__label">Call Any</span>
        </button>
      </div>
    </div>
  );
}

export { PreActionBar };
