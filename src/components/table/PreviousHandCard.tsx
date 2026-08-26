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

/**
 * AUDIT 2026-08-25 — FIVE OF THESE SEVEN PROPS ARE ACCEPTED AND IGNORED.
 *
 * The widget was a summary card once; it is a single icon button now, and the
 * rewrite left the old props on the interface. TablePage still computes and
 * passes every one of them.
 *
 * Four of them are only wasted work. `onShareHand` is not: TablePage passes a
 * real handler that toasts when there is no captured hand and otherwise opens
 * the share modal, and NOTHING in here ever calls it. It was a feature with an
 * implementation at both ends and no connection in the middle.
 *
 * It is not re-wired here, because there is nowhere honest to put it: the card
 * is one icon whose one tap opens the hand history, and inventing a long-press
 * would be inventing UX nobody asked for. Sharing is already reachable from the
 * table menu (TablePage.tsx also calls `setShowShareHand(true)` from there), so
 * nothing is actually lost — the dead wire is. Delete the five props from the
 * `<PreviousHandCard>` call site and they can come off this interface too.
 */
export interface PreviousHandCardProps {
  handNumber: number | null;
  /** @deprecated Accepted and ignored — the card shows an icon, not a result. */
  result?: number;
  /** @deprecated Accepted and ignored. */
  didWin?: boolean;
  /** @deprecated Accepted and ignored. */
  didFold?: boolean;
  /** @deprecated Accepted and ignored. */
  handDescription?: string;
  onTap?: () => void;
  /** @deprecated Accepted and ignored. Share is reachable from the table menu. */
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
