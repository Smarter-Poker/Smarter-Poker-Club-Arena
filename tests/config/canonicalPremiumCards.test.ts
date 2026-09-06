import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const premium = readFileSync('src/components/table/PremiumCard.tsx', 'utf8');

describe('every card surface uses the canonical Table Studio card-back catalog', () => {
  it('renders PremiumCard faces and backs through the shared components', () => {
    expect(premium).toContain('<CardImage');
    expect(premium).toContain('<CardBack');
    expect(premium).toContain('normalizeCardBack(deckTheme)');
    expect(premium).not.toContain('cards/backs/classic.webp');
    expect(premium).not.toContain('DECK_THEMES');
  });

  /**
   * The Three.js replay used to be pinned here for the same reason: it loaded
   * a card back by path and had once loaded it from the wrong directory.
   *
   * PHASE 4 2026-09-05 retired it. `HandReplay3D` was the felt behind the
   * platform's SECOND hand replayer on `/share/hand/:handId`; that page opens
   * the same `HandReplay` as the table and the archive now, and every card on
   * it is drawn by `CardImage` / `CardBack` - the shared components the first
   * assertion above pins. The pin becomes "it is gone", so nothing quietly
   * reinstates a card surface with its own artwork paths.
   */
  it('has no second replay drawing card backs by path of its own', () => {
    expect(existsSync('src/components/replay/HandReplay3D.tsx')).toBe(false);
  });
});
