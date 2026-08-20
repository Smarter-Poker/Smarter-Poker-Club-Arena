/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  TIMEBANK COUNTER — Spec §5.7 Always-Visible Timebank Balance
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Bottom-left corner widget showing the player's remaining time-bank charges.
 *
 * Dan 2026-08-20 (redesign): the old pill was a generic clock glyph + count +
 * pink diamond, which read as a currency balance, not a shot-clock resource.
 * Now it is a golden ALARM CLOCK (bells + legs) with "20s" on its face — the
 * seconds one bank buys (Bible V8 §6.2 / TimeBankEngine secondsPerUse) — and
 * the number of banks remaining beside it. Matches the PokerBros reference.
 *
 * Pure presentational: the parent passes `count` and `onClick` (optional).
 */

import React from 'react';
import './TimebankCounter.css';

interface TimebankCounterProps {
  count: number;
  onClick?: () => void;
  /** Optional: when true, widget renders in "low" state (pulsing warning). */
  low?: boolean;
  /** Seconds one time bank adds to the clock. Engine default is 20. */
  bankSeconds?: number;
}

export const TimebankCounter: React.FC<TimebankCounterProps> = ({
  count,
  onClick,
  low,
  bankSeconds = 20,
}) => {
  return (
    <button
      type="button"
      className={`tbc-widget${low ? ' tbc-widget--low' : ''}`}
      onClick={onClick}
      aria-label={`Time banks remaining: ${count}, ${bankSeconds} seconds each`}
      title={`${count} time bank${count === 1 ? '' : 's'} remaining (${bankSeconds}s each)`}
    >
      {/* Golden alarm clock with the per-bank seconds on its face */}
      <span className="tbc-alarm" aria-hidden="true">
        <svg width="30" height="30" viewBox="0 0 32 32" fill="none">
          {/* Bells */}
          <path
            d="M6.5 5.5 L10.5 2.8 A1.4 1.4 0 0 1 12.3 4.9 L9 7.6 Z"
            fill="var(--tbc-gold-dark, #b8860b)"
          />
          <path
            d="M25.5 5.5 L21.5 2.8 A1.4 1.4 0 0 0 19.7 4.9 L23 7.6 Z"
            fill="var(--tbc-gold-dark, #b8860b)"
          />
          {/* Legs */}
          <path
            d="M8.2 26.5 L6 29.3 M23.8 26.5 L26 29.3"
            stroke="var(--tbc-gold-dark, #b8860b)"
            strokeWidth="2"
            strokeLinecap="round"
          />
          {/* Body */}
          <circle cx="16" cy="17" r="11.2" fill="url(#tbcBody)" />
          <circle
            cx="16"
            cy="17"
            r="11.2"
            stroke="var(--tbc-gold, #f5c542)"
            strokeWidth="2"
          />
          {/* Face */}
          <circle cx="16" cy="17" r="8.6" fill="rgba(10, 12, 18, 0.85)" />
          <text
            x="16"
            y="20.4"
            textAnchor="middle"
            fontSize="8.5"
            fontWeight="800"
            fill="#ffffff"
            fontFamily="inherit"
          >
            {bankSeconds}s
          </text>
          <defs>
            <radialGradient id="tbcBody" cx="0.35" cy="0.3" r="0.9">
              <stop offset="0%" stopColor="#ffe9a8" />
              <stop offset="55%" stopColor="#f5c542" />
              <stop offset="100%" stopColor="#b8860b" />
            </radialGradient>
          </defs>
        </svg>
      </span>
      <span className="tbc-count">{count}</span>
    </button>
  );
};

export default TimebankCounter;
