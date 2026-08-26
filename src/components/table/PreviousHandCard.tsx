/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  PREVIOUS HAND CARD — Bottom-Left HUD Widget
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Compact card showing the result of the last completed hand.
 * Turned into a pure icon button to match the time bank and chat buttons.
 */

import React from 'react';
import './PreviousHandCard.css';

export interface PreviousHandCardProps {
  handNumber: number | null;
  result: number;
  didWin: boolean;
  didFold: boolean;
  handDescription?: string;
  onTap?: () => void;
  onShareHand?: () => void;
}

export function PreviousHandCard({ handNumber, onTap }: PreviousHandCardProps) {
  // Don't show if no hand has been played yet
  if (handNumber == null) return null;

  return (
    <div className="prev-hand-card-wrapper">
      <div
        className="prev-hand-card"
        onClick={() => onTap?.()}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onTap?.();
          }
        }}
        role="button"
        tabIndex={0}
        aria-label={`Previous hand #${handNumber} - open hand history`}
        title="Open hand history"
      >
        <div className="prev-hand-card__icon">
          {/* Three overlapping cards with a spade on the top card, matching the user reference */}
          <svg
            width="24"
            height="24"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            {/* Back card */}
            <path d="M6 8l-2 1v11l2-1" />
            <path d="M6 8l8-4 2 1" />
            {/* Middle card */}
            <path d="M10 7l-2 1v11l2-1" />
            <path d="M10 7l8-4 2 1" />
            {/* Front card */}
            <rect x="11" y="5" width="9" height="13" rx="1.5" />
            {/* Spade symbol */}
            <path
              d="M15.5 10c-.8 0-1.5.8-1.5 1.7 0 1.2 1.5 2.8 1.5 3.8.1-1 1.5-2.6 1.5-3.8 0-.9-.7-1.7-1.5-1.7z"
              fill="currentColor"
              stroke="none"
            />
            <path d="M15.5 14.5v1.5h-1" stroke="currentColor" />
          </svg>
        </div>
      </div>
    </div>
  );
}

export default PreviousHandCard;
