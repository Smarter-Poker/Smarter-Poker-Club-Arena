/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  TIME BANK — Extra Time Component
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Visual indicator and trigger for Time Bank:
 * - Shows available time banks
 * - Progress bar / Countdown
 * - Activation button
 * - Extension purchase button (VIP/diamonds)
 */

import React from 'react';
import './TimeBank.css';

export interface TimeBankProps {
  isVisible: boolean;
  isActive: boolean;
  banksRemaining: number;
  totalTime: number; // total seconds provided by one bank
  timeRemaining?: number; // current countdown if active
  onActivate: () => void;
  onBuyMore?: () => void; // VIP/diamond extension purchase
  diamondCost?: number; // cost per extension (default: 5)
  autoActivate?: boolean;
}

export function TimeBank({
  isVisible,
  isActive,
  banksRemaining,
  totalTime,
  timeRemaining,
  onActivate,
  onBuyMore,
  // Fallback only. TablePage passes the real price from `feature_pricing`,
  // which is the same row fn_purchase_feature charges from. 5 was wrong: a
  // time-bank extension costs 1 diamond.
  diamondCost = 1,
}: TimeBankProps) {
  if (!isVisible && banksRemaining === 0 && !onBuyMore) return null;

  return (
    <div className={`time-bank ${isActive ? 'time-bank--active' : ''}`}>
      {isActive ? (
        <div className="time-bank__active-display">
          <span className="time-bank__icon">◷</span>
          <div className="time-bank__progress">
            <div
              className="time-bank__time-bank__bar"
              style={{ width: `${((timeRemaining || 0) / totalTime) * 100}%` }}
            />
          </div>
          <span className="time-bank__countdown">{timeRemaining}s</span>
        </div>
      ) : banksRemaining > 0 ? (
        <button className="time-bank__trigger" onClick={onActivate}>
          <span className="time-bank__time-bank__label">TIME BANK</span>
          <div className="time-bank__chips">
            {Array.from({ length: Math.min(5, banksRemaining) }).map((_, i) => (
              <div key={i} className="time-bank__chip" />
            ))}
            {banksRemaining > 5 && <span className="time-bank__count">+{banksRemaining - 5}</span>}
          </div>
        </button>
      ) : onBuyMore ? (
        <button className="time-bank__trigger time-bank__buy-ext" onClick={onBuyMore}>
          <span className="time-bank__time-bank__label">+EXTENSION</span>
          <span className="time-bank__diamond-cost">{diamondCost} </span>
        </button>
      ) : null}
    </div>
  );
}

export default TimeBank;
