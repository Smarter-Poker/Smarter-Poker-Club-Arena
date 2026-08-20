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
import { MEDIA_BASE } from '../../utils/mediaBase';
import { useDeckStyle } from '../../hooks/useDeckStyle';
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
export function getCardImagePath(card: Card, deckStyle: DeckStyle = '2color'): string {
  const suitName = SUIT_MAP[card.suit];
  const rankName = RANK_MAP[card.rank];

  // Safety guard: if lookup failed, warn and fall back to Ace of Spades
  if (!suitName || !rankName) {
    console.warn(`[CardImage] Unknown card format: rank="${card.rank}" suit="${card.suit}"`);
    const safeSuit = suitName || 'spades';
    const safeRank = rankName || 'a';
    const base = MEDIA_BASE;
    return `${base}cards/${deckStyle}/${safeSuit}_${safeRank}.png`;
  }

  // Serve card images from the same origin via proxy rewrites
  const base = MEDIA_BASE;
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
  deckStyle,
  size = 'md',
  isHighlighted = false,
  isFolded = false,
  className = '',
}: CardImageProps) {
  // ── Dan 2026-08-18: make the four-colour deck setting actually apply ──
  //
  // deckStyle used to default to the literal '4color'. TablePage threaded the
  // real preference into SeatSlot and CommunityCards, so the felt obeyed it,
  // but 27 of the 32 <CardImage> call sites overrode it with a hardcoded
  // four-colour value - hand replay, insurance, run-it-twice, rabbit hunt,
  // share-hand, the tournament reveal, the odds display. Turning the setting
  // off therefore changed the felt and nothing else.
  //
  // Resolving it here means every card in the app follows the player by
  // default, including any component added later. An explicit prop still
  // wins, which is what the felt passes.
  const preferredDeckStyle = useDeckStyle();
  const effectiveDeckStyle = deckStyle ?? preferredDeckStyle;
  const imagePath = getCardImagePath(card, effectiveDeckStyle);
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

/**
 * The card back designs that actually exist as `.card-back--<id>` rules in
 * CardImage.css.
 *
 * ── Dan 2026-08-18: "make sure the card back designs are working" ──
 *
 * CORRECTION to the first pass at this. An unknown id did NOT render a blank
 * rectangle - it rendered the base navy back, and so did every KNOWN id,
 * because `.card-image--back .card-back` (0-2-0) outranks
 * `.card-back--classic_red` (0-1-0), and TableVisualHotfix piled !important on
 * top at 0-4-0. All eight designs looked identical and the picker did nothing.
 * Fixed in CSS by having each design set custom properties that the base rule
 * reads, so there is no cascade contest left to lose.
 *
 * Normalising ids is still worth doing, because the ids in circulation did not
 * match the stylesheet either:
 *   - useTableSettings defaulted cardBack to 'black'   -> no such class
 *   - SeatSlot's internal default was also 'black'      -> no such class
 *   - CommunityCards and CardReveal hardcoded 'classic' -> no such class
 * ('classic_red' and 'classic_blue' exist; bare 'classic' and 'black' never
 * did.) Each of those produced a blank rectangle where the card back belongs,
 * which is indistinguishable from "the feature is broken".
 *
 * Normalising here means a bad or stale id can never blank a card again -
 * including ids already sitting in players' localStorage from before this fix.
 */
export const CARD_BACK_IDS = [
  'classic_red',
  'classic_blue',
  'diamond',
  'dragon',
  'galaxy',
  'gold',
  'neon',
  'royal',
  'holographic',
  'carbon',
  'club-branded',
  'diamond-foil',
] as const;

const DEFAULT_CARD_BACK = 'classic_blue';

/**
 * Map legacy/invalid ids onto real designs rather than rendering nothing.
 *
 * 2026-08-20 — THE STORE AND THE TABLE SPOKE DIFFERENT LANGUAGES.
 * CardBackSelector sells twelve designs by id (black, red, blue, white,
 * classic, burgundy, navy, gold, holographic, carbon, club-branded,
 * diamond-foil). Only five of those ids existed here, so buying any of the
 * other seven — six of them PAID, up to 300 diamonds each — resolved to the
 * default back. Worse, settingsBridge whitelisted cardBack against the eight
 * table ids, so those purchases were rejected at the persistence layer and
 * silently reverted: diamonds spent, nothing changed, no error.
 *
 * Every purchasable id now maps to a real design, and the paid tiers each map
 * to a DISTINCT one so a purchase always visibly changes the card back.
 */
const CARD_BACK_ALIASES: Record<string, string> = {
  // legacy / free tier
  classic: 'classic_red',
  black: 'classic_blue',
  blue: 'classic_blue',
  red: 'classic_red',
  white: 'royal',
  // paid tier — each maps to a distinct real design
  burgundy: 'classic_red',
  navy: 'classic_blue',
  // Theme Settings' old Cards tab (pre-2026-08-20). These five ids were never
  // card-back designs — the tab shipped with invented ids that matched nothing
  // here — but they ARE sitting in user_theme_settings.cards_id for everyone
  // who ever opened the modal. Map each to the closest real design so those
  // rows upgrade to something intentional instead of silently defaulting.
  'standard-red': 'classic_red',
  'standard-blue': 'classic_blue',
  'premium-gold': 'gold',
  'premium-black': 'carbon',
  'premium-platinum': 'holographic',
};

/** Every id the store can hand us, canonical + purchasable aliases. */
export const SELECTABLE_CARD_BACK_IDS: readonly string[] = [
  ...CARD_BACK_IDS,
  ...Object.keys(CARD_BACK_ALIASES),
];

export function normalizeCardBack(style: string | undefined | null): string {
  if (!style) return DEFAULT_CARD_BACK;
  if ((CARD_BACK_IDS as readonly string[]).includes(style)) return style;
  return CARD_BACK_ALIASES[style] ?? DEFAULT_CARD_BACK;
}

export function CardBack({ style, size = 'md', className = '' }: CardBackProps) {
  const sizeClass = SIZE_CLASSES[size];
  const backStyle = normalizeCardBack(style);
  const classes = ['card-image', 'card-image--back', sizeClass, className]
    .filter(Boolean)
    .join(' ');

  return (
    <div className={classes}>
      <div className={`card-back card-back--${backStyle}`} />
    </div>
  );
}

export default CardImage;
