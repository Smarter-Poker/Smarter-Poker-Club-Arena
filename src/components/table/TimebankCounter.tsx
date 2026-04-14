/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  TIMEBANK COUNTER — Spec §5.7 Always-Visible Timebank Balance
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Bottom-left corner widget showing the player's remaining time-bank charges.
 * Visible throughout gameplay so the user always knows their balance. Diamond
 * icon flags the charges as a purchasable resource (Diamond Store integration
 * handled by the existing TimeBank modal's "Buy More" flow).
 *
 * Pure presentational: the parent passes `count` and `onClick` (optional). The
 * existing control-strip timebank button remains — this widget is additive,
 * per spec "Always visible during gameplay".
 */

import React from 'react';
import './TimebankCounter.css';

interface TimebankCounterProps {
  count: number;
  onClick?: () => void;
  /** Optional: when true, widget renders in "low" state (pulsing warning). */
  low?: boolean;
}

export const TimebankCounter: React.FC<TimebankCounterProps> = ({ count, onClick, low }) => {
  return (
    <button
      type="button"
      className={`tbc-widget${low ? ' tbc-widget--low' : ''}`}
      onClick={onClick}
      aria-label={`Time banks remaining: ${count}`}
      title={`${count} time bank${count === 1 ? '' : 's'} remaining`}
    >
      {/* Clock glyph */}
      <span className="tbc-clock" aria-hidden="true">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
          <circle cx="8" cy="8" r="6.5" stroke="currentColor" strokeWidth="1.5" />
          <path d="M8 4.5V8l2.5 1.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      </span>
      <span className="tbc-count">{count}</span>
      {/* Diamond glyph — flags the resource as purchasable per spec. */}
      <span className="tbc-diamond" aria-hidden="true">
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
          <path d="M5 0l5 5-5 5-5-5z" fill="currentColor" />
        </svg>
      </span>
    </button>
  );
};

export default TimebankCounter;
