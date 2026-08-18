/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  TIME BANK DISPLAY — Shows Remaining Time Bank with VIP Limits
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import React from 'react';
import { VIP_GOLD_LIMITS, FEATURE_PRICING } from '../../services/VIPService';
import './TimeBankDisplay.css';

interface TimeBankDisplayProps {
  remainingSeconds: number;
  isVIP: boolean;
  isActive: boolean;
  onBuyMore?: () => void;
}

export function TimeBankDisplay({
  remainingSeconds,
  isVIP,
  isActive,
  onBuyMore,
}: TimeBankDisplayProps) {
  // 2026-08-18: a session's pool is the free 30s base PLUS the VIP monthly
  // quota (engine fn_time_bank_allowance) - capping at the quota alone made
  // a fresh VIP session (150s) read as >100% and clamp. Note: this component
  // is currently unmounted (TablePage renders its own indicator); kept
  // correct so wiring it in later doesn't resurrect the wrong scale.
  const maxSeconds = 30 + (isVIP ? VIP_GOLD_LIMITS.timeBankSeconds : 0);
  const percentage = Math.min(100, (remainingSeconds / maxSeconds) * 100);
  const isLow = percentage < 25;

  return (
    <div className={`time-bank ${isActive ? 'active' : ''} ${isLow ? 'low' : ''}`}>
      <div className="time-bank__header">
        <span className="time-bank__icon"></span>
        <span className="time-bank__label">Time Bank</span>
        {isVIP && <span className="time-bank__vip"></span>}
      </div>

      <div className="time-bank__bar">
        <div className="time-bank__fill" style={{ width: `${percentage}%` }} />
      </div>

      <div className="time-bank__info">
        <span className="time-bank__seconds">{remainingSeconds}s</span>
        {!isVIP && remainingSeconds < 10 && onBuyMore && (
          <button className="time-bank__buy" onClick={onBuyMore}>
            +Extension ({FEATURE_PRICING.time_bank_seconds.cost}💎)
          </button>
        )}
      </div>
    </div>
  );
}

export default TimeBankDisplay;
