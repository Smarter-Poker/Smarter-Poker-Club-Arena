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
import { reportError } from '../../utils/errorReporter';

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
  /**
   * Whether the browser may defer this card's face.
   *
   * Defaults to `lazy`, which is right for the long lists this component also
   * serves (BBJ history, hand replays, the card-back store) - dozens of faces
   * below the fold.
   *
   * It is wrong for the two rows that decide a hand. AUDIT 2026-08-25: the
   * felt's cards were lazy too, and lazy has a real cost exactly where it hurts
   * most. A `loading="lazy"` image inside a `display: none` subtree is not
   * fetched at all, and MultiTablePage keeps up to four tables mounted with the
   * inactive ones display:none - so switching tabs showed a beat of empty card
   * boxes while the faces were fetched and decoded. At showdown the same
   * heuristic delays the one frame the player is actually reading. The felt now
   * passes `eager` for the hero's hand, a revealed villain hand and the
   * community board; every other caller keeps the lazy default.
   *
   * Cheap to do: the whole WebP deck is ~8KB a card and shared by every table,
   * so the second table pays nothing.
   */
  loading?: 'lazy' | 'eager';
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
 * Get the path to the card image, or `null` if this card cannot be read.
 *
 * ── THE FELT NEVER SHOWS A CARD THAT IS NOT THE CARD (2026-08-26) ──
 *
 * This used to substitute the ACE OF SPADES for anything it could not parse:
 *
 *     const safeSuit = suitName || 'spades';
 *     const safeRank = rankName || 'a';
 *
 * That is the most dangerous failure mode in the whole client. Every other
 * broken thing here degrades to something the player can SEE is broken — a
 * blank slot, a spinner, a toast. This one degraded to a real, plausible,
 * PLAYABLE card, indistinguishable from a genuine deal, and the player would
 * put money in behind it. A malformed river card reading as the ace that
 * completes their nut flush is not a rendering bug, it is a wrong decision
 * with their bankroll on it.
 *
 * `null` now, and the component paints an unmistakable "unreadable card"
 * tile. A player who sees it knows not to trust the slot. That is the only
 * honest thing a card renderer can do when it does not know the card.
 *
 * Note the guard fires for *unmapped* values, not merely off-type ones: both
 * maps deliberately accept several formats (short 'h', full 'hearts', upper
 * and lower rank), so anything reaching this branch is genuinely unreadable
 * rather than just an unusual spelling.
 */
export function getCardImagePath(card: Card, deckStyle: DeckStyle = '2color'): string | null {
  const suitName = SUIT_MAP[card.suit];
  const rankName = RANK_MAP[card.rank];

  if (!suitName || !rankName) {
    reportError(
      new Error(`Unreadable card: rank="${card.rank}" suit="${card.suit}"`),
      'CardImage.unreadable_card',
      { rank: String(card.rank), suit: String(card.suit), deckStyle }
    );
    return null;
  }

  // PERF PASS 2026-08-22: serve WebP instead of PNG. The source PNGs are
  // 750x1050 at ~66KB each (a full deck = 3.4MB); the build-time WebP
  // variants (scripts/generate-webp-media.mjs) are ~8KB each — an entire
  // deck now weighs less than six of the old PNGs. Every consumer of this
  // path must attach `withPngFallback` (or equivalent) as the img onError
  // handler so environments without generated WebP degrade to the PNGs.
  const base = MEDIA_BASE;
  return `${base}cards/${deckStyle}/${suitName}_${rankName}.webp`;
}

/**
 * onError handler for card <img> tags: if the WebP variant is missing
 * (e.g., a build ran without the WebP generation step), retry the same
 * card as PNG before giving up. Safe to attach to any card image.
 */
export function withPngFallback(e: React.SyntheticEvent<HTMLImageElement>): void {
  const img = e.currentTarget;
  if (img.src.endsWith('.webp')) {
    img.src = img.src.replace(/\.webp$/, '.png');
  }
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

/**
 * The suit palette, and the SOURCE OF TRUTH for it - asserted by
 * `tests/gameplay-wears-the-house-colours.test.ts` ("the four-colour deck
 * agrees with itself"). Exported since 2026-09-05 so the Card Slide peel index
 * can draw a corner rank in the same colour the deck draws the suit, instead
 * of a second set of literals in a stylesheet that could drift.
 */
export const SUIT_COLOR: Record<string, string> = {
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
  loading = 'lazy',
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
  /* `null` means the card could not be read at all. See getCardImagePath:
     showing a guessed card here would be worse than showing nothing. */
  const unreadable = imagePath === null;

  // UI-AUDIT #8: track the broken-image state in React (not via manual DOM
  // mutation) and reset it whenever the image path changes, so a slot that once
  // 404'd correctly shows the new valid card instead of staying hidden with a
  // stale fallback captured in the old error-time closure.
  // PERF PASS 2026-08-22: two-step fallback — WebP → PNG → text glyph. The
  // PNG step covers builds where WebP generation was skipped.
  const [fallbackStep, setFallbackStep] = useState<0 | 1 | 2>(0);
  useEffect(() => {
    setFallbackStep(0);
  }, [imagePath]);
  const imgError = fallbackStep >= 2;
  // AUDIT 2026-08-25: this read `fallbackStep === 1 ? png : webp`, so at step 2
  // - the give-up state - the src flipped BACK to the .webp that had already
  // 404'd. The <img> is still mounted (hidden with display:none so the box keeps
  // its size), so the browser re-requested a URL known to be dead every time the
  // fallback rendered. Once we have moved past the WebP it never comes back.
  const effectivePath =
    imagePath === null ? '' : fallbackStep >= 1 ? imagePath.replace(/\.webp$/, '.png') : imagePath;

  const classes = [
    'card-image',
    sizeClass,
    isHighlighted ? 'card-image--highlighted' : '',
    isFolded ? 'card-image--folded' : '',
    unreadable ? 'card-image--unreadable' : '',
    className,
  ]
    .filter(Boolean)
    .join(' ');

  /* An unreadable card renders NO <img> at all. Emitting one with an empty
     src makes the browser re-request the page URL as an image, and — worse —
     leaves a slot that can flash something card-shaped. The tile below is
     deliberately not card-coloured and carries no rank or suit, because the
     rank and suit are exactly what we failed to read. */
  if (unreadable) {
    return (
      <div
        className={classes}
        role="img"
        aria-label="Card Could Not Be Read"
        title="This Card Could Not Be Read. Do Not Act On It, Reload The Table."
      >
        <div className="card-image__unreadable">
          <span aria-hidden="true">?</span>
        </div>
      </div>
    );
  }

  return (
    <div className={classes}>
      <img
        loading={loading}
        decoding="async"
        src={effectivePath}
        alt={`${card.rank} Of ${SUIT_MAP[card.suit] || card.suit}`}
        className="card-image__img"
        draggable={false}
        style={imgError ? { display: 'none' } : undefined}
        onError={() => setFallbackStep((s) => (s === 0 && effectivePath.endsWith('.webp') ? 1 : 2))}
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
 * Table Studio sells twelve designs by id (black, red, blue, white,
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

/**
 * Is this an id the app has ever meant something by?
 *
 * normalizeCardBack answers `classic_blue` for anything it does not recognise,
 * which is the right answer when you are about to PAINT a card and the wrong
 * answer when you are about to decide what somebody OWNS: without this guard a
 * junk row in feature_purchases normalises to classic_blue and reads as a
 * purchase of it.
 */
export function isKnownCardBackId(style: string | undefined | null): boolean {
  if (!style) return false;
  return (
    (CARD_BACK_IDS as readonly string[]).includes(style) ||
    Object.prototype.hasOwnProperty.call(CARD_BACK_ALIASES, style)
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// THE CARD BACK CATALOGUE — one list, every surface
// ═══════════════════════════════════════════════════════════════════════════════
//
// Dan 2026-08-25: "every selectable feature must be 100% fully built out,
// functional and actually change and update in real time when selected."
//
// ONE SURFACE SELLS CARD BACKS — Table Studio owns checkout and selection,
// ThemeSettingsModal's Cards tab, and the table hamburger menu — and each kept
// its OWN copy of the list. That is the defect this repo has now fixed three
// separate times, always in one copy at a time:
//
//   - 2026-08-20  ThemeSettingsModal offered standard-red / premium-gold /
//                 premium-platinum. Matched nothing. All collapsed to
//                 classic_blue.
//   - 2026-08-25  HamburgerMenu offered default / emerald / crimson /
//                 midnight / obsidian. Same outcome, five days later.
//   - then        CardBackSelector sold TWELVE ids that resolved to SEVEN
//                 designs. `classic` (50 diamonds), `burgundy` (75) and the
//                 free `red` were the identical picture; `navy` (75), `black`
//                 and `blue` were the identical picture. Three paid designs
//                 were pixel-for-pixel a free one.
//
// Meanwhile FOUR designs with real artwork on disk — diamond, dragon, galaxy,
// neon — were not for sale anywhere.
//
// The catalogue below is keyed by the CANONICAL ids, the ones the artwork is
// named after, so a tile cannot exist without a picture and two tiles cannot
// share one. Every surface reads it. cardBackCatalog.test.ts pins both
// properties: full coverage of CARD_BACK_IDS, and no two entries alike.

export type CardBackTier = 'standard' | 'premium' | 'exclusive';

export interface CardBackDesign {
  /** Canonical id. Artwork lives at `cards/backs/table/<id>.webp`. */
  id: (typeof CARD_BACK_IDS)[number];
  name: string;
  tier: CardBackTier;
  /** Diamond price. 0 for the free tier. */
  price: number;
}

export const CARD_BACK_CATALOG: readonly CardBackDesign[] = [
  // ── Free ──
  { id: 'classic_blue', name: 'Classic Blue', tier: 'standard', price: 0 },
  { id: 'classic_red', name: 'Classic Red', tier: 'standard', price: 0 },
  { id: 'royal', name: 'Royal', tier: 'standard', price: 0 },
  // ── Premium ──
  { id: 'neon', name: 'Neon', tier: 'premium', price: 75 },
  { id: 'galaxy', name: 'Galaxy', tier: 'premium', price: 75 },
  { id: 'diamond', name: 'Diamond', tier: 'premium', price: 100 },
  { id: 'dragon', name: 'Dragon', tier: 'premium', price: 125 },
  { id: 'gold', name: 'Premium Gold', tier: 'premium', price: 150 },
  // ── Exclusive ──
  { id: 'carbon', name: 'Carbon Fiber', tier: 'exclusive', price: 175 },
  { id: 'holographic', name: 'Holographic', tier: 'exclusive', price: 200 },
  { id: 'club-branded', name: 'Club Crest', tier: 'exclusive', price: 250 },
  { id: 'diamond-foil', name: 'Diamond Foil', tier: 'exclusive', price: 300 },
];

/** The catalogue entry a stored id resolves to. Never undefined. */
export function cardBackDesign(style: string | undefined | null): CardBackDesign {
  const id = normalizeCardBack(style);
  return CARD_BACK_CATALOG.find((d) => d.id === id) ?? CARD_BACK_CATALOG[0];
}

/**
 * ONE ownership rule, used by the store AND by the theme modal.
 *
 * They used to disagree, and both directions of the disagreement were real:
 * the modal gated paid designs on VIP alone, so a player who had SPENT 150
 * diamonds on Premium Gold in the store still saw it padlocked in the modal;
 * and the store gated on purchases alone, so a VIP who already had every
 * design free in the modal was quoted a price for it in the store.
 */
export function isCardBackUnlocked(
  style: string | undefined | null,
  opts: { isVip?: boolean; owned?: readonly string[] } = {}
): boolean {
  const design = cardBackDesign(style);
  if (design.tier === 'standard') return true;
  if (opts.isVip) return true;
  return hasPurchasedCardBack(design.id, opts.owned ?? []);
}

/**
 * Does this list of feature_purchases rows contain a purchase of this design?
 *
 * Separate from isCardBackUnlocked, and exported, because the interesting case
 * is invisible through that function: it answers `true` for the free designs
 * before it ever looks at purchases, so the junk-handling below cannot be
 * observed there and a test of it passes whether the guard exists or not.
 *
 * The guard matters because purchases are recorded under a legacy store id
 * (`gold`, `navy`) as well as a canonical one, so the comparison has to
 * normalise — and normalizeCardBack answers `classic_blue` for ANYTHING. One
 * malformed row would otherwise read as owning classic_blue.
 */
export function hasPurchasedCardBack(
  style: string | undefined | null,
  owned: readonly string[]
): boolean {
  const id = normalizeCardBack(style);
  return owned.some((o) => isKnownCardBackId(o) && normalizeCardBack(o) === id);
}

/**
 * The URL of a card back's artwork.
 *
 * This lives in TS and not in CardImage.css for the same reason every card FACE
 * already resolves through MEDIA_BASE: the stylesheet's twelve
 * `url('/cards/backs/table/<id>.webp')` declarations were ROOT-relative, and
 * Club Arena is served from `/hub/club-arena/`. Every one of them 404'd in
 * production, so each back fell through to the bare `--cb-gradient` — a dark
 * navy rectangle that on dark felt reads as an empty outline, which is what
 * "their card backs should be visible" was reporting.
 *
 * CSS also cannot follow MEDIA_BASE anywhere else: the whole point of Phase
 * U5.3 is that media may be served from an R2 bucket on another origin, and a
 * hardcoded `url()` cannot know that.
 */
export function cardBackImageUrl(style: string | undefined | null): string {
  return `${MEDIA_BASE}cards/backs/table/${normalizeCardBack(style)}.webp`;
}

export function CardBack({ style, size = 'md', className = '' }: CardBackProps) {
  const sizeClass = SIZE_CLASSES[size];
  const backStyle = normalizeCardBack(style);
  const classes = ['card-image', 'card-image--back', sizeClass, className]
    .filter(Boolean)
    .join(' ');

  return (
    <div className={classes}>
      <div
        className={`card-back card-back--${backStyle}`}
        style={{ '--cb-image': `url('${cardBackImageUrl(backStyle)}')` } as React.CSSProperties}
      />
    </div>
  );
}

export default CardImage;
