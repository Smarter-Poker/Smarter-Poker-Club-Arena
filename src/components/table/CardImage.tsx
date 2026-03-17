/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  CARD IMAGE — Custom Card Deck Renderer
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Renders playing cards using custom PNG assets with 2 deck options:
 * - 4-Color: Hearts (Red), Diamonds (Blue), Clubs (Green), Spades (Black)
 * - 2-Color: Hearts/Diamonds (Red), Clubs/Spades (Black)
 */

import React from 'react';
import './CardImage.css';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export type DeckStyle = '4color' | '2color';

export interface Card {
  rank: '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9' | 'T' | 'J' | 'Q' | 'K' | 'A';
  suit: 'h' | 'd' | 'c' | 's';
}

export interface CardImageProps {
  card: Card;
  deckStyle?: DeckStyle;
  size?: 'xs' | 'sm' | 'md' | 'lg' | 'xl';
  isHighlighted?: boolean;
  isFolded?: boolean;
  className?: string;
}

// ═══════════════════════════════════════════════════════════════════════════════
// UTILITIES
// ═══════════════════════════════════════════════════════════════════════════════

const SUIT_MAP: Record<string, string> = {
  h: 'hearts',
  d: 'diamonds',
  c: 'clubs',
  s: 'spades',
  // Also accept full suit names (defensive — some code paths pass DB format directly)
  hearts: 'hearts',
  diamonds: 'diamonds',
  clubs: 'clubs',
  spades: 'spades',
};

const RANK_MAP: Record<string, string> = {
  '2': '2',
  '3': '3',
  '4': '4',
  '5': '5',
  '6': '6',
  '7': '7',
  '8': '8',
  '9': '9',
  T: '10',
  J: 'j',
  Q: 'q',
  K: 'k',
  A: 'a',
  // Defensive: also accept formats that some code paths may send
  '10': '10',
  j: 'j',
  q: 'q',
  k: 'k',
  a: 'a',
  t: '10',
};

/**
 * Get the path to the card image
 */
export function getCardImagePath(card: Card, deckStyle: DeckStyle = '4color'): string {
  const suitName = SUIT_MAP[card.suit];
  const rankName = RANK_MAP[card.rank];
  // In production, serve card images directly from club-arena.vercel.app
  // to avoid World Hub's Next.js rewrite stripping binary content-type
  const isProduction = typeof window !== 'undefined' && window.location.hostname !== 'localhost';
  const base = isProduction
    ? 'https://club-arena.vercel.app/hub/club-arena/'
    : import.meta.env.BASE_URL || '/';
  return `${base}cards/${deckStyle}/${suitName}_${rankName}.png`;
}

// ═══════════════════════════════════════════════════════════════════════════════
// SIZES
// ═══════════════════════════════════════════════════════════════════════════════

const SIZE_CLASSES: Record<string, string> = {
  xs: 'card-image--xs', // 24x36
  sm: 'card-image--sm', // 36x54
  md: 'card-image--md', // 48x72
  lg: 'card-image--lg', // 64x96
  xl: 'card-image--xl', // 80x120
};

// ═══════════════════════════════════════════════════════════════════════════════
// COMPONENT
// ═══════════════════════════════════════════════════════════════════════════════

export function CardImage({
  card,
  deckStyle = '4color',
  size = 'md',
  isHighlighted = false,
  isFolded = false,
  className = '',
}: CardImageProps) {
  const imagePath = getCardImagePath(card, deckStyle);
  const sizeClass = SIZE_CLASSES[size];

  const classes = [
    'card-image',
    sizeClass,
    isHighlighted ? 'card-image--highlighted' : '',
    isFolded ? 'card-image--folded' : '',
    className,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div className={classes}>
      <img
        loading="lazy"
        decoding="async"
        src={imagePath}
        alt={`${card.rank} of ${SUIT_MAP[card.suit]}`}
        className="card-image__img"
        draggable={false}
      />
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// CARD BACK
// ═══════════════════════════════════════════════════════════════════════════════

export interface CardBackProps {
  style?: string;
  size?: 'xs' | 'sm' | 'md' | 'lg' | 'xl';
  className?: string;
}

export function CardBack({ style = 'classic_red', size = 'md', className = '' }: CardBackProps) {
  const sizeClass = SIZE_CLASSES[size];
  const classes = ['card-image', 'card-image--back', sizeClass, className]
    .filter(Boolean)
    .join(' ');

  return (
    <div className={classes}>
      <div className={`card-back card-back--${style}`} />
    </div>
  );
}

export default CardImage;
