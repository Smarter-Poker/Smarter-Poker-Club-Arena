/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE ARENA YOU CAME FROM IS THE ASSET YOU ARE SHOWN (Phase 10, line 1)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The Diamond Arena's footer opens the stats page as /stats?club=diamond-arena;
 * every other door opens it with no club or with a chip club. The page reads
 * every figure in the asset this returns, so a player in the arena sees the
 * hands they played in Diamonds and never their chip figures under the
 * Diamond footer. `scopedKey` keys the page's caches by the asset, so neither
 * asset can be served from the other's cache; the chip keys are what they
 * always were.
 */
import { useCallback } from 'react';
import { useLocation } from 'react-router-dom';
import { CHIP_STATS, DIAMOND_STATS, type StatsScope } from '../../services/statsScope';
import { readClubContextParam } from '../../utils/clubScopedPath';
import { isDiamondArenaClubKey } from '../../lib/constants';

/** Diamonds when the page was opened from the Diamond Arena, chips otherwise. */
export function statsScopeForSearch(search: string): StatsScope {
  return isDiamondArenaClubKey(readClubContextParam(search)) ? DIAMOND_STATS : CHIP_STATS;
}

export interface ArenaStatsScope {
  scope: StatsScope;
  scopedKey: (key: string) => string;
  eyebrow: string;
}

export function useArenaStatsScope(): ArenaStatsScope {
  const location = useLocation();
  const scope = statsScopeForSearch(location.search);
  const scopedKey = useCallback(
    (key: string) => (scope === CHIP_STATS ? key : `${scope}:${key}`),
    [scope]
  );
  return {
    scope,
    scopedKey,
    eyebrow:
      scope === DIAMOND_STATS
        ? 'Diamond Arena // Player Analytics In Diamonds'
        : 'Club Arena // Player Analytics',
  };
}
