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
import { useButtonImage } from '../../hooks/useButtonImage';

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
  const prevHandIcon = useButtonImage('icon-prevhand');
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
        aria-label={`Previous Hand #${handNumber} - Open Hand History`}
        title="Open Hand History"
      >
        <div className="prev-hand-card__icon">
          {/* Custom playing-cards icon image */}
          <img src={prevHandIcon} className="prev-hand-card__icon-img" alt="" draggable={false} />
        </div>
      </div>
    </div>
  );
}

export default PreviousHandCard;
