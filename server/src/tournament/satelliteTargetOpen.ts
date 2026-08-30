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
}

/**
 * True only when a seat can genuinely be taken in the target: registration is
 * open (before the start, or during late registration) AND there is room.
 */
export function isSatelliteTargetOpen(target: SatelliteTargetState | null): boolean {
  if (!target) return false;

  const status = (target.status || '').toUpperCase();
  const hasRoom =
    !target.max_players || Number(target.current_players ?? 0) < Number(target.max_players);
  if (!hasRoom) return false;

  if (status === 'ANNOUNCED' || status === 'REGISTERING') return true;

  if (status === 'RUNNING') {
    const cap = Number(target.late_reg_levels ?? target.rebuy_levels ?? 0);
    const level = Number(target.current_level ?? 0);
    return cap > 0 && level <= cap;
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
