/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  THE AWARDED GAME IS FETCHED WHILE THE WHEEL IS STILL TURNING (2026-09-22)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Every Donkey Cross, Mines, Crash and Plinko round starts on the wheel, and
 * the award opens its game the moment the reveal finishes. Until this warm
 * existed the game's chunk was fetched at the worst possible moment: after the
 * player had been told they won, with the page held on "Opening Your Bonus
 * Game" while ~125kB gzipped of scene code arrived.
 *
 * The warm is unlike every preload in ChunkPreloader, and these pin why. It is
 * not a bet on bandwidth - the award is issued and the page is about to
 * navigate to exactly this chunk - so it is not gated on Data Saver or on the
 * connection class, and a refusal is forgotten rather than remembered. It also
 * lives in its own leaf module, so warming one chunk from a route page does
 * not link that page to the warmer's map of every page in the product.
 *
 * Every page module below is mocked to FAIL, which is what a stale deploy does
 * and what a warm has to survive. It is also the only way to count import
 * attempts: a module that resolves is cached by the loader after the first
 * one, exactly as a browser caches a chunk it already has.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const loaded = vi.hoisted(() => ({ choice: 0, crash: 0, plinko: 0 }));
const missing = () => new Error('Failed to fetch dynamically imported module');
vi.mock('../../src/pages/DiamondChoicePage', () => {
  loaded.choice++;
  throw missing();
});
vi.mock('../../src/pages/DiamondCrashPage', () => {
  loaded.crash++;
  throw missing();
});
vi.mock('../../src/pages/DiamondPlinkoPage', () => {
  loaded.plinko++;
  throw missing();
});

const ROOT = join(__dirname, '..', '..');
const read = (file: string) => readFileSync(join(ROOT, file), 'utf8');
const flush = () => new Promise((done) => setTimeout(done, 0));

let preloadDiamondGame: (typeof import('../../src/utils/diamondGamePreload'))['preloadDiamondGame'];
beforeEach(async () => {
  loaded.choice = 0;
  loaded.crash = 0;
  loaded.plinko = 0;
  // The module remembers what it has warmed, so each case gets a fresh session.
  vi.resetModules();
  ({ preloadDiamondGame } = await import('../../src/utils/diamondGamePreload'));
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the wheel warms the game it has just awarded', () => {
  it.each([['crossing'], ['mines']] as const)(
    '%s warms the choice page, which is the page its route renders',
    async (game) => {
      preloadDiamondGame(game);
      await flush();
      expect(loaded).toEqual({ choice: 1, crash: 0, plinko: 0 });
    }
  );

  it('crash warms the crash page', async () => {
    preloadDiamondGame('crash');
    await flush();
    expect(loaded).toEqual({ choice: 0, crash: 1, plinko: 0 });
  });

  it('plinko warms the plinko page', async () => {
    preloadDiamondGame('plinko');
    await flush();
    expect(loaded).toEqual({ choice: 0, crash: 0, plinko: 1 });
  });

  it('warms the exact modules App lazy-loads, so no second chunk is emitted', () => {
    const app = read('src/App.tsx');
    const preloader = read('src/utils/diamondGamePreload.ts');
    for (const page of ['DiamondChoicePage', 'DiamondCrashPage', 'DiamondPlinkoPage']) {
      expect(app).toContain(`import('./pages/${page}')`);
      expect(preloader).toContain(`import('../pages/${page}')`);
    }
  });

  it('is a leaf, so warming one chunk does not link the whole route map', () => {
    /**
     * ChunkPreloader is the boot-time warmer and holds a dynamic import of
     * nearly every page, TablePage and its felt artwork included. Importing it
     * from a route page for ONE warm is free under Vite, where it already sits
     * in the entry chunk, and not free anywhere the page's own module graph is
     * bundled: tests/e2e/helpers/diamond-wheel-page-fixture.mjs esbuilds
     * exactly that graph, and it died on 49 unloadable .png imports out of
     * src/assets/tableAssets.ts, reached through TablePage.
     */
    const value = read('src/utils/diamondGamePreload.ts')
      .split('\n')
      .filter((line) => line.startsWith('import ') && !line.startsWith('import type '));
    expect(value).toEqual([]);
    const page = read('src/pages/DiamondWheelPage.tsx');
    expect(page).toContain("from '../utils/diamondGamePreload'");
    expect(page).not.toContain("from '../utils/ChunkPreloader'");
  });

  it('imports once when two results in a row name the same game', async () => {
    // Auto Spin can award the same game twice within a second, and the second
    // result must not re-enter an import that is still in flight.
    preloadDiamondGame('plinko');
    preloadDiamondGame('plinko');
    await flush();
    expect(loaded.plinko).toBe(1);
  });

  it('swallows a chunk that will not load, and stays armed for the next award', async () => {
    expect(() => preloadDiamondGame('plinko')).not.toThrow();
    await flush();
    expect(loaded.plinko).toBe(1);
    // A failed warm must not disable warming for the rest of the session.
    preloadDiamondGame('plinko');
    await flush();
    expect(loaded.plinko).toBe(2);
  });

  it('warms nothing for an award this build cannot route', async () => {
    preloadDiamondGame(undefined);
    preloadDiamondGame('roulette' as never);
    await flush();
    expect(loaded).toEqual({ choice: 0, crash: 0, plinko: 0 });
  });

  it('warms on Data Saver too, because that page is about to open anyway', async () => {
    vi.stubGlobal('navigator', { connection: { saveData: true, effectiveType: '2g' } });
    preloadDiamondGame('crash');
    await flush();
    expect(loaded.crash).toBe(1);
  });
});
