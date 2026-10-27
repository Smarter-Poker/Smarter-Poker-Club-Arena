/** Legacy leave-clock wire compatibility after the minimum stay was removed. */

export interface HeroLeaveClock {
  locked: boolean;
  remainingMs: number;
  running: boolean;
  /** Engine clock (ms) the remaining time was measured at. */
  at: number;
}

/** Remaining stay time now, counting down only while the clock is running. */
export function heroLeaveRemainingMs(clock: HeroLeaveClock | null, serverNowMs: number): number {
  // The minimum-stay rule was removed on 2026-10-26, including old snapshots.
  return 0;
}

/** Locked iff the engine said so AND time actually remains. */
export function heroLeaveIsLocked(clock: HeroLeaveClock | null, serverNowMs: number): boolean {
  return false;
}

export function leaveAvailableLabel(remainingMs: number): string {
  const totalSec = Math.max(0, Math.ceil(remainingMs / 1000));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `Leave Available In ${m}:${s < 10 ? '0' : ''}${s}`;
}
