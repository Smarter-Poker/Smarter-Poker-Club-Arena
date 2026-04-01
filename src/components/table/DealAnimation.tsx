/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  DEAL ANIMATION — Card dealing visual when a new hand starts
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Shows card backs flying from the dealer position to each active player
 * at the start of a new hand. Two cards per player, staggered timing.
 */

import React, { useEffect, useState, useRef, useCallback, memo } from 'react';
import './DealAnimation.css';

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
  const onCompleteRef = useRef(onComplete);
  onCompleteRef.current = onComplete;

  // Only trigger on `active` transitioning to true — ignore array ref changes
  const prevActiveRef = useRef(false);

  useEffect(() => {
    // Only fire when active transitions from false → true
    if (active && !prevActiveRef.current) {
      prevActiveRef.current = true;

      if (activeSeats.length === 0) return;

      const dealerPos = seatPositions[dealerSeatIndex] || { x: 50, y: 50 };
      const newCards: FlyingCard[] = [];

      // Two rounds (two cards per player)
      for (let round = 0; round < 2; round++) {
        activeSeats.forEach((seatIdx, orderIdx) => {
          const pos = seatPositions[seatIdx];
          if (!pos) return;
          newCards.push({
            id: `deal-${round}-${seatIdx}`,
            targetX: pos.x,
            targetY: pos.y,
            originX: dealerPos.x,
            originY: dealerPos.y,
            delay: (round * activeSeats.length + orderIdx) * 80,
          });
        });
      }

      setCards(newCards);
      setVisible(true);

      // Animation duration: last card delay + fly time + settle time
      const totalDuration = newCards.length * 80 + 400;
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
    };
  }, [active]); // eslint-disable-line react-hooks/exhaustive-deps
  // ↑ Intentionally only depends on `active` — other props read via refs/current values

  if (!visible || cards.length === 0) return null;

  return (
    <div className="deal-animation">
      {cards.map((card) => (
        <div
          key={card.id}
          className="deal-animation__card"
          style={{
            '--origin-x': `${card.originX}%`,
            '--origin-y': `${card.originY}%`,
            '--target-x': `${card.targetX}%`,
            '--target-y': `${card.targetY}%`,
            '--delay': `${card.delay}ms`,
          } as React.CSSProperties}
        />
      ))}
    </div>
  );
}

export const DealAnimation = memo(DealAnimationComponent);
export default DealAnimation;
