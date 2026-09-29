/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  The awarded bonus game, fetched while the wheel is still turning
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Every Donkey Cross, Mines, Crash and Plinko round starts on the wheel, and
 * the award opens its game as soon as the reveal finishes. Until this existed
 * the game's chunk was therefore fetched at the worst possible moment: with
 * the player already told what they had won and the page held on "Opening Your
 * Bonus Game" while ~125kB gzipped of scene code came down. The spin animation
 * ahead of it is seconds nobody is waiting on, so that is where the fetch
 * belongs.
 *
 * A LEAF MODULE, DELIBERATELY NOT PART OF ChunkPreloader. That module is the
 * app's boot-time route warmer: it holds a dynamic import of nearly every page
 * in the product, including TablePage and its megabyte of felt artwork. A
 * route page that imports it to warm ONE chunk takes on a runtime edge to the
 * whole map - which is invisible under Vite, where the warmer already sits in
 * the entry chunk, and very visible anywhere the page's real module graph is
 * bundled on its own (the Diamond Spins layout fixture does exactly that, and
 * went red with 49 unloadable .png imports out of src/assets/tableAssets.ts).
 * The same lesson as src/components/lobby/lateRegWindow.ts.
 *
 * Deliberately NOT gated on the connection class or on Data Saver, which is
 * what every preload in ChunkPreloader honours. This one is not speculative:
 * the award has been issued and the page is about to navigate to exactly this
 * chunk, so a metered player pays for it either way - a few seconds later,
 * with the reveal stopped on top of it.
 *
 * The specifiers are the ones App.tsx hands to lazyWithRetry, so Vite emits no
 * extra chunk and the browser module cache is shared with the navigation.
 */
import type { WheelBonusGame } from '../services/DiamondWheelService';

const DIAMOND_GAME_CHUNKS: Record<WheelBonusGame, () => Promise<unknown>> = {
  crossing: () => import('../pages/DiamondChoicePage'),
  mines: () => import('../pages/DiamondChoicePage'),
  crash: () => import('../pages/DiamondCrashPage'),
  plinko: () => import('../pages/DiamondPlinkoPage'),
};

/** Games warmed this session. Auto Spin can award the same game twice in a
 *  second, and the second result must not re-enter an import already in
 *  flight. */
const warmedGames = new Set<WheelBonusGame>();

/**
 * Called with whatever game the receipt names, which is nothing at all for
 * most prizes and, on a build older than the server, a game this app cannot
 * route (openBonus says so to the player). Both are simply not warmed.
 */
export function preloadDiamondGame(game: WheelBonusGame | undefined): void {
  if (!game || !(game in DIAMOND_GAME_CHUNKS)) return;
  if (warmedGames.has(game)) return;
  warmedGames.add(game);
  DIAMOND_GAME_CHUNKS[game]().catch(() => {
    /* A refused warm is not a failure: lazyWithRetry owns the real navigation
       and retries there, up to a cache-busting reload. Forget it, so the next
       award warms again instead of being disabled for the rest of the tab. */
    warmedGames.delete(game);
  });
}
