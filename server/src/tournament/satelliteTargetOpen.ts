/**
 * Can a satellite winner actually be seated into the target right now?
 *
 * Extracted 2026-08-30 for the same reason `satelliteAwardPlan.ts` was: the
 * answer decides whether real chips move as a SEAT or as CASH, and it used to
 * live inline in `processSatelliteAwards`, a method that needs four Supabase
 * round trips and a running tournament to enter. That is why it carried a
 * money bug for as long as it did with nothing failing.
 *
 * Two things were wrong, and they compounded:
 *
 *  1. Only ANNOUNCED/REGISTERING counted as open. But a satellite normally
 *     ENDS AFTER the event it feeds has started — that is the shape of a
 *     satellite, not an edge case — so every one of them judged its target
 *     closed and cashed the tickets out, with late registration standing wide
 *     open. Observed live: target at level 6 of 12 late-reg levels, 109 of
 *     1000 seats filled, winners paid cash instead of being seated.
 *
 *  2. The ticket was priced off the target ROW EXISTING rather than off it
 *     being enterable, while every consumer assumed the opposite. A closed
 *     target produced a full-price ticket and the full advertised seat count,
 *     then paid those seats out as cash the satellite had never collected:
 *     15 completed satellites took in 3,325.50 and paid out 6,908.00.
 *
 * A third was found on 2026-08-31, in the fix for the first: this gate said
 * `level <= cap` where `current_level` is a ZERO-BASED index, so it stayed
 * open for one level after fn_register_for_tournament, process_tournament_rebuy
 * and TournamentManagerBase had all closed; and it never looked at
 * `prize_pool_finalized` at all, which is the flag that says the payout ladder
 * has been sized. `fn_award_satellite_seat` carried both defects identically
 * and was corrected in the same commit
 * (supabase/migrations/20260831210000_a_satellite_seat_closes_when_every_other_door_closes.sql).
 */

export interface SatelliteTargetState {
  status: string | null;
  /** Level the target is currently playing. */
  current_level?: number | null;
  /** Levels late registration stays open for. `rebuy_levels` is the fallback
   *  the rest of the tournament code already uses when it is unset. */
  late_reg_levels?: number | null;
  rebuy_levels?: number | null;
  current_players?: number | null;
  max_players?: number | null;
  /** The platform's single statement that the pool has stopped moving. Once it
   *  is true `fn_register_for_tournament` refuses every entry and
   *  `isLateRegClosed()` returns true regardless of level, because the payout
   *  ladder has been sized against the pool as it stands. */
  prize_pool_finalized?: boolean | null;
}

/**
 * True only when a seat can genuinely be taken in the target: registration is
 * open (before the start, or during late registration) AND there is room.
 */
export function isSatelliteTargetOpen(target: SatelliteTargetState | null): boolean {
  if (!target) return false;

  /* A FINALIZED POOL IS A CLOSED DOOR (2026-08-31). This is checked before the
     status and before the level because it outranks both: `start()` sets it
     immediately for an event with no late-reg window at all, and
     `finalizeAfterAddOn()` sets it at the end of the add-on window, which can
     be later than the late-reg cap. Seating a satellite winner after it is set
     adds a buy-in to a prize pool the payout ladder was already computed
     from. */
  if (target.prize_pool_finalized) return false;

  const status = (target.status || '').toUpperCase();
  const hasRoom =
    !target.max_players || Number(target.current_players ?? 0) < Number(target.max_players);
  if (!hasRoom) return false;

  if (status === 'ANNOUNCED' || status === 'REGISTERING') return true;

  if (status === 'RUNNING') {
    const cap = Number(target.late_reg_levels ?? target.rebuy_levels ?? 0);
    /* `current_level` is a ZERO-BASED INDEX into blind_structure, so a cap of N
       covers indices 0..N-1 and index N is the first level past the window.
       This was `level <= cap`, which held the door open for one extra level
       after every other reader in the codebase had shut it:
       fn_register_for_tournament, process_tournament_rebuy,
       TournamentManagerBase.isLateRegClosed, TournamentInfoPanel and
       TournamentDetails all close on `>=`. A satellite winner could therefore
       be seated into an event that had been refusing direct buy-ins for a
       whole level. See tests/unit/currentLevelIsAnIndex.test.ts for the rule
       itself. */
    const level = Number(target.current_level ?? 0);
    return cap > 0 && level < cap;
  }

  // COMPLETED, COMPLETING, CANCELLED: nothing to enter.
  return false;
}

/**
 * What one seat is worth to this satellite.
 *
 * Zero when the seat cannot be awarded — a ticket that cannot be spent is not
 * worth its face value, and pricing it as though it were is what let a
 * 108-chip pool pay out 1,000. `planSatelliteAwards` gates on `ticketCost > 0`,
 * so zero here is what makes the pool fall through to the cash path and the
 * satellite pay out exactly what it collected, never more.
 */
export function satelliteTicketCost(
  target: { buy_in_amount?: number | null; buy_in_fee?: number | null } | null,
  targetOpen: boolean
): number {
  if (!target || !targetOpen) return 0;
  const raw = Number(target.buy_in_amount || 0) + Number(target.buy_in_fee || 0);
  return Math.max(0, Math.round(raw * 100) / 100);
}
