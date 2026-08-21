/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  HAND-FOR-HAND BANNER — Bubble mode visual indicator
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import React from 'react';
import './HandForHandBanner.css';

interface HandForHandBannerProps {
  playersRemaining: number;
  paidPositions: number;
  active: boolean;
  bubbleBurst?: boolean;
}

export const HandForHandBanner: React.FC<HandForHandBannerProps> = ({
  playersRemaining,
  paidPositions,
  active,
  bubbleBurst = false,
}) => {
  if (!active && !bubbleBurst) return null;

  if (bubbleBurst) {
    return (
      <div className="hfh-banner hfh-burst">
        <div className="hfh-burst-content">
          <span className="hfh-burst-icon">▲</span>
          <span className="hfh-burst-text">BUBBLE BURST!</span>
          <span className="hfh-burst-sub">{playersRemaining} Players Are Now In The Money!</span>
        </div>
      </div>
    );
  }

  return (
    <div className="hfh-banner">
      <div className="hfh-pulse" />
      <div className="hfh-content">
        <div className="hfh-label">
          <span className="hfh-icon">◆</span>
          <span className="hfh-text">HAND FOR HAND</span>
          <span className="hfh-icon">◆</span>
        </div>
        <div className="hfh-info">
          <span className="hfh-players">{playersRemaining} Players Remaining</span>
          <span className="hfh-separator">•</span>
          <span className="hfh-money">{paidPositions} Paid Positions</span>
        </div>
        <div className="hfh-bubble-text">THE MONEY BUBBLE</div>
      </div>
    </div>
  );
};

export default HandForHandBanner;
