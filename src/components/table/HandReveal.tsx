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
      setTimer((prev) => {
        if (prev <= 1) {
          // Auto-muck (via ref → always the latest handler)
          handleMuckRef.current();
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [isOpen, isWinner, autoMuckTimer, handId, revealed, mucked]);

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

  return (
    <div className="hand-reveal-overlay" onClick={onClose}>
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
            <>
              <div className="hand-reveal__card hand-reveal__card--facedown" />
              <div className="hand-reveal__card hand-reveal__card--facedown" />
            </>
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
