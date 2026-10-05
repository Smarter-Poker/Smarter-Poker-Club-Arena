/**
 * The result card's trophy and medal metals, shared by the card (first paint)
 * and its share-image painter (loaded on demand). Kept apart from the painter
 * so importing the paths does not pull the painter into the entry chunk.
 */

export type ShareTier = 'gold' | 'silver' | 'bronze' | 'steel';

/** The card's trophy (PlacementTrophy), on its 48-unit grid. */
export const TROPHY_PATHS = {
  handleLeft: 'M13 10H8a1 1 0 0 0-1 1v3a8 8 0 0 0 7 7.94',
  handleRight: 'M35 10h5a1 1 0 0 1 1 1v3a8 8 0 0 1-7 7.94',
  cup: 'M13 7h22v11c0 6.08-4.92 11-11 11S13 24.08 13 18V7Z',
  base: 'M24 29v6M17 41h14a1 1 0 0 0 1-1v-1a4 4 0 0 0-4-4h-8a4 4 0 0 0-4 4v1a1 1 0 0 0 1 1Z',
} as const;
