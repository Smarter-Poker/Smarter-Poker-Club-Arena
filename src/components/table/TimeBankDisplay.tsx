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
  // A session's pool is the free base PLUS the VIP monthly quota (engine
  // fn_time_bank_allowance) - capping at the quota alone made a fresh VIP
  // session read as >100% and clamp. Note: this component is currently
  // unmounted (TablePage renders its own indicator); kept correct so wiring it
  // in later doesn't resurrect the wrong scale.
  //
  // FREE_BASE_SECONDS must track ServerTableEngineBase.timeBankBaseSeconds.
  // It went 30 -> 40 on 2026-08-18 when a time bank became a 20-second grant
  // (Bible V8 s6.2), so the free allowance is exactly two whole banks. Left at
  // 30 the bar would read 133% full on a fresh non-VIP session.
  const FREE_BASE_SECONDS = 40;
  const maxSeconds = FREE_BASE_SECONDS + (isVIP ? VIP_GOLD_LIMITS.timeBankSeconds : 0);
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
            +Extension ({FEATURE_PRICING.time_bank_seconds.cost})
          </button>
        )}
      </div>
    </div>
  );
}

export default TimeBankDisplay;
