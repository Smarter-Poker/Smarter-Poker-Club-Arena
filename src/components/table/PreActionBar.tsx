/**
 * ♠ CLUB ARENA — Pre-Action Bar Component
 * Allows players to queue actions before it's their turn
 */

import { useState } from 'react';
import './PreActionBar.css';

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

  const handleToggle = (action: 'fold' | 'check' | 'call' | 'callAny') => {
    // If clicking the same action, deselect it
    if (preAction === action) {
      onPreActionChange(null);
    } else {
      onPreActionChange(action);
    }
  };

  // Bible V8 §4.15: auto_check_fold — "check if possible, otherwise fold"
  const foldLabel = canCheck ? 'Check/Fold' : 'Fold';

  return (
    <div className="pre-action-bar">
      <div className="pre-action-buttons">
        {/* Bible V8 §4.15: auto_fold / auto_check_fold */}
        <button
          className={`pre-action-btn fold ${preAction === 'fold' ? 'active' : ''}`}
          onClick={() => handleToggle('fold')}
          title={
            canCheck ? 'Check if possible, fold if forced to act' : 'Fold when action reaches you'
          }
        >
          <span className="pre-action-btn__check">{preAction === 'fold' ? '✓' : ''}</span>
          {foldLabel}
        </button>

        {/* Bible V8 §4.15: auto_check */}
        {canCheck && (
          <button
            className={`pre-action-btn check ${preAction === 'check' ? 'active' : ''}`}
            onClick={() => handleToggle('check')}
            title="Check when action reaches you"
          >
            <span className="pre-action-btn__check">{preAction === 'check' ? '✓' : ''}</span>
            Check
          </button>
        )}

        {/* FIX 185: Bible V8 §4.15: auto_call — call current bet (distinct from call any) */}
        {!canCheck && currentBet > 0 && (
          <button
            className={`pre-action-btn call ${preAction === 'call' ? 'active' : ''}`}
            onClick={() => handleToggle('call')}
            title={`Call ${currentBet} when action reaches you`}
          >
            <span className="pre-action-btn__check">{preAction === 'call' ? '✓' : ''}</span>
            Call {currentBet > 0 ? currentBet.toLocaleString() : ''}
          </button>
        )}

        {/* Bible V8 §4.15: auto_call_any — call any bet including subsequent raises */}
        <button
          className={`pre-action-btn call-any ${preAction === 'callAny' ? 'active' : ''}`}
          onClick={() => handleToggle('callAny')}
          title="Call any bet when action reaches you"
        >
          <span className="pre-action-btn__check">{preAction === 'callAny' ? '✓' : ''}</span>
          Call Any
        </button>
      </div>
    </div>
  );
}

export { PreActionBar };
