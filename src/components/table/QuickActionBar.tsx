/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  QUICK ACTION BAR — Fast-Access Table Actions
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import React from 'react';
import './QuickActionBar.css';

interface QuickActionBarProps {
  onShowCards?: () => void;
  onMuckCards?: () => void;
  onBuyIn?: () => void;
  onSitOut?: () => void;
  onSettings?: () => void;
  onLeave?: () => void;
  isSittingOut?: boolean;
  showMuck?: boolean;
  showReveal?: boolean;
}

export function QuickActionBar({
  onShowCards,
  onMuckCards,
  onBuyIn,
  onSitOut,
  onSettings,
  onLeave,
  isSittingOut = false,
  showMuck = false,
  showReveal = false,
}: QuickActionBarProps) {
  return (
    <div className="quick-action-bar">
      {showReveal && onShowCards && (
        <button className="quick-action show" onClick={onShowCards}>
          Show
        </button>
      )}

      {showMuck && onMuckCards && (
        <button className="quick-action muck" onClick={onMuckCards}>
          Muck
        </button>
      )}

      {onBuyIn && (
        <button className="quick-action buyin" onClick={onBuyIn}>
          Add Chips
        </button>
      )}

      {onSitOut && (
        <button
          className={`quick-action sitout ${isSittingOut ? 'active' : ''}`}
          onClick={onSitOut}
        >
          {isSittingOut ? '🪑 Sit In' : '🚶 Sit Out'}
        </button>
      )}

      {onSettings && (
        <button
          className="quick-action settings"
          onClick={onSettings}
          aria-label="Settings"
        ></button>
      )}

      {onLeave && (
        <button className="quick-action leave" onClick={onLeave} aria-label="Leave table"></button>
      )}
    </div>
  );
}

export default QuickActionBar;
