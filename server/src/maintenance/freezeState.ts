/**
 * THE PROCESS-WIDE FREEZE FLAG (Dan, 2026-09-01).
 *
 * "THE ENTIRE PLATFORM NEEDS TO FREEZE FOR THE 5 MINUTES ... HORSES SHOULD
 * NOT STAND UP OR ROTATE, EVERYTHING JUST FREEZES."
 *
 * One module-level boolean, set only by MaintenanceBreak, read by every
 * periodic sweep that moves money or seats. It exists because those sweeps
 * live in a dozen services that have no reference to the GameServer instance,
 * and threading a supplier through every constructor would touch far more
 * code than the guarantee needs.
 *
 * The flag is the ENGINE'S half of the freeze. The other half lives in
 * Postgres (fn_platform_frozen + the zz_freeze_guard triggers), because the
 * engine is dead for ~2 of the 5 minutes and pg_cron and browsers do not stop
 * when it does. The two halves are armed by the same row in
 * engine_maintenance_break, so they cannot disagree about whether a freeze is
 * running.
 *
 * Set from the ANNOUNCEMENT (:53), not the countdown (:55), deliberately: a
 * horse standing up at :54 while the felt says "Last Hand" is the same tell
 * as one standing up at :56, and no sweep this gates does anything that
 * cannot wait seven minutes.
 */

let frozen = false;

export function setMaintenanceFrozen(value: boolean): void {
  frozen = value;
}

/** True from the :53 announcement until the :00 resume. */
export function isMaintenanceFrozen(): boolean {
  return frozen;
}

/**
 * WHEN A STEP THE FREEZE DEFERRED IS DUE AGAIN (2026-09-11).
 *
 * A sweep that reaches seat movement while the platform is frozen must skip
 * it, and must also ask to come back: a tournament whose every table holds
 * one player deals no hand and records no bust, so nothing else will ever wake
 * its manager again. `$100 Freeroll 12:00 PM` (7aa16fa7) recorded its last
 * three busts at 07:47-07:57 UTC on 2026-09-11 - the last two inside the
 * 07:53 freeze - and then sat for hours as four players on four tables.
 *
 * The freeze runs from the :53 announcement to the :00 resume, so inside the
 * scheduled window the step is due just after the top of the hour. A freeze
 * observed outside that window (an overrun past :00, or one armed off
 * schedule) is re-checked on a short fixed cadence instead; the re-armed pass
 * finds it frozen again and asks again, so an overrun costs one read per
 * fifteen seconds and never a stranded event.
 */
export function msUntilMaintenanceResume(nowMs: number = Date.now()): number {
  const HOUR_MS = 3_600_000;
  const sinceTopOfHour = ((nowMs % HOUR_MS) + HOUR_MS) % HOUR_MS;
  if (sinceTopOfHour >= 50 * 60_000) {
    return Math.max(5_000, HOUR_MS - sinceTopOfHour + 5_000);
  }
  return 15_000;
}
