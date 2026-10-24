/**
 * THE PAGE-LEVEL CASH ORDER (the Sort By sheet), as one pure comparator.
 *
 * Dan 2026-10-23: "WHEN YOU HAVE THE STAKES HIGH TO LOW OR LOW TO HIGH AND
 * MULTIPE GAME VARIATIONS SELECTED, IT SHOULD DISPLAY ALL THE 1/2 GAMES FIRST.
 * PLO, THEN PLO5, THEN PLO6 AND THEN PLO8 AND THEN DO THE .50/1.00 GAME SAME
 * WAY..." and 2026-09-03: "game variations are never to be mixed together."
 *
 * The heading sort inside LobbyTable already obeyed that on the Hold'em,
 * Omaha and Limit tabs. This comparator is the order the ALL tab renders
 * (LobbyTable keeps it, having no default heading there), and it used to
 * break a stakes tie by variant on the Omaha tab only - so on ALL a 1/2 NLH,
 * a 1/2 PLO and a 1/2 Short Deck were interleaved by player count. A stakes
 * sort now breaks every tie with the same canonical rank LobbyTable uses
 * (NLH, Pineapple, Short Deck, PLO, PLO5, PLO6, PLO8, FLH, FLO, FLO8), on
 * every tab. The other sorts keep the Omaha tab's variant grouping exactly
 * as before.
 */
import { variantRank, UNLISTED_VARIANT_RANK } from './variantRank';
import { variantDisplay } from './lobbyEntries';
import { variantKey } from './advancedFilterSpec';
import { stakesSortValue } from '../../lib/bettingStructure';

export type CashBoardSortKey =
  | 'recommended'
  | 'stakes_high'
  | 'stakes_low'
  | 'players'
  | 'starting_soon';

export interface CashBoardRow {
  big_blind?: number | string | null;
  current_players?: number | null;
  name?: string | null;
  game_variant?: string | null;
}

/* The stakes a row prints (see stakesSortValue): a fixed-limit "1/2" is
   ordered with every other "1/2", not half a level below it. */
const bb = (t: CashBoardRow) => stakesSortValue(Number(t.big_blind) || 0, t.game_variant);
/* Fold legacy spellings (`plo`, `limit_holdem`, `hilo`) through the filter's
   own key first, so a row is ranked as the game the Variant chips call it. */
const label = (t: CashBoardRow) => {
  const raw = t.game_variant ?? '';
  return variantDisplay(variantKey(raw) || raw || undefined).short;
};

/** The canonical variant order, unlisted games after every known one by name. */
export function compareCanonicalVariant(a: CashBoardRow, b: CashBoardRow): number {
  const la = label(a);
  const lb = label(b);
  const ra = variantRank({ gameLabel: la });
  const rb = variantRank({ gameLabel: lb });
  if (ra !== rb) return ra - rb;
  return ra === UNLISTED_VARIANT_RANK ? la.localeCompare(lb) : 0;
}

export function cashBoardComparator(
  sortKey: CashBoardSortKey | string,
  gameType: string
): (a: CashBoardRow, b: CashBoardRow) => number {
  const cmpStakes = (a: CashBoardRow, b: CashBoardRow) => bb(b) - bb(a);
  const cmpStakesLow = (a: CashBoardRow, b: CashBoardRow) => bb(a) - bb(b);
  const cmpPlayers = (a: CashBoardRow, b: CashBoardRow) =>
    (b.current_players || 0) - (a.current_players || 0);
  const cmpName = (a: CashBoardRow, b: CashBoardRow) => (a.name || '').localeCompare(b.name || '');
  /* The non-stakes sorts group variants on the Omaha tab only, as they always
     have: Hold'em and Limit get their grouping from LobbyTable's heading sort,
     and ALL under Recommended or Most Players is a flat list by design. */
  const cmpVariant = (a: CashBoardRow, b: CashBoardRow) =>
    gameType === 'OMAHA' ? compareCanonicalVariant(a, b) : 0;

  switch (sortKey) {
    case 'stakes_high':
      return (a, b) =>
        cmpStakes(a, b) || compareCanonicalVariant(a, b) || cmpPlayers(a, b) || cmpName(a, b);
    case 'stakes_low':
      return (a, b) =>
        cmpStakesLow(a, b) || compareCanonicalVariant(a, b) || cmpPlayers(a, b) || cmpName(a, b);
    case 'players':
    case 'starting_soon':
      return (a, b) => cmpVariant(a, b) || cmpPlayers(a, b) || cmpStakes(a, b) || cmpName(a, b);
    case 'recommended':
    default:
      return (a, b) => cmpVariant(a, b) || cmpStakes(a, b) || cmpPlayers(a, b) || cmpName(a, b);
  }
}
