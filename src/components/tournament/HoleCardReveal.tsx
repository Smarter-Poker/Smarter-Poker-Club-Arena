/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  HOLE CARD REVEAL — Staggered Showdown Card Flip Animation
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Used at showdown to dramatically reveal each player's hole cards one by one,
 * with a 3D flip animation. Cards flip sequentially with a configurable delay.
 *
 * Features:
 * - 3D CSS card flip (backface hidden)
 * - Staggered reveal per player
 * - Winner highlight glow
 * - Configurable delay between card reveals
 * - Bus event subscription for showdown triggers
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useMasterBusSubscription } from '../../hooks/useMasterBusSubscription';
import { CardImage, CardBack } from '../table/CardImage';
import type { Card } from '../table/SeatSlot';
import './HoleCardReveal.css';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface ShowdownPlayer {
  userId: string;
  seatNumber: number;
  username: string;
  cards: Card[];
  handName: string; // e.g. "Full House", "Straight"
  handRank: number; // Lower = better (1 = Royal Flush)
  isWinner: boolean;
}

interface HoleCardRevealProps {
  tableId: string;
  /** Delay in ms between each player's card reveal */
  revealDelayMs?: number;
}

// ═══════════════════════════════════════════════════════════════════════════════
// COMPONENT
// ═══════════════════════════════════════════════════════════════════════════════

export const HoleCardReveal: React.FC<HoleCardRevealProps> = ({ tableId, revealDelayMs = 600 }) => {
  const [showdownPlayers, setShowdownPlayers] = useState<ShowdownPlayer[]>([]);
  const [revealedIndices, setRevealedIndices] = useState<Set<number>>(new Set());
  const [isActive, setIsActive] = useState(false);
  const timerRefs = useRef<ReturnType<typeof setTimeout>[]>([]);

  // Clean up timers on unmount
  useEffect(() => {
    return () => {
      timerRefs.current.forEach(clearTimeout);
    };
  }, []);

  // Listen for showdown events
  useMasterBusSubscription('SHOWDOWN_START', (payload: any) => {
    if (payload.tableId !== tableId) return;

    const players = (payload.players || []) as ShowdownPlayer[];
    if (players.length === 0) return;

    // Sort: losers first, winner last (dramatic reveal)
    const sorted = [...players].sort((a, b) => {
      if (a.isWinner && !b.isWinner) return 1;
      if (!a.isWinner && b.isWinner) return -1;
      return a.handRank - b.handRank; // Lower rank = better hand
    });

    // Clear previous state
    timerRefs.current.forEach(clearTimeout);
    timerRefs.current = [];
    setShowdownPlayers(sorted);
    setRevealedIndices(new Set());
    setIsActive(true);

    // Stagger reveals
    sorted.forEach((_, index) => {
      const timer = setTimeout(
        () => {
          setRevealedIndices((prev) => new Set(prev).add(index));
        },
        index * revealDelayMs + 200
      );
      timerRefs.current.push(timer);
    });

    // Auto-hide after all reveals + viewing time
    const hideTimer = setTimeout(
      () => {
        setIsActive(false);
        setShowdownPlayers([]);
        setRevealedIndices(new Set());
      },
      sorted.length * revealDelayMs + 4000
    );
    timerRefs.current.push(hideTimer);
  });

  // Dismiss manually
  const handleDismiss = useCallback(() => {
    timerRefs.current.forEach(clearTimeout);
    setIsActive(false);
    setShowdownPlayers([]);
    setRevealedIndices(new Set());
  }, []);

  if (!isActive || showdownPlayers.length === 0) return null;

  return (
    <div className="hcr-overlay" onClick={handleDismiss}>
      <div className="hcr-container">
        <div className="hcr-title">SHOWDOWN</div>

        <div className="hcr-players">
          {showdownPlayers.map((player, index) => {
            const isRevealed = revealedIndices.has(index);

            return (
              <div
                key={player.userId}
                className={`hcr-player ${isRevealed ? 'hcr-player--revealed' : ''} ${player.isWinner ? 'hcr-player--winner' : ''}`}
              >
                {/* Player Name & Hand */}
                <div className="hcr-player__info">
                  <span className="hcr-player__name">{player.username}</span>
                  {isRevealed && (
                    <span
                      className={`hcr-player__hand ${player.isWinner ? 'hcr-player__hand--winner' : ''}`}
                    >
                      {player.handName}
                    </span>
                  )}
                </div>

                {/* Cards with flip animation */}
                <div className="hcr-player__cards">
                  {player.cards.map((card, cardIdx) => (
                    <div
                      key={cardIdx}
                      className={`hcr-card ${isRevealed ? 'hcr-card--flipped' : ''}`}
                      style={{
                        animationDelay: isRevealed ? `${cardIdx * 150}ms` : undefined,
                      }}
                    >
                      <div className="hcr-card__inner">
                        {/* Back */}
                        <div className="hcr-card__back">
                          <CardBack size="md" style="classic_blue" />
                        </div>
                        {/* Front */}
                        <div className="hcr-card__front">
                          <CardImage card={card} size="md" isHighlighted={player.isWinner} />
                        </div>
                      </div>
                    </div>
                  ))}
                </div>

                {/* Winner Badge */}
                {player.isWinner && isRevealed && (
                  <div className="hcr-player__winner-badge">WINNER</div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};

export default HoleCardReveal;
