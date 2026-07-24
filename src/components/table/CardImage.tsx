/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  CARD IMAGE — Custom Card Deck Renderer
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Renders playing cards using custom PNG assets with 2 deck options:
 * - 4-Color: Hearts (Red), Diamonds (Blue), Clubs (Green), Spades (Black)
 * - 2-Color: Hearts/Diamonds (Red), Clubs/Spades (Black)
 */

import React, { useState, useEffect } from 'react';
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

  // Safety guard: if lookup failed, warn and fall back to Ace of Spades
  if (!suitName || !rankName) {
    console.warn(`[CardImage] Unknown card format: rank="${card.rank}" suit="${card.suit}"`);
    const safeSuit = suitName || 'spades';
    const safeRank = rankName || 'a';
    const base = import.meta.env.BASE_URL || '/hub/club-arena/';
    return `${base}cards/${deckStyle}/${safeSuit}_${safeRank}.png`;
  }

  // Serve card images from the same origin via proxy rewrites
  const base = import.meta.env.BASE_URL || '/hub/club-arena/';
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

// Broken-image fallback glyphs/colors per suit (accepts short + full formats)
const SUIT_CHAR: Record<string, string> = {
  h: '♥',
  d: '♦',
  c: '♣',
  s: '♠',
  hearts: '♥',
  diamonds: '♦',
  clubs: '♣',
  spades: '♠',
};

const SUIT_COLOR: Record<string, string> = {
  h: '#ef4444',
  d: '#3b82f6',
  c: '#22c55e',
  s: '#1e293b',
  hearts: '#ef4444',
  diamonds: '#3b82f6',
  clubs: '#22c55e',
  spades: '#1e293b',
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

  // UI-AUDIT #8: track the broken-image state in React (not via manual DOM
  // mutation) and reset it whenever the image path changes, so a slot that once
  // 404'd correctly shows the new valid card instead of staying hidden with a
  // stale fallback captured in the old error-time closure.
  const [imgError, setImgError] = useState(false);
  useEffect(() => {
    setImgError(false);
  }, [imagePath]);

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
        alt={`${card.rank} of ${SUIT_MAP[card.suit] || card.suit}`}
        className="card-image__img"
        draggable={false}
        style={imgError ? { display: 'none' } : undefined}
        onError={() => setImgError(true)}
      />
      {/* Fallback: hide broken image, show colored text indicator */}
      {imgError && (
        <div
          className="card-image__fallback"
          style={{
            width: '100%',
            height: '100%',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            background: '#fff',
            borderRadius: 'inherit',
            fontWeight: 800,
            color: SUIT_COLOR[card.suit] || '#000',
          }}
        >
          <span style={{ fontSize: '0.7em', lineHeight: 1 }}>{card.rank}</span>
          <span style={{ fontSize: '0.6em', lineHeight: 1 }}>{SUIT_CHAR[card.suit] || '?'}</span>
        </div>
      )}
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
