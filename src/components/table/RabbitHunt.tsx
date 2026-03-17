/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * 🐰 RABBIT HUNT — See What Cards Would Have Come
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Post-hand feature with VIP gating:
 * - VIP users: FREE rabbit hunting
 * - Non-VIP: Pay diamonds per use (5)
 * - Animation for drama
 */

import React, { useState, useCallback, useEffect } from 'react';
import { vipService, FEATURE_PRICING } from '../../services/VIPService';
import { useAuthUser } from '../../hooks/useAuthUser';
import { useToast } from '../common/Toast';
import { CardImage } from '../table/CardImage';
import type { Card as CardImageCard } from '../table/CardImage';
import './RabbitHunt.css';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface Card {
  rank: string;
  suit: 'h' | 'd' | 'c' | 's';
}

export interface RabbitHuntProps {
  isAvailable: boolean;
  onReveal: () => Promise<Card[]>;
  currentBoard: Card[];
  maxCards?: number;
}

// ═══════════════════════════════════════════════════════════════════════════════
// UTILITIES
// ═══════════════════════════════════════════════════════════════════════════════

function normalizeRank(rank: string): CardImageCard['rank'] {
  if (rank === '10') return 'T';
  return rank as CardImageCard['rank'];
}

function toCardImage(card: Card): CardImageCard {
  return { rank: normalizeRank(card.rank), suit: card.suit };
}

// ═══════════════════════════════════════════════════════════════════════════════
// COMPONENT
// ═══════════════════════════════════════════════════════════════════════════════

export function RabbitHunt({ isAvailable, onReveal, currentBoard, maxCards = 5 }: RabbitHuntProps) {
  const { user } = useAuthUser();
  const toast = useToast();

  const [isRevealing, setIsRevealing] = useState(false);
  const [revealedCards, setRevealedCards] = useState<Card[]>([]);
  const [hasRevealed, setHasRevealed] = useState(false);
  const [isVIP, setIsVIP] = useState(false);
  const [isCheckingVIP, setIsCheckingVIP] = useState(true);

  const cost = FEATURE_PRICING.rabbit_hunt.cost;
  const cardsToReveal = maxCards - currentBoard.length;

  // Check VIP status on mount
  useEffect(() => {
    const checkVIP = async () => {
      if (!user?.id) {
        setIsVIP(false);
        setIsCheckingVIP(false);
        return;
      }

      try {
        const access = await vipService.checkFeatureAccess(user.id, 'rabbit_hunt');
        setIsVIP(access.hasAccess && !access.needsPurchase);
      } catch (err) {
        console.error('[RabbitHunt] Error:', err);
        setIsVIP(false);
      }
      setIsCheckingVIP(false);
    };

    checkVIP();
  }, [user?.id]);

  // Handle reveal click
  const handleReveal = useCallback(async () => {
    if (isRevealing || hasRevealed || !isAvailable) return;
    if (!user?.id) {
      toast.error('Please log in to use Rabbit Hunt');
      return;
    }

    setIsRevealing(true);
    try {
      // Check access and charge if needed
      const result = await vipService.useFeature(user.id, 'rabbit_hunt');

      if (!result.success) {
        toast.error('Insufficient diamonds for Rabbit Hunt');
        setIsRevealing(false);
        return;
      }

      // Show charge notification if diamonds were spent
      if (result.charged > 0) {
        toast.info(` ${result.charged} diamonds charged`);
      }

      // Reveal the cards
      const cards = await onReveal();

      // Reveal cards one by one with delay
      for (let i = 0; i < cards.length; i++) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        setRevealedCards((prev) => [...prev, cards[i]]);
      }
      setHasRevealed(true);
    } catch (error) {
      console.error('Rabbit hunt failed:', error);
      toast.error('Rabbit hunt failed');
    } finally {
      setIsRevealing(false);
    }
  }, [isRevealing, hasRevealed, isAvailable, onReveal, user?.id, toast]);

  if (!isAvailable && !hasRevealed) {
    return null;
  }

  return (
    <div className="rabbit-hunt">
      {/* Button */}
      {!hasRevealed && (
        <button
          className={`rabbit-hunt__button ${isRevealing ? 'rabbit-hunt__button--loading' : ''} ${isVIP ? 'rabbit-hunt__button--vip' : ''}`}
          onClick={handleReveal}
          disabled={isRevealing || isCheckingVIP}
        >
          <span className="rabbit-hunt__icon">🐰</span>
          <span className="rabbit-hunt__label">{isRevealing ? 'Revealing...' : 'Rabbit Hunt'}</span>
          {!isRevealing && !isCheckingVIP && (
            <span className={`rabbit-hunt__cost ${isVIP ? 'rabbit-hunt__cost--free' : ''}`}>
              {isVIP ? ' FREE' : `${cost} `}
            </span>
          )}
        </button>
      )}

      {/* Revealed Cards */}
      {revealedCards.length > 0 && (
        <div className="rabbit-hunt__reveal">
          <span className="rabbit-hunt__reveal-label">🐰 Rabbit shows:</span>
          <div className="rabbit-hunt__cards">
            {revealedCards.map((card, idx) => (
              <div
                key={idx}
                className="rabbit-hunt__card"
                style={{
                  animationDelay: `${idx * 0.1}s`,
                }}
              >
                <CardImage card={toCardImage(card)} deckStyle="4color" size="sm" />
              </div>
            ))}
            {/* Placeholder for unrevealed */}
            {Array(cardsToReveal - revealedCards.length)
              .fill(null)
              .map((_, idx) => (
                <div
                  key={`pending-${idx}`}
                  className="rabbit-hunt__card rabbit-hunt__card--pending"
                >
                  <span className="rabbit-hunt__pending-icon">?</span>
                </div>
              ))}
          </div>
        </div>
      )}
    </div>
  );
}

export default RabbitHunt;
