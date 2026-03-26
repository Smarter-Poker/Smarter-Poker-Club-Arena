/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  PREVIOUS HAND CARD — Bottom-Left HUD Widget
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Compact card showing the result of the last completed hand:
 *   - Hand number
 *   - Win/Loss result + amount
 *   - Quick tap to open full hand history/replay
 *
 * Transparent glass design matching the other HUD corners.
 */

import React, { useState } from 'react';
import './PreviousHandCard.css';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface PreviousHandCardProps {
  /** Hand number of the last completed hand */
  handNumber: number | null;
  /** Result amount from last hand (positive = won, negative = lost, 0 = folded) */
  result: number;
  /** Whether hero won the last hand */
  didWin: boolean;
  /** Whether hero folded (no showdown) */
  didFold: boolean;
  /** Best hand description (e.g. "Two Pair, Aces and Kings") */
  handDescription?: string;
  /** Tap handler — opens full hand history */
  onTap?: () => void;
  /** Share hand handler — opens share hand modal */
  onShareHand?: () => void;
}

// ═══════════════════════════════════════════════════════════════════════════════
// COMPONENT
// ═══════════════════════════════════════════════════════════════════════════════

export function PreviousHandCard({
  handNumber,
  result,
  didWin,
  didFold,
  handDescription,
  onTap,
  onShareHand,
}: PreviousHandCardProps) {
  const [showActions, setShowActions] = useState(false);

  // Don't show if no hand has been played yet
  if (handNumber == null) return null;

  const resultColor = didWin
    ? 'var(--success, #31A24C)'
    : result < 0
      ? 'var(--danger, #F02849)'
      : 'var(--soft-white, #B0B3B8)';

  const resultText = didFold
    ? 'Folded'
    : didWin
      ? `+${result.toLocaleString()}`
      : result === 0
        ? 'Push'
        : result.toLocaleString();

  const handleClick = () => {
    setShowActions((prev) => !prev);
  };

  return (
    <div className="prev-hand-card-wrapper">
      <div
        className="prev-hand-card"
        onClick={handleClick}
        role="button"
        tabIndex={0}
        aria-label={`Previous hand #${handNumber}`}
      >
        <div className="prev-hand-card__icon">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <rect
              x="1"
              y="2"
              width="10"
              height="12"
              rx="1.5"
              stroke="currentColor"
              strokeWidth="1.2"
            />
            <rect
              x="5"
              y="2"
              width="10"
              height="12"
              rx="1.5"
              stroke="currentColor"
              strokeWidth="1.2"
              fill="rgba(0,0,0,0.3)"
            />
          </svg>
        </div>
        <div className="prev-hand-card__info">
          <span className="prev-hand-card__hand">#{handNumber}</span>
          <span className="prev-hand-card__result" style={{ color: resultColor }}>
            {resultText}
          </span>
        </div>
        {handDescription && <span className="prev-hand-card__desc">{handDescription}</span>}
      </div>

      {/* Action buttons — shown on tap */}
      {showActions && (
        <div className="prev-hand-card__actions">
          <button
            className="prev-hand-card__action-btn"
            onClick={(e) => {
              e.stopPropagation();
              onTap?.();
              setShowActions(false);
            }}
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              <path
                d="M2 3h10M2 5.5h6M2 8h8M2 10.5h4"
                stroke="currentColor"
                strokeWidth="1.2"
                strokeLinecap="round"
              />
            </svg>
            Replay
          </button>
          <button
            className="prev-hand-card__action-btn"
            onClick={(e) => {
              e.stopPropagation();
              onShareHand?.();
              setShowActions(false);
            }}
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              <path
                d="M4 8l3-3 3 3M7 5v7M2 11h10"
                stroke="currentColor"
                strokeWidth="1.2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            Share
          </button>
        </div>
      )}
    </div>
  );
}

export default PreviousHandCard;
