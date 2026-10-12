/**
 * A club card's geometry is decided by CSS that is on the page before the card
 * mounts. It never waits on a picture, a chunk or a late stylesheet.
 *
 * Dan, 2026-10-04, on an iPhone: "WHEN YOU GO TO THE CLUB LOBBY, THE IMAGES ARE
 * DISPLAYED LIKE THIS AT FIRST, AND EVENTUALLY GO BACK TO NORMAL, BUT THIS BUG
 * NEEDS TO BE FIXED, IT MAKES US LOOK BROKEN."
 *
 * The Shark Club card printed its head correctly and, under it, its cover art
 * at natural size (896x1200): hundreds of pixels tall, upscaled and cropped
 * only by the carousel slot. A moment later it snapped back to a square.
 *
 * CAUSE. CarouselSection loaded ClubCardPanel and DiamondArenaCard through
 * two lazy imports, and BOTH import ClubCardPanel.css. The lobby mounts the
 * Diamond Arena card and a club card in the same render pass, so the two
 * dynamic imports start together with one stylesheet in both dependency
 * lists. Vite's preload helper waits for a stylesheet only in the call that
 * creates its <link>; the other call finds the dependency already registered
 * and resolves immediately. That card rendered while the sheet was still on
 * the wire, so its art well had no aspect-ratio, no clip and no width on the
 * <img>. The head was fine because SpadeConsole.css is a static import of
 * HomePage.
 *
 * FIX. The cards are static imports of CarouselSection, so ClubCardPanel.css
 * is part of the page's own stylesheet and is applied before the page renders.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import CarouselSection, { type UserClub } from '../../src/components/home/CarouselSection';
import { resetLobbyFigureCacheForTests } from '../../src/lib/lobbyFigureCache';

vi.mock('../../src/lib/supabase', () => ({
  supabase: { rpc: vi.fn(async () => ({ data: null, error: null })) },
}));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: vi.fn() }));
vi.mock('../../src/services/HapticService', () => ({
  default: { light: vi.fn(), success: vi.fn() },
}));
vi.mock('../../src/utils/playPremiumSfx', () => ({ playPremiumSfx: vi.fn() }));
vi.mock('../../src/utils/ChunkPreloader', () => ({ preloadClubLobby: vi.fn() }));

const root = resolve(__dirname, '../..');
const read = (rel: string) => readFileSync(resolve(root, rel), 'utf8');

const section = read('src/components/home/CarouselSection.tsx');
const cardCss = read('src/components/club/ClubCardPanel.css');

/** Comments describe the old lazy imports on purpose; assert on code only. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/** The declarations of the first rule whose selector list is exactly `selector`. */
function ruleBody(css: string, selector: string): string {
  const bare = stripComments(css);
  // A selector list is one selector per line in the sheet.
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/,\s*/g, ',\\s*');
  const match = new RegExp(`(?:^|})\\s*${escaped}\\s*{([^}]*)}`).exec(bare);
  if (!match) throw new Error(`No rule for ${selector}`);
  return match[1].replace(/\s+/g, ' ');
}

const CLUBS: UserClub[] = [
  {
    id: 'club-a',
    name: 'Shark Club',
    club_id: 25450,
    card_image_url: 'https://example.test/shark.jpg',
  },
  {
    id: 'club-b',
    name: 'Black Jack Society',
    club_id: 31337,
    card_image_url: 'https://example.test/society.jpg',
  },
];

function renderLobbyCarousel() {
  return render(
    <CarouselSection
      displayClubs={CLUBS}
      clubStats={{}}
      pinnedClubIds={[]}
      navigate={vi.fn()}
      handleContextMenu={vi.fn()}
      handleLongPressStart={vi.fn()}
      handleLongPressEnd={vi.fn()}
      onOpenJoinModal={vi.fn()}
      onOpenCreateModal={vi.fn()}
    />
  );
}

describe('a club card has its final geometry from the first paint', () => {
  beforeEach(() => {
    resetLobbyFigureCacheForTests();
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('the carousel never loads a card, or its stylesheet, through a dynamic import', () => {
    const code = stripComments(section);
    expect(code).not.toMatch(/import\s*\(/);
    expect(code).not.toMatch(/\blazy(WithRetry)?\s*\(/);
    expect(code).not.toContain('Suspense');
    expect(code).toMatch(/import\s*{\s*ClubCardPanel\s*}\s*from\s*'\.\.\/club\/ClubCardPanel';/);
    expect(code).toMatch(
      /import\s*{\s*DiamondArenaCard\s*}\s*from\s*'\.\.\/club\/DiamondArenaCard';/
    );
  });

  it('prints every card, art well included, in the very first render', () => {
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(390);
    renderLobbyCarousel();
    // No await and no waitFor on purpose: a card behind a lazy boundary is a
    // Suspense fallback here, and that is the window the stylesheet raced in.
    const items = Array.from(document.querySelectorAll('.sp-carousel__item'));
    expect(items.length).toBeGreaterThanOrEqual(2);
    for (const item of items) {
      const well = item.querySelector('.club-card-panel .club-card-viewport');
      expect(well).not.toBeNull();
      expect(well?.querySelector('img.club-card-viewport-img')).not.toBeNull();
    }
  });

  it('the art well is a clipped square whose size owes nothing to the image', () => {
    const well = ruleBody(cardCss, '.club-card-viewport');
    expect(well).toMatch(/width:\s*100%;/);
    expect(well).toMatch(/aspect-ratio:\s*1 \/ 1;/);
    expect(well).toMatch(/overflow:\s*hidden;/);
    // An image that has not arrived shows the console glass, nothing else.
    expect(well).toMatch(/background:\s*#0a0b0d;/);
  });

  it('the image fills the well and is cut to it, whatever its natural size', () => {
    const both = ruleBody(cardCss, '.club-card-viewport-img, .club-card-viewport-logo');
    expect(both).toMatch(/width:\s*100%;/);
    expect(both).toMatch(/height:\s*100%;/);
    expect(ruleBody(cardCss, '.club-card-viewport-img')).toMatch(/object-fit:\s*cover;/);
    expect(ruleBody(cardCss, '.club-card-viewport-logo')).toMatch(/object-fit:\s*contain;/);
  });

  it('the stylesheet that sizes the well is a static import of both cards', () => {
    for (const rel of [
      'src/components/club/ClubCardPanel.tsx',
      'src/components/club/DiamondArenaCard.tsx',
    ]) {
      expect(stripComments(read(rel))).toContain("import './ClubCardPanel.css';");
    }
  });
});
