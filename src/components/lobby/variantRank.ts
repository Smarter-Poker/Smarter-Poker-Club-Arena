/**
 * THE ORDER OF THE GAMES (Dan 2026-09-03): "NLH SHOULD BE NO LIMIT, PINEAPPLE
 * AND SHORT DECK, PLO SHOULD BE PLO, PLO5, PLO6, PLO8o ... game variations are
 * never to be mixed together." This is the canonical rank by the lobby's
 * short game label; anything unlisted sorts after the known ones, by name.
 *
 * Its own module (2026-10-24) so the page-level Sort By comparator
 * (cashBoardOrder.ts) and LobbyTable rank variants from ONE table rather than
 * two copies that can drift. LobbyTable re-exports both names.
 */
export const VARIANT_RANK: Readonly<Record<string, number>> = {
  NLH: 0,
  PNPL: 1,
  '6+': 2,
  PLO: 10,
  PLO5: 11,
  PLO6: 12,
  PLO8: 13,
  FLH: 20,
  FLO: 21,
  FLO8: 22,
};

/** The rank every game missing from VARIANT_RANK shares; ties then break by name. */
export const UNLISTED_VARIANT_RANK = 40;

export function variantRank(e: { gameLabel?: string | null }): number {
  return VARIANT_RANK[String(e.gameLabel || '').toUpperCase()] ?? UNLISTED_VARIANT_RANK;
}
