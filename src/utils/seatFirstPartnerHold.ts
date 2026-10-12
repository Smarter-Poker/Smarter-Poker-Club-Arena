/**
 * A HUMAN'S OPPONENT SEAT IS KEPT FOR PEOPLE FIRST (2026-10-04).
 *
 * Dan: "HEADS UP SIT N GO'S DID NOT WORK WHEN 2 HUMAN PLAYERS TRIED TO SIT
 * DOWN AND PLAY TOGETHER. IT JUST FROZE AND NEVER DEALT CARDS."
 *
 * The engine (TournamentRecurringService.seatFirstHumanPartnerHoldUntilMs)
 * keeps a seated player's open seats for other people until the later of the
 * board's own window (`start_time`) and 90 s after the first person sat,
 * never more than 350 s after it; then it fills them and the game deals.
 * This is the same rule, seen from the seat: the table names the wait and
 * counts it down instead of showing a felt that looks frozen.
 *
 * The page cannot know whether another person sat before the hero (who is a
 * horse is never sent to a client), so it measures from the hero's own seat
 * (table_seats.joined_at, or the moment this page bought it). If someone sat
 * earlier the engine's hold ends sooner, never later: the countdown is an
 * upper bound and the game can only deal early.
 */
export const SEAT_FIRST_PARTNER_HOLD_MS = 90_000;
export const SEAT_FIRST_PARTNER_HOLD_MAX_MS = 350_000;
/* The engine ends each board's hold somewhere in this spread after the
   rule's instant (SEAT_FIRST_HUMAN_PARTNER_HOLD_SPREAD_MS), so the opponent
   seat is never filled on the countdown's bell. The table counts down to the
   END of the spread, which is what makes "at the latest" true. */
export const SEAT_FIRST_PARTNER_HOLD_SPREAD_MS = 30_000;

/**
 * When the open seats stop being kept for people at the latest, in ms, or
 * -Infinity when nothing is known (no start time and no seat time).
 */
export function seatFirstPartnerHoldEndsAtMs(
  startTimeMs: number | null | undefined,
  heroSeatedAtMs: number | null | undefined
): number {
  const start =
    typeof startTimeMs === 'number' && Number.isFinite(startTimeMs) ? startTimeMs : -Infinity;
  if (typeof heroSeatedAtMs !== 'number' || !Number.isFinite(heroSeatedAtMs)) {
    return Number.isFinite(start) ? start + SEAT_FIRST_PARTNER_HOLD_SPREAD_MS : start;
  }
  return Math.min(
    heroSeatedAtMs + SEAT_FIRST_PARTNER_HOLD_MAX_MS,
    Math.max(start, heroSeatedAtMs + SEAT_FIRST_PARTNER_HOLD_MS) + SEAT_FIRST_PARTNER_HOLD_SPREAD_MS
  );
}

/** "1:05" - whole seconds, rounded up so it never reads 0:00 while waiting. */
export function seatFirstPartnerHoldClock(remainingMs: number): string {
  const total = Math.max(0, Math.ceil(remainingMs / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

/** The seat-first footer while the hold runs. */
export function seatFirstPartnerHoldLabel(openSeats: number): string {
  return openSeats > 1
    ? `Seat Reserved, Holding ${openSeats} Seats For Other Players`
    : 'Seat Reserved, Holding The Other Seat For A Player';
}

/** The status line beside it: when the game deals at the latest. */
export function seatFirstPartnerHoldStatus(remainingMs: number): string {
  return `Deals In ${seatFirstPartnerHoldClock(remainingMs)} At The Latest`;
}
