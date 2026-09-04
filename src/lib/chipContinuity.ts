/**
 * CHIP CONTINUITY - client copy (Operation Table Stakes, Slice 0).
 *
 * The server owns the stay clock (cash_player_session in Postgres, mirrored
 * by the engine). The client renders what the engine sends: a remaining time
 * as of the engine's clock, and whether it is counting. These helpers turn
 * that into the one label the leave control is allowed to show.
 *
 * The only copy a player sees while locked is "Leave Available In M:SS".
 * No reason, no paragraph, no forbidden words (OPORD 1.3 section 6.1).
 */

export interface HeroLeaveClock {
  locked: boolean;
  remainingMs: number;
  running: boolean;
  /** Engine clock (ms) the remaining time was measured at. */
  at: number;
}

/** Remaining stay time now, counting down only while the clock is running. */
export function heroLeaveRemainingMs(clock: HeroLeaveClock | null, serverNowMs: number): number {
  if (!clock) return 0;
  if (!clock.running) return Math.max(0, clock.remainingMs);
  return Math.max(0, clock.remainingMs - Math.max(0, serverNowMs - clock.at));
}

/** Locked iff the engine said so AND time actually remains. */
export function heroLeaveIsLocked(clock: HeroLeaveClock | null, serverNowMs: number): boolean {
  return !!clock?.locked && heroLeaveRemainingMs(clock, serverNowMs) > 0;
}

export function leaveAvailableLabel(remainingMs: number): string {
  const totalSec = Math.max(0, Math.ceil(remainingMs / 1000));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `Leave Available In ${m}:${s < 10 ? '0' : ''}${s}`;
}
