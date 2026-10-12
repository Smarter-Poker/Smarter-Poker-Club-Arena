/**
 * Playing-card FACE finishes.
 *
 * A face deck is deliberately presentation-only. Rank, suit and the choice of
 * the authoritative 2-color/4-color image stay owned by CardImage; these ids
 * only select the edge, stock and foil treatment painted around that image.
 */

export const FACE_DECK_IDS = [
  'house-classic',
  'broadcast-pro',
  'ivory-club',
  'midnight-foil',
  'carbon-edge',
  'royal-purple',
  'emerald-room',
  'crimson-signature',
  'platinum-line',
  'neon-circuit',
] as const;

export type FaceDeckId = (typeof FACE_DECK_IDS)[number];
export type FaceDeckTier = 'free' | 'premium';

export interface FaceDeckDesign {
  id: FaceDeckId;
  name: string;
  price: number;
  tier: FaceDeckTier;
  /** Short material description shown beside the real card-face preview. */
  finish: string;
}

export const DEFAULT_FACE_DECK_ID: FaceDeckId = 'house-classic';
export const FACE_DECK_DB_FIELD = 'face_deck_id' as const;
export const FACE_DECK_APPEARANCE_FIELD = 'faceDeckId' as const;

/**
 * One literal catalog, in product display order. Prices are diamond prices and
 * intentionally live beside the ids so client tiles cannot silently drift.
 * Checkout still verifies the matching server-owned feature_pricing row.
 */
export const FACE_DECK_CATALOG: readonly FaceDeckDesign[] = [
  {
    id: 'house-classic',
    name: 'House Classic',
    price: 0,
    tier: 'free',
    finish: 'Clean White Stock',
  },
  {
    id: 'broadcast-pro',
    name: 'Broadcast Pro',
    price: 0,
    tier: 'free',
    finish: 'High-Contrast Blue Edge',
  },
  {
    id: 'ivory-club',
    name: 'Ivory Club',
    price: 0,
    tier: 'free',
    finish: 'Warm Ivory Linen',
  },
  {
    id: 'midnight-foil',
    name: 'Midnight Foil',
    price: 75,
    tier: 'premium',
    finish: 'Navy Edge With Gold Foil',
  },
  {
    id: 'carbon-edge',
    name: 'Carbon Edge',
    price: 75,
    tier: 'premium',
    finish: 'Graphite Woven Edge',
  },
  {
    id: 'royal-purple',
    name: 'Royal Purple',
    price: 100,
    tier: 'premium',
    finish: 'Amethyst Enamel Line',
  },
  {
    id: 'emerald-room',
    name: 'Emerald Room',
    price: 100,
    tier: 'premium',
    finish: 'Emerald Lacquer Edge',
  },
  {
    id: 'crimson-signature',
    name: 'Crimson Signature',
    price: 125,
    tier: 'premium',
    finish: 'Crimson Hand-Finished Line',
  },
  {
    id: 'platinum-line',
    name: 'Platinum Line',
    price: 175,
    tier: 'premium',
    finish: 'Brushed Platinum Bevel',
  },
  {
    id: 'neon-circuit',
    name: 'Neon Circuit',
    price: 200,
    tier: 'premium',
    finish: 'Cyan And Magenta Circuit Edge',
  },
] as const;

const FACE_DECK_ID_SET = new Set<string>(FACE_DECK_IDS);

export function isFaceDeckId(value: unknown): value is FaceDeckId {
  return typeof value === 'string' && FACE_DECK_ID_SET.has(value);
}

/** Unknown, missing, or pre-feature rows always resolve to a real free deck. */
export function normalizeFaceDeckId(value: unknown): FaceDeckId {
  return isFaceDeckId(value) ? value : DEFAULT_FACE_DECK_ID;
}

export function faceDeckDesign(value: unknown): FaceDeckDesign {
  const id = normalizeFaceDeckId(value);
  return FACE_DECK_CATALOG.find((deck) => deck.id === id) ?? FACE_DECK_CATALOG[0];
}

export function faceDeckStorefrontFeature(value: unknown): string {
  return `studio:${FACE_DECK_DB_FIELD}:${normalizeFaceDeckId(value)}`;
}

/**
 * Composite looks predate face decks. Give each preset a deterministic finish
 * without changing table/card-back authority; the three free looks only use
 * the three free face decks.
 */
export const THEME_PRESET_FACE_DECKS: Readonly<Record<string, FaceDeckId>> = {
  'default-dark': 'house-classic',
  'classic-brown': 'ivory-club',
  'ocean-depths': 'broadcast-pro',
  'neon-blue': 'neon-circuit',
  'rustic-wood': 'midnight-foil',
  'casino-green': 'emerald-room',
  'crimson-club': 'crimson-signature',
  'arctic-suite': 'platinum-line',
  'amethyst-night': 'royal-purple',
  'carbon-ion': 'carbon-edge',
};

export function faceDeckForThemePreset(themeId: string | undefined | null): FaceDeckId {
  return (themeId && THEME_PRESET_FACE_DECKS[themeId]) || DEFAULT_FACE_DECK_ID;
}

/**
 * Immediate same-document runtime paint. Table roots can override this global
 * account default with their own data-face-deck attribute when several game
 * buckets are shown at once.
 */
export function applyFaceDeckToDocument(
  value: unknown,
  root: HTMLElement | null = typeof document === 'undefined' ? null : document.documentElement
): FaceDeckId {
  const id = normalizeFaceDeckId(value);
  if (root) root.dataset.faceDeck = id;
  return id;
}
