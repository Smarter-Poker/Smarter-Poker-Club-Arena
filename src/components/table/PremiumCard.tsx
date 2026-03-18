/**
 *  PREMIUM CARD COMPONENT
 * High-end video game style playing card with 3D effects and animations
 * Now using premium digital deck card images
 */

import { useState, useEffect } from 'react';
import { getCardImagePath } from './CardImage';
import type { Card as CardImageCard } from './CardImage';
import './PremiumCard.css';

// Local type definitions (compatible with club-engine Card type)
export interface PremiumCardType {
  rank: string;
  suit: 'h' | 'd' | 'c' | 's' | 'hearts' | 'diamonds' | 'clubs' | 'spades';
}

// Deck theme definitions with custom card back images
export type DeckTheme = 'classic' | 'burgundy' | 'navy' | 'gold';

// Build base path for card-back images
function getBackBase(): string {
  return import.meta.env.BASE_URL || '/hub/club-arena/';
}

export const DECK_THEMES: Record<DeckTheme, { name: string; image: string }> = {
  classic: { name: 'Classic', image: `${getBackBase()}cards/backs/classic.webp` },
  burgundy: { name: 'Burgundy', image: `${getBackBase()}cards/backs/burgundy.webp` },
  navy: { name: 'Navy', image: `${getBackBase()}cards/backs/navy.webp` },
  gold: { name: 'Premium Gold', image: `${getBackBase()}cards/backs/gold.webp` },
};

interface PremiumCardProps {
  card?: PremiumCardType;
  isHidden?: boolean;
  isDealing?: boolean;
  dealDelay?: number;
  size?: 'sm' | 'md' | 'lg';
  isHighlighted?: boolean;
  deckTheme?: DeckTheme;
  onClick?: () => void;
}

// Normalize PremiumCardType to CardImage Card format
const SUIT_ABBREV: Record<string, CardImageCard['suit']> = {
  h: 'h',
  d: 'd',
  c: 'c',
  s: 's',
  hearts: 'h',
  diamonds: 'd',
  clubs: 'c',
  spades: 's',
};

const RANK_NORMALIZE: Record<string, CardImageCard['rank']> = {
  '2': '2',
  '3': '3',
  '4': '4',
  '5': '5',
  '6': '6',
  '7': '7',
  '8': '8',
  '9': '9',
  '10': 'T',
  T: 'T',
  t: 'T',
  J: 'J',
  j: 'J',
  Q: 'Q',
  q: 'Q',
  K: 'K',
  k: 'K',
  A: 'A',
  a: 'A',
};

function toCentralCard(card: PremiumCardType): CardImageCard {
  return {
    suit: SUIT_ABBREV[card.suit] || 's',
    rank: RANK_NORMALIZE[card.rank] || 'A',
  };
}

// Card sizes (aspect ratio 5:7 matches our 750x1050 images)
const SIZES = {
  sm: { width: 44, height: 62 },
  md: { width: 56, height: 78 },
  lg: { width: 72, height: 100 },
};

export default function PremiumCard({
  card,
  isHidden = false,
  isDealing = false,
  dealDelay = 0,
  size = 'md',
  isHighlighted = false,
  deckTheme = 'gold',
  onClick,
}: PremiumCardProps) {
  const [isFlipped, setIsFlipped] = useState(isHidden);
  const [isDealt, setIsDealt] = useState(!isDealing);

  // Handle deal animation
  useEffect(() => {
    if (isDealing) {
      const timer = setTimeout(() => {
        setIsDealt(true);
      }, dealDelay);
      return () => clearTimeout(timer);
    }
  }, [isDealing, dealDelay]);

  // Handle flip animation
  useEffect(() => {
    if (!isHidden && isFlipped && isDealt) {
      const timer = setTimeout(() => {
        setIsFlipped(false);
      }, 150);
      return () => clearTimeout(timer);
    }
  }, [isHidden, isFlipped, isDealt]);

  const dimensions = SIZES[size];
  const theme = DECK_THEMES[deckTheme];
  const cardImagePath = card ? getCardImagePath(toCentralCard(card)) : null;

  return (
    <div
      className={`premium-card-wrapper ${isDealt ? 'dealt' : 'dealing'} ${isHighlighted ? 'highlighted' : ''}`}
      style={{
        width: dimensions.width,
        height: dimensions.height,
        transitionDelay: `${dealDelay}ms`,
      }}
      onClick={onClick}
    >
      <div className={`premium-card ${isFlipped || isHidden ? 'flipped' : ''}`}>
        {/* Card Front - Using premium digital deck images */}
        <div className="card-front">
          {card && cardImagePath && (
            <>
              <img
                loading="lazy"
                decoding="async"
                src={cardImagePath}
                alt={`${card.rank} of ${card.suit}`}
                className="card-front-image"
              />
              {/* Shine Effect */}
              <div className="card-shine" />
            </>
          )}
        </div>

        {/* Card Back - Using custom image */}
        <div className="card-back">
          <img
            loading="lazy"
            decoding="async"
            src={theme.image}
            alt="Card Back"
            className="card-back-image"
          />
        </div>
      </div>
    </div>
  );
}

// Card placeholder for empty slots
export function CardPlaceholder({ size = 'md' }: { size?: 'sm' | 'md' | 'lg' }) {
  const dimensions = SIZES[size];
  return (
    <div
      className="card-placeholder"
      style={{ width: dimensions.width, height: dimensions.height }}
    >
      <div className="placeholder-inner" />
    </div>
  );
}

export { PremiumCard };
