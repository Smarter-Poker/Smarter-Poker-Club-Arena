/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  HAND REVEAL — Paid Show / Muck / Auto-Reveal
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * After a hand where the winning player didn't need to show, this component
 * allows other players to pay diamonds to reveal the winner's hole cards.
 * Also handles voluntary show/muck choice for the winner.
 *
 * Features:
 *   - Winner show/muck decision
 *   - Paid reveal request by other players (costs diamonds)
 *   - Timed auto-muck if no action
 *   - Bus integration for reveal events
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { haptic, soundService } from '../../services/SoundService';
import { masterBus } from '../../core/MasterBus';
import { CardImage } from './CardImage';
import type { Card as CardImageCard } from './CardImage';
import './HandReveal.css';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface HandRevealCard {
  rank: string;
  suit: 'h' | 'd' | 'c' | 's';
}

export interface HandRevealProps {
  /** Whether this component is visible */
  isOpen: boolean;
  /** Whether current user is the winner (show/muck controls) */
  isWinner: boolean;
  /** Winner's player ID */
  winnerId: string;
  /** Winner's display name */
  winnerName: string;
  /** Cards to reveal (only populated after reveal) */
  revealedCards?: HandRevealCard[];
  /** Cost in diamonds to reveal */
  revealCost?: number;
  /** Current user's diamond balance */
  userDiamonds?: number;
  /** Seconds before auto-muck */
  autoMuckTimer?: number;
  /** Table ID for bus events */
  tableId: string;
  /** Hand ID for bus events */
  handId: string;
  /** Callbacks */
  onShow?: () => void;
  onMuck?: () => void;
  onPayReveal?: () => void;
  onClose: () => void;
}

// ═══════════════════════════════════════════════════════════════════════════════
// COMPONENT
// ═══════════════════════════════════════════════════════════════════════════════

function normalizeRank(rank: string): CardImageCard['rank'] {
  if (rank === '10') return 'T';
  return rank as CardImageCard['rank'];
}

function toCardImage(card: HandRevealCard): CardImageCard {
  return { rank: normalizeRank(card.rank), suit: card.suit };
}

export function HandReveal({
  isOpen,
  isWinner,
  winnerId,
  winnerName,
  revealedCards,
  revealCost = 10,
  userDiamonds = 0,
  autoMuckTimer = 8,
  tableId,
  handId,
  onShow,
  onMuck,
  onPayReveal,
  onClose,
}: HandRevealProps) {
  const [timer, setTimer] = useState(autoMuckTimer);
  const [revealed, setRevealed] = useState(false);
  const [mucked, setMucked] = useState(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // UI-AUDIT #11: the interval closure below captured the FIRST handleMuck, so a
  // later hand (new handId/tableId/winnerId) would emit HAND_MUCKED with stale
  // ids. Keep a ref pointing at the latest handler and call through it.
  const handleMuckRef = useRef<() => void>(() => {});

  // Auto-muck countdown (winner only)
  // UI-AUDIT #10: handId + revealed/mucked are in the deps so the countdown
  // restarts for each new hand that reuses the open modal (previously it only
  // ran once and never re-armed for hand 2+).
  useEffect(() => {
    if (!isOpen || !isWinner || revealed || mucked) return;

    setTimer(autoMuckTimer);
    timerRef.current = setInterval(() => {
      setTimer((prev) => (prev <= 1 ? 0 : prev - 1));
    }, 1000);

    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [isOpen, isWinner, autoMuckTimer, handId, revealed, mucked]);

  /**
   * AUDIT 2026-08-25 — the auto-muck fired from INSIDE a state updater.
   *
   * `setTimer(prev => { if (prev <= 1) { handleMuckRef.current(); ... } })`
   * calls a handler that emits on the bus, plays a sound, fires a haptic and
   * sets two more pieces of state, all from within React's own reducer. React
   * treats updaters as pure and is explicitly free to call them more than once
   * for the same transition (StrictMode does exactly that today, and the
   * concurrent renderer may without it) - which would muck the hand twice, send
   * two HAND_MUCKED events and play the fold sound over itself. It also means
   * the muck lands during another component's render phase, which is the
   * cheapest way to get a "cannot update while rendering" warning.
   *
   * The interval now only counts. The muck is a reaction to the count reaching
   * zero, in an effect, where a side effect belongs. The `!mucked` guard makes
   * it fire once even if this effect re-runs.
   */
  useEffect(() => {
    if (!isOpen || !isWinner || revealed || mucked) return;
    if (timer > 0) return;
    handleMuckRef.current();
  }, [timer, isOpen, isWinner, revealed, mucked]);

  // Reset on new hand
  useEffect(() => {
    if (isOpen) {
      setRevealed(false);
      setMucked(false);
    }
  }, [isOpen, handId]);

  const handleShow = useCallback(() => {
    haptic.medium();
    // SOUND IMPROVEMENT 2026-08-19: showing your hand was haptic-only —
    // give the reveal its card-flick.
    soundService.playCardSqueeze();
    setRevealed(true);
    if (timerRef.current) clearInterval(timerRef.current);
    onShow?.();
    masterBus.emit('HAND_REVEALED', {
      handId,
      tableId,
      winnerId,
      cards: revealedCards?.map((c) => ({ rank: c.rank, suit: c.suit })) ?? [],
    });
  }, [handId, tableId, winnerId, revealedCards, onShow]);

  const handleMuck = useCallback(() => {
    haptic.light();
    // SOUND IMPROVEMENT 2026-08-19: muck gets the fold slide.
    soundService.playFold();
    setMucked(true);
    if (timerRef.current) clearInterval(timerRef.current);
    onMuck?.();
    masterBus.emit('HAND_MUCKED', { handId, tableId, winnerId });
  }, [handId, tableId, winnerId, onMuck]);

  // Keep the auto-muck interval pointing at the latest handleMuck.
  handleMuckRef.current = handleMuck;

  const handlePayReveal = useCallback(() => {
    if (userDiamonds < revealCost) return;
    haptic.medium();
    setRevealed(true);
    onPayReveal?.();
  }, [userDiamonds, revealCost, onPayReveal]);

  if (!isOpen) return null;

  /**
   * How many face-down cards to draw before the hand is shown.
   *
   * AUDIT 2026-08-25: this was two hard-coded `--facedown` divs, which is the
   * same defect Dan reported on the seat itself on 2026-08-23 ("it only shows 2
   * cards even if its a 4 card, 5 card or 6 card game"), living on in the modal
   * that asks the winner whether to show them. The winner's own hand is already
   * in `revealedCards` before they decide - TablePage fills it from the hero's
   * hole cards when it opens the prompt - so the count is available without a
   * new prop. Two stays the fallback for the paid-reveal case, where a
   * non-winner genuinely has no idea how many cards are hiding.
   */
  const faceDownCount = Math.max(2, Math.min(6, revealedCards?.length ?? 2));

  return (
    <div
      className="hand-reveal-overlay"
      onClick={onClose}
      /* AUDIT 2026-08-25: this was a bare div. It is a modal that takes the
         whole screen and steals every click, and it announced itself to a
         screen reader as nothing at all - and Escape, the one key every user
         tries on an overlay, did nothing. */
      role="dialog"
      aria-modal="true"
      aria-label={isWinner ? 'Show Or Muck Your Hand' : `${winnerName} Won This Pot`}
      tabIndex={-1}
      onKeyDown={(e) => {
        if (e.key !== 'Escape') return;
        e.stopPropagation();
        // Escape is a dismissal, not a decision: for the winner it must not be
        // read as "muck" (the countdown still owns that), only as "close".
        onClose();
      }}
    >
      <div className="hand-reveal" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="hand-reveal__header">
          <h3 className="hand-reveal__title">{isWinner ? 'Show or Muck?' : `${winnerName} Won`}</h3>
          {isWinner && !revealed && !mucked && <span className="hand-reveal__timer">{timer}s</span>}
        </div>

        {/* Card Display */}
        <div className="hand-reveal__cards">
          {revealed && revealedCards ? (
            revealedCards.map((card, i) => (
              <div key={i} className="hand-reveal__card hand-reveal__card--revealed">
                <CardImage card={toCardImage(card)} size="sm" />
              </div>
            ))
          ) : mucked ? (
            <div className="hand-reveal__mucked">
              <span className="hand-reveal__mucked-text">Mucked</span>
            </div>
          ) : (
            Array.from({ length: faceDownCount }, (_, i) => (
              <div key={i} className="hand-reveal__card hand-reveal__card--facedown" />
            ))
          )}
        </div>

        {/* Actions */}
        <div className="hand-reveal__actions">
          {isWinner && !revealed && !mucked && (
            <>
              <button className="hand-reveal__btn hand-reveal__btn--muck" onClick={handleMuck}>
                Muck
              </button>
              <button className="hand-reveal__btn hand-reveal__btn--show" onClick={handleShow}>
                Show Cards
              </button>
            </>
          )}

          {!isWinner && !revealed && !mucked && (
            <button
              className={`hand-reveal__btn hand-reveal__btn--pay ${userDiamonds < revealCost ? 'hand-reveal__btn--disabled' : ''}`}
              onClick={handlePayReveal}
              disabled={userDiamonds < revealCost}
            >
              Reveal ({revealCost})
            </button>
          )}

          {(revealed || mucked) && (
            <button className="hand-reveal__btn hand-reveal__btn--close" onClick={onClose}>
              Done
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

export default HandReveal;
