/**
 * The public arena record: `player_stats` is one row per (user, club) and is
 * readable by every signed-in player by policy. The dossier shows one line
 * across every club, so the rows are folded here.
 *
 * Pure and exported so the weighting is unit-tested without the page.
 */

const num = (v: unknown): number => {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
};

/** Aggregated across every club: player_stats is one row per (user, club). */
export interface ArenaRecord {
  hands: number;
  vpip: number;
  pfr: number;
  tournamentsPlayed: number;
  tournamentsWon: number;
  clubs: number;
}

/**
 * Weighted by hands so a 22-hand club at 85% VPIP does not outvote a
 * 279-hand club at 44%. Exported for the unit test.
 */
export function aggregateArenaRecord(
  rows: Array<{
    hands_played?: unknown;
    vpip?: unknown;
    pfr?: unknown;
    tournaments_played?: unknown;
    tournaments_won?: unknown;
  }>
): ArenaRecord {
  let hands = 0;
  let vpipWeighted = 0;
  let pfrWeighted = 0;
  let tournamentsPlayed = 0;
  let tournamentsWon = 0;
  let clubs = 0;
  for (const r of rows || []) {
    const h = num(r.hands_played);
    clubs += 1;
    hands += h;
    vpipWeighted += num(r.vpip) * h;
    pfrWeighted += num(r.pfr) * h;
    tournamentsPlayed += num(r.tournaments_played);
    tournamentsWon += num(r.tournaments_won);
  }
  return {
    hands,
    vpip: hands > 0 ? vpipWeighted / hands : 0,
    pfr: hands > 0 ? pfrWeighted / hands : 0,
    tournamentsPlayed,
    tournamentsWon,
    clubs,
  };
}
