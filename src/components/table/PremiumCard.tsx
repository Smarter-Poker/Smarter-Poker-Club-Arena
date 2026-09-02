/**
 * Premium animated card shell.
 *
 * The face and back deliberately render through CardImage and CardBack. That
 * keeps this cinematic treatment on the same deck preference, fallback chain,
 * media base, and twelve-design card-back catalog as gameplay and Table Studio.
 */

import { useEffect, useState } from 'react';
import { CardBack, CardImage, normalizeCardBack, type Card as CardImageCard } from './CardImage';
import './PremiumCard.css';

export interface PremiumCardType {
  rank: string;
  suit: 'h' | 'd' | 'c' | 's' | 'hearts' | 'diamonds' | 'clubs' | 'spades';
}

/** Any stored id is accepted and normalized by the canonical renderer. */
export type DeckTheme = string;

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

  useEffect(() => {
    if (!isDealing) {
      setIsDealt(true);
      return undefined;
    }
    setIsDealt(false);
    const timer = setTimeout(() => setIsDealt(true), dealDelay);
    return () => clearTimeout(timer);
  }, [dealDelay, isDealing]);

  useEffect(() => {
    if (isHidden) {
      setIsFlipped(true);
      return undefined;
    }
    if (!isFlipped || !isDealt) return undefined;
    const timer = setTimeout(() => setIsFlipped(false), 150);
    return () => clearTimeout(timer);
  }, [isDealt, isFlipped, isHidden]);

  const dimensions = SIZES[size];
  const canonicalBack = normalizeCardBack(deckTheme);

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
        <div className="premium-card__front">
          {card && (
            <CardImage card={toCentralCard(card)} size={size} className="premium-card__canonical" />
          )}
          <div className="card-shine" aria-hidden="true" />
        </div>

        <div className="premium-card__back">
          <CardBack
            style={normalizeCardBack(deckTheme)}
            size={size}
            className="premium-card__canonical"
          />
          <span className="sr-only">{canonicalBack.replace(/[-_]/g, ' ')} Card Back</span>
        </div>
      </div>
    </div>
  );
}

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
