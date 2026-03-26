/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  MINI STATS CARD — Upper-Right HUD Widget
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Compact card showing the hero's real-time session stats:
 *   - P&L (profit/loss with color coding)
 *   - VPIP percentage
 *   - Buy-in total
 *   - Hands played
 *
 * Taps to expand into full SessionHUD modal.
 * Transparent glass design to not obstruct the table.
 */

import React, { useState } from 'react';
import './MiniStatsCard.css';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface MiniStatsObserver {
  id: string;
  name: string;
  avatar?: string;
}

export interface MiniStatsCardProps {
  /** Current hero stack */
  currentStack: number;
  /** Total chips bought in (sum of all buy-ins/rebuys) */
  totalBuyIn: number;
  /** Hands played this session */
  handsPlayed: number;
  /** VPIP count (hands voluntarily put money in) */
  vpipCount: number;
  /** Hands won this session */
  handsWon: number;
  /** Whether the hero is seated */
  isSeated: boolean;
  /** Tap handler — opens full session stats modal */
  onTap?: () => void;
  /** Observers watching the table */
  observers?: MiniStatsObserver[];
}

// ═══════════════════════════════════════════════════════════════════════════════
// COMPONENT
// ═══════════════════════════════════════════════════════════════════════════════

export function MiniStatsCard({
  currentStack,
  totalBuyIn,
  handsPlayed,
  vpipCount,
  handsWon,
  isSeated,
  onTap,
  observers = [],
}: MiniStatsCardProps) {
  const [isExpanded, setIsExpanded] = useState(false);

  // Don't show if not seated
  if (!isSeated) return null;

  const pnl = currentStack - totalBuyIn;
  const pnlColor = pnl >= 0 ? 'var(--success, #31A24C)' : 'var(--danger, #F02849)';
  const pnlSign = pnl >= 0 ? '+' : '';
  const vpipPct = handsPlayed > 0 ? Math.round((vpipCount / handsPlayed) * 100) : 0;
  const winRate = handsPlayed > 0 ? Math.round((handsWon / handsPlayed) * 100) : 0;

  const handleClick = () => {
    if (onTap) {
      onTap();
    } else {
      setIsExpanded((prev) => !prev);
    }
  };

  return (
    <div
      className={`mini-stats-card ${isExpanded ? 'mini-stats-card--expanded' : ''}`}
      onClick={handleClick}
      role="button"
      tabIndex={0}
      aria-label="Session stats"
    >
      {/* Compact view — always visible */}
      <div className="mini-stats-card__compact">
        <span className="mini-stats-card__pnl" style={{ color: pnlColor }}>
          {pnlSign}
          {pnl.toLocaleString()}
        </span>
        <span className="mini-stats-card__sep">|</span>
        <span className="mini-stats-card__vpip">VPIP {vpipPct}%</span>
      </div>

      {/* Expanded view — additional stats */}
      {isExpanded && (
        <div className="mini-stats-card__details">
          <div className="mini-stats-card__row">
            <span className="mini-stats-card__label">Buy-in</span>
            <span className="mini-stats-card__value">{totalBuyIn.toLocaleString()}</span>
          </div>
          <div className="mini-stats-card__row">
            <span className="mini-stats-card__label">Stack</span>
            <span className="mini-stats-card__value">{currentStack.toLocaleString()}</span>
          </div>
          <div className="mini-stats-card__row">
            <span className="mini-stats-card__label">Hands</span>
            <span className="mini-stats-card__value">{handsPlayed}</span>
          </div>
          <div className="mini-stats-card__row">
            <span className="mini-stats-card__label">Win Rate</span>
            <span className="mini-stats-card__value">{winRate}%</span>
          </div>

          {/* Observers watching the table */}
          {observers.length > 0 && (
            <div className="mini-stats-card__observers">
              <span className="mini-stats-card__observer-icon">◉</span>
              <span className="mini-stats-card__observer-count">{observers.length} watching</span>
            </div>
          )}
          {observers.length > 0 && (
            <div className="mini-stats-card__observer-list">
              {observers.slice(0, 5).map((obs) => (
                <span key={obs.id} className="mini-stats-card__observer-name">
                  {obs.name}
                </span>
              ))}
              {observers.length > 5 && (
                <span className="mini-stats-card__observer-more">+{observers.length - 5} more</span>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default MiniStatsCard;
