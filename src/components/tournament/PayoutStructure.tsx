/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  TOURNAMENT PAYOUT STRUCTURE — Display Prize Distribution
 *  Enhanced with animated amounts, progress indicator, and player status
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import React, { useState, useEffect } from 'react';
import { formatChips } from '../../utils/format';
import './PayoutStructure.css';

interface PayoutStructureProps {
  totalPrize: number;
  entries: number;
  playersRemaining: number;
  payouts: PayoutSlot[];
  currency?: string;
  currentUserPosition?: number;
  mounted?: boolean;
}

export interface PayoutSlot {
  position: number | string;
  percentage: number;
  amount: number;
  isGuaranteed?: boolean;
}

export function PayoutStructure({
  totalPrize,
  entries,
  playersRemaining = 0,
  payouts,
  currency = '',
  currentUserPosition,
  mounted: initialMounted = false,
}: PayoutStructureProps) {
  const [mounted, setMounted] = useState(initialMounted);

  useEffect(() => {
    if (!initialMounted) {
      // BUG FIX (mount-timer): track timer so it cancels on unmount — prevents stale setState
      const _mountTimer = setTimeout(() => setMounted(true), 50);
      return () => clearTimeout(_mountTimer);
    }
  }, [initialMounted]);

  const paidPlaces = payouts.length;
  const inTheMoney = entries > 0 ? Math.trunc((paidPlaces / entries) * 1000) / 10 : 0;
  const playersUntilMoney = Math.max(0, entries - paidPlaces - (entries - playersRemaining));
  const isInTheMoney = playersRemaining <= paidPlaces;
  const isOnBubble = playersRemaining === paidPlaces + 1;

  return (
    <div
      className="payout-structure"
      style={{
        opacity: mounted ? 1 : 0,
        transform: mounted ? 'translateY(0)' : 'translateY(12px)',
        transition: 'all 0.5s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
        transitionDelay: '0.15s',
      }}
    >
      {/* Header */}
      <div className="payout-structure__header">
        <div className="prize-info">
          <span className="total-prize">
            {currency ? `${currency} ` : ''}
            {formatChips(totalPrize)}
          </span>
          <span className="label">Prize Pool</span>
        </div>
        <div className="entries-info">
          <span className="entries">{entries}</span>
          <span className="label">Entries</span>
        </div>
        <div className="itm-info">
          <span className="itm">{paidPlaces}</span>
          <span className="label">Paid ({inTheMoney}%)</span>
        </div>
      </div>

      {/* Money Progress Indicator */}
      <div className="payout-progress">
        <div className="payout-progress-track">
          <div
            className="payout-progress-fill"
            style={{
              width: `${Math.max(0, Math.min(100, ((entries - playersRemaining) / paidPlaces) * 100))}%`,
            }}
          />
        </div>
        <div className="payout-status-badge">
          {isOnBubble && <span className="badge bubble">BUBBLE</span>}
          {isInTheMoney && !isOnBubble && <span className="badge money">IN THE MONEY</span>}
          {!isInTheMoney && !isOnBubble && playersUntilMoney > 0 && (
            <span className="badge remaining">{playersUntilMoney} Players Until Money</span>
          )}
        </div>
      </div>

      {/* Payout Table */}
      <div className="payout-structure__table">
        {payouts.map((payout, idx) => {
          const isUserPosition =
            currentUserPosition === (typeof payout.position === 'number' ? payout.position : null);
          const positionNumber = typeof payout.position === 'number' ? payout.position : null;

          return (
            <div
              key={idx}
              className={`payout-row ${idx === 0 ? 'first' : ''} ${idx === 1 ? 'second' : ''} ${idx === 2 ? 'third' : ''} ${isUserPosition ? 'user-position' : ''}`}
              style={{
                opacity: mounted ? 1 : 0,
                transform: mounted ? 'translateX(0)' : 'translateX(-8px)',
                transition: 'all 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
                transitionDelay: `${0.16 + idx * 0.03}s`,
              }}
            >
              <span className="position">
                {idx === 0 ? '★' : idx === 1 ? '☆' : idx === 2 ? '✧' : ''}
                {typeof payout.position === 'number' ? `#${payout.position}` : payout.position}
              </span>
              <div className="bar-container">
                <div className="bar" style={{ width: `${payout.percentage * 2}%` }} />
              </div>
              <span className="percentage">{Math.trunc(payout.percentage * 10) / 10}%</span>
              <span className="amount">
                {formatChips(payout.amount)}
                {payout.isGuaranteed && <span className="gtd">GTD</span>}
              </span>
              {isUserPosition && <span className="you-badge">You</span>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default PayoutStructure;
