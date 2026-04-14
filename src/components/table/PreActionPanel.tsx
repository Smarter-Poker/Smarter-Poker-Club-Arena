/**
 * CLUB ARENA -- Pre-Action Panel (PokerBros Parity)
 * Toggle buttons for pre-selecting actions before your turn.
 * Shows when seated and it's NOT your turn.
 */

import { useCallback } from 'react';
import { haptic } from '../../services/SoundService';
import './PreActionPanel.css';

type PreAction = 'fold' | 'check_fold' | 'check' | 'call_any' | null;

interface PreActionPanelProps {
  handActive: boolean;
  canPotentiallyCheck: boolean;
  currentBet: number;
  onPreAction: (action: PreAction) => void;
  selectedAction: PreAction;
}

export default function PreActionPanel({
  handActive,
  canPotentiallyCheck,
  currentBet,
  onPreAction,
  selectedAction,
}: PreActionPanelProps) {

  const toggleAction = useCallback((action: PreAction) => {
    haptic.light();
    if (selectedAction === action) {
      onPreAction(null);
    } else {
      onPreAction(action);
    }
  }, [selectedAction, onPreAction]);

  if (!handActive) return null;

  return (
    <div className="pre-action-panel">
      <div className="pre-action-row">
        {/* Fold */}
        <button
          className={`pre-action-btn pre-action-btn--fold ${selectedAction === 'fold' ? 'pre-action-btn--active' : ''}`}
          onClick={() => toggleAction('fold')}
          aria-label="Pre-select fold"
          aria-pressed={selectedAction === 'fold'}
        >
          <span className="pre-action-btn__check" />
          <span className="pre-action-btn__label">Fold</span>
        </button>

        {/* Check/Fold */}
        <button
          className={`pre-action-btn pre-action-btn--check-fold ${selectedAction === 'check_fold' ? 'pre-action-btn--active' : ''}`}
          onClick={() => toggleAction('check_fold')}
          aria-label="Pre-select check or fold"
          aria-pressed={selectedAction === 'check_fold'}
        >
          <span className="pre-action-btn__check" />
          <span className="pre-action-btn__label">Check/Fold</span>
        </button>

        {/* Check -- only when no bet facing */}
        {currentBet === 0 && (
          <button
            className={`pre-action-btn pre-action-btn--check ${selectedAction === 'check' ? 'pre-action-btn--active' : ''}`}
            onClick={() => toggleAction('check')}
            aria-label="Pre-select check"
            aria-pressed={selectedAction === 'check'}
          >
            <span className="pre-action-btn__check" />
            <span className="pre-action-btn__label">Check</span>
          </button>
        )}

        {/* Call Any -- when there is a bet */}
        {currentBet > 0 && (
          <button
            className={`pre-action-btn pre-action-btn--call ${selectedAction === 'call_any' ? 'pre-action-btn--active' : ''}`}
            onClick={() => toggleAction('call_any')}
            aria-label="Pre-select call any"
            aria-pressed={selectedAction === 'call_any'}
          >
            <span className="pre-action-btn__check" />
            <span className="pre-action-btn__label">Call Any</span>
          </button>
        )}
      </div>
    </div>
  );
}

export { PreActionPanel };
export type { PreAction };
