/**
 * =================================================================================
 *  DEAL ANIMATION -- Card dealing visual + sound when a new hand starts
 * =================================================================================
 *
 * Shows card backs flying from the dealer position to each active player
 * at the start of a new hand. Two cards per player, staggered timing.
 *
 * Sounds:
 *  - playNewHand() fires once when the animation starts (subtle "new hand" chime)
 *  - playDeal() fires for each card dealt (paper slide sfx), staggered with visuals
 *
 * The animation sends 2 rounds of cards (2 per player), dealing clockwise
 * starting from UTG (left of dealer). Each card flies from dealer to its
 * target seat with an 80ms stagger between cards.
 */

import React, { useEffect, useState, useRef, memo } from 'react';
import { soundService } from '../../services/SoundService';
import './DealAnimation.css';

// =================================================================================
// TYPES
// =================================================================================

export interface DealAnimationProps {
  /** Active when a new hand just started */
  active: boolean;
  /** Seat indices (0-based) of players being dealt to */
  activeSeats: number[];
  /** Dealer seat index (0-based) — cards fly FROM here */
  dealerSeatIndex: number;
  /** Seat positions as {x, y} percentages */
  seatPositions: { x: number; y: number }[];
  /** Called when animation completes */
  onComplete?: () => void;
}

interface FlyingCard {
  id: string;
  targetX: number;
  targetY: number;
  originX: number;
  originY: number;
  delay: number;
}

// =================================================================================
// CONSTANTS
// =================================================================================

/** Delay between each card deal in ms — PokerBros-style rapid fire */
const CARD_STAGGER_MS = 80;
/** Duration of each card's flight animation (must match CSS --da-flight-duration) */
const FLIGHT_DURATION_MS = 320;
/** Extra settle time after last card arrives before cleanup */
const SETTLE_BUFFER_MS = 100;

// =================================================================================
// COMPONENT
// =================================================================================

function DealAnimationComponent({
  active,
  activeSeats,
  dealerSeatIndex,
  seatPositions,
  onComplete,
}: DealAnimationProps) {
  const [cards, setCards] = useState<FlyingCard[]>([]);
  const [visible, setVisible] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const soundTimersRef = useRef<ReturnType<typeof setTimeout>[]>([]);
  const onCompleteRef = useRef(onComplete);
  onCompleteRef.current = onComplete;

  // Only trigger on `active` transitioning to true
  const prevActiveRef = useRef(false);

  useEffect(() => {
    if (active && !prevActiveRef.current) {
      prevActiveRef.current = true;

      if (activeSeats.length === 0) return;

      const dealerPos = seatPositions[dealerSeatIndex] || { x: 50, y: 50 };
      const newCards: FlyingCard[] = [];

      // Two rounds of dealing (two cards per player)
      for (let round = 0; round < 2; round++) {
        activeSeats.forEach((seatIdx, orderIdx) => {
          const pos = seatPositions[seatIdx];
          if (!pos) return;
          const delay = (round * activeSeats.length + orderIdx) * CARD_STAGGER_MS;
          newCards.push({
            id: `deal-${round}-${seatIdx}`,
            targetX: pos.x,
            targetY: pos.y,
            originX: dealerPos.x,
            originY: dealerPos.y,
            delay,
          });
        });
      }

      setCards(newCards);
      setVisible(true);

      // --- Sound Integration ---
      // Play "new hand starting" sound immediately
      try {
        soundService.playNewHand();
      } catch {
        // Sound failure should never break gameplay
      }

      // Play individual card deal sounds staggered with each card
      // Clear any leftover timers from previous deal
      soundTimersRef.current.forEach(clearTimeout);
      soundTimersRef.current = [];

      newCards.forEach((card) => {
        const t = setTimeout(() => {
          try {
            soundService.playDeal();
          } catch {
            // Graceful degradation
          }
        }, card.delay + 30); // +30ms offset so sound fires slightly after visual launch
        soundTimersRef.current.push(t);
      });

      // Animation duration: last card delay + flight time + settle
      const lastDelay = newCards.length > 0 ? newCards[newCards.length - 1].delay : 0;
      const totalDuration = lastDelay + FLIGHT_DURATION_MS + SETTLE_BUFFER_MS;

      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        setVisible(false);
        setCards([]);
        onCompleteRef.current?.();
        timerRef.current = null;
      }, totalDuration);
    }

    if (!active && prevActiveRef.current) {
      prevActiveRef.current = false;
    }

    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      soundTimersRef.current.forEach(clearTimeout);
      soundTimersRef.current = [];
    };
  }, [active]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!visible || cards.length === 0) return null;

  return (
    <div className="deal-animation" aria-hidden="true">
      {cards.map((card) => (
        <div
          key={card.id}
          className="deal-animation__card"
          style={
            {
              '--origin-x': `${card.originX}%`,
              '--origin-y': `${card.originY}%`,
              '--target-x': `${card.targetX}%`,
              '--target-y': `${card.targetY}%`,
              '--delay': `${card.delay}ms`,
            } as React.CSSProperties
          }
        />
      ))}
    </div>
  );
}

export const DealAnimation = memo(DealAnimationComponent);
export default DealAnimation;
