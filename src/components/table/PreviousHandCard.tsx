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

import React from 'react';
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

  /**
   * Dan 2026-08-21 (bug list item 4): "previous hand still does not click and
   * expand to review the previous hand(s)."
   *
   * It didn't, and the reason was here: tapping the card opened a two-button
   * popover, and the button that actually opened the breakdown was labelled
   * "Replay". So the tap that was supposed to expand the hand produced a tiny
   * menu instead, and the obvious-looking button in it went somewhere else.
   *
   * The card is now what it looks like: one tap opens the hand breakdown
   * (HandDetailModal, which pages through every hand of the session). Share
   * keeps its own small button on the card, so it needs no menu either.
   */
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
        {/* Two overlapping playing cards, monochrome outline — the glyph Dan
            pointed at for the HUD tile language (2026-08-25 round 2, item 6c).
            The rear card used to carry a translucent black fill so it could sit
            on top of the front one; the tile's own ground does that job now, so
            the glyph is pure stroke and matches the time-bank clock's weight. */}
        <div className="prev-hand-card__icon">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <rect
              x="1.4"
              y="2.4"
              width="8.6"
              height="11.2"
              rx="1.5"
              stroke="currentColor"
              strokeWidth="1.3"
            />
            <rect
              x="5.6"
              y="2.4"
              width="8.6"
              height="11.2"
              rx="1.5"
              stroke="currentColor"
              strokeWidth="1.3"
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
        {onShareHand && (
          <button
            type="button"
            className="prev-hand-card__share"
            aria-label="Share this hand"
            title="Share this hand"
            onClick={(e) => {
              e.stopPropagation();
              onShareHand();
            }}
          >
            <svg width="13" height="13" viewBox="0 0 14 14" fill="none">
              <path
                d="M4 8l3-3 3 3M7 5v7M2 11h10"
                stroke="currentColor"
                strokeWidth="1.3"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        )}
      </div>
    </div>
  );
}

export default PreviousHandCard;
