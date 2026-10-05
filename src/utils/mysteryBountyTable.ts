/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  THE TABLE'S VIEW OF A MYSTERY BOUNTY EVENT (2026-10-05)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Three small rules TablePage applies, kept pure here so they can be tested
 * without mounting a 28,000-line page.
 *
 *   1. WHEN THE CHESTS GO LIVE, THE TABLE IS TOLD. The engine broadcasts
 *      `mystery_bounty_activated` once per event; only the lobby listened, so a
 *      player at the felt learned the phase had changed from the first chest.
 *      The table now raises one popup per event per mounted table.
 *
 *   2. A SEAT DOES NOT ADVERTISE A HEAD THAT IS NO LONGER THE PRIZE. Once the
 *      chests are live a knockout draws a chest, not the flat head still
 *      stored on `tournament_players.current_bounty`. The badge reads as a
 *      mystery prize instead of the stale figure.
 *
 *   3. THE BADGES ARE RE-READ WHEN THE SEATS CHANGE. `tournament_players` is
 *      not in the realtime publication, so the old UPDATE listener never fired
 *      and a player balanced in from another table showed no head (or a stale
 *      one) for up to the 30-second refresh. The seat list the engine already
 *      pushes is the trigger: when the set of players changes, re-read.
 */

/** The popup raised at the table when the chests open. Title Case, no dash. */
export const MYSTERY_BOUNTIES_LIVE_TEXT = 'Mystery Bounties Are Now Live';

/**
 * Should this table announce that the chests are live? True exactly once per
 * event for the given `seen` set (one set per mounted table page).
 */
export function claimMysteryLiveAnnouncement(
  seen: Set<string>,
  tournamentId: string | null | undefined
): boolean {
  const key = String(tournamentId ?? '').trim();
  if (!key || seen.has(key)) return false;
  seen.add(key);
  return true;
}

/** Is the chest phase open, as the tournament row reports it? */
export function mysteryChestsLiveFromRow(
  row: { is_mystery_bounty?: unknown; mystery_bounty_stage?: unknown } | null | undefined
): boolean {
  return Boolean(row?.is_mystery_bounty) && String(row?.mystery_bounty_stage ?? '') === 'active';
}

export interface SeatBountyBadge {
  /** The flat head to print, or undefined for none. */
  value: number | undefined;
  /** True while the chests are live: the prize is a mystery, not the head. */
  mystery: boolean;
}

/** What a seat's bounty badge shows. */
export function seatBountyBadge(input: {
  isBountyTournament: boolean;
  mysteryChestsLive: boolean;
  playerId: string | null | undefined;
  playerStatus?: string | null;
  bountyMap: Record<string, number> | null | undefined;
}): SeatBountyBadge {
  if (!input.isBountyTournament || !input.playerId) return { value: undefined, mystery: false };
  if (input.mysteryChestsLive) {
    // An eliminated player cannot be knocked out again; no prize hangs on them.
    const out = String(input.playerStatus ?? '').toLowerCase() === 'eliminated';
    return { value: undefined, mystery: !out };
  }
  return { value: input.bountyMap?.[input.playerId], mystery: false };
}

/**
 * A stable signature of who is seated, so a change in the seat list (a player
 * balanced in, a seat vacated) can trigger one bounty re-read.
 */
export function seatedPlayersSignature(
  players: ReadonlyArray<{ id?: unknown } | null | undefined> | null | undefined
): string {
  return (players ?? [])
    .map((p) => (p && p.id != null ? String(p.id) : ''))
    .filter((id) => id.length > 0)
    .sort()
    .join(',');
}
