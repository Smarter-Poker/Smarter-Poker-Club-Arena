import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const premium = readFileSync('src/components/table/PremiumCard.tsx', 'utf8');
const replay = readFileSync('src/components/replay/HandReplay3D.tsx', 'utf8');

describe('every card surface uses the canonical Table Studio card-back catalog', () => {
  it('renders PremiumCard faces and backs through the shared components', () => {
    expect(premium).toContain('<CardImage');
    expect(premium).toContain('<CardBack');
    expect(premium).toContain('normalizeCardBack(deckTheme)');
    expect(premium).not.toContain('cards/backs/classic.webp');
    expect(premium).not.toContain('DECK_THEMES');
  });

  it('loads the real Carbon Fiber artwork in the Three.js replay', () => {
    expect(replay).toContain('cards/backs/table/carbon.webp');
    expect(replay).not.toContain('cards/backs/carbon.webp');
  });
});
