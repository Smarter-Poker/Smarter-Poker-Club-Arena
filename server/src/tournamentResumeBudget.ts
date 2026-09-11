/**
 * RUNNING RE-ADOPTION IS BUDGETED (2026-09-10)
 *
 * Deliberately import-free, for the same reason as engineStartBudget.ts: the
 * law is arithmetic and its test must not have to half-initialise a database
 * client to run.
 *
 * THE INCIDENT
 * discoverTournaments re-adopted every RUNNING tournament that had no manager
 * in this process, all in one pass and with no bound at all: ~740 claims,
 * ~740 managers and ~1000 table engines inside about three seconds on a
 * single-core box. The main loop saturated (p99 0.4-0.7s), which starved the
 * lease heartbeats, so the managers' proofs expired (818 tournament_lease_lost,
 * 241 tournament_lease_proof_expired and 743 "lease generation expired before
 * it was renewed" in ten minutes). A fenced manager leaves tournamentEngines,
 * which made every one of them eligible again on the very next pass. Load
 * caused failure, failure recreated the load: the C20 cash incident in
 * tournament form, and on 2026-09-10 it ended in a RangeError and a restart.
 *
 * THE LAW
 * The cash fleet already has the answer (C20): a per-pass adoption budget under
 * additive-increase / multiplicative-decrease, applied by the caller with the
 * same nextEngineStartBudget law. This module adds only what a tournament needs
 * on top of it, because a resume is not fired-and-forgotten like a cash start:
 * its admission stays in flight through the lease claim, the manager's resume
 * and its tables' readiness. So the budget bounds the loop's resumes IN FLIGHT,
 * not just the ones it launches this pass - otherwise slow admissions would
 * pile up behind a per-pass count exactly the way they piled up without one.
 *
 * ORDER
 * The board is read oldest started_at first (theLongestWaitIsAdoptedFirst), and
 * selection keeps that order, so the budget decides only how many, never which.
 * Nothing here knows or asks what kind of player is seated: horses are players,
 * and the event that has waited longest goes first whoever is in it.
 *
 * A RESUME THAT KEEPS FAILING WAITS ITS TURN (2026-09-11)
 * Review of #4218. The lane runs every five seconds and gives the room to the
 * first rows on the board, and nothing remembered that an id's last resume had
 * come back without a manager. A resume can end that way with nothing left
 * behind it: manager.resume() reports resume_failed, sets running = false and
 * returns, and admission stops the manager; or the claim answers
 * owned_elsewhere and admission simply returns. The tournament is still RUNNING
 * and still managerless, so the next pass picked the same ids first again. A
 * budget's worth of events that cannot resume at the head of the board took
 * every slot on every pass, and no younger event was ever adopted, while
 * /health showed a full budget and nothing in flight. Before the budget every
 * managerless id was launched on every pass, so a failing head could not hold
 * the tail back; the budget turned the head into a wall. Ids waiting on an
 * admission retry timer were relaunched ahead of the tail the same way.
 *
 * So an id whose resume settled without a manager cools down before the lane
 * launches it again: 5 s after the first such resume, doubling with each one
 * after it, never more than 5 minutes, the same shape as the seat-first lane's
 * park for a launch that keeps being refused (spinLaunchParking.ts). A cooling
 * id is skipped without spending budget, so its slot goes to the next row, and
 * the board order still decides among the ids that may go. The streak ends
 * when the id gets a manager or leaves the RUNNING board.
 */

/**
 * How long one in-flight resume holds its slot. A healthy resume (claim, manager
 * resume, first waiting snapshot on each table) settles in seconds, and a slow
 * one is exactly what the slot exists to count. But the budget must never be
 * the thing that stops re-adoption: one wedged admission that never settles
 * would otherwise hold its slot for the life of the process, and a budget's
 * worth of them would stop every resume on the box. After this horizon the
 * admission still blocks its OWN tournament (it stays in the admission
 * registry) but no longer the others. Twelve discovery passes.
 */
export const RESUME_IN_FLIGHT_HORIZON_MS = 60_000;

/** In-flight resumes that still hold a slot at `nowMs`. */
export function resumesHoldingASlot(launchedAtMs: Iterable<number>, nowMs: number): number {
  let holding = 0;
  for (const launchedAt of launchedAtMs) {
    if (nowMs - launchedAt < RESUME_IN_FLIGHT_HORIZON_MS) holding++;
  }
  return holding;
}

export interface RunningResumePass {
  /** A manager already owns this tournament in this process. */
  hasManager(tournamentId: string): boolean;
  /**
   * An admission (start, resume or retry) for this tournament is already in
   * flight, a retry still waiting on its timer included. Launching another
   * would only duplicate it, and must not spend budget.
   */
  admissionInFlight(tournamentId: string): boolean;
  /**
   * This tournament's last resume came back without a manager and its cooldown
   * has not run out (RunningResumeCooldowns). Skipped without spending budget.
   */
  coolingDown(tournamentId: string): boolean;
  /** Discovery-launched resume admissions still in flight from earlier passes. */
  resumesInFlight: number;
  /** This pass's budget (the C20 law, applied by the caller once per pass). */
  budget: number;
}

/**
 * The tournaments this pass may start resuming: board order preserved; owned,
 * already-admitting and cooling-down ids skipped without spending budget; and
 * never more than the room left under the budget once earlier in-flight
 * resumes are counted. The remainder is not dropped: it is still RUNNING
 * without a manager, so the next pass reads it again, still in started_at
 * order.
 */
export function selectRunningResumes<T extends { id: string | number }>(
  board: readonly T[],
  pass: RunningResumePass
): T[] {
  const room = Math.max(0, Math.floor(pass.budget) - Math.max(0, pass.resumesInFlight));
  const picked: T[] = [];
  if (room === 0) return picked;
  for (const row of board) {
    const tournamentId = String(row.id);
    if (
      pass.hasManager(tournamentId) ||
      pass.admissionInFlight(tournamentId) ||
      pass.coolingDown(tournamentId)
    ) {
      continue;
    }
    picked.push(row);
    if (picked.length >= room) break;
  }
  return picked;
}

/** The cooldown after an id's first resume that came back without a manager. */
export const RESUME_COOLDOWN_FIRST_MS = 5_000;
/** No cooldown is longer than this, however long the streak. */
export const RESUME_COOLDOWN_CAP_MS = 5 * 60_000;

/**
 * The cooldown after the Nth resume in a row that left no manager: the first
 * step doubled per resume after the first, clamped to the cap.
 */
export function resumeCooldownMs(failures: number): number {
  // `|| 0`: a NaN streak is read as the first step, never as a NaN deadline.
  const exponent = Math.max(0, Math.min(30, Math.floor(failures) - 1) || 0);
  return Math.min(RESUME_COOLDOWN_CAP_MS, RESUME_COOLDOWN_FIRST_MS * 2 ** exponent);
}

/**
 * The lane's memory of resumes that came back without a manager, per
 * tournament. In-process on purpose: a restart forgets it, and the worst that
 * costs is one fresh attempt per id before the schedule starts again from its
 * first step.
 */
export class RunningResumeCooldowns {
  private readonly streaks = new Map<string, { failures: number; untilMs: number }>();

  /** A resume of this id settled and left no manager. Returns the cooldown applied. */
  recordFailure(tournamentId: string, nowMs: number): number {
    const failures = (this.streaks.get(tournamentId)?.failures ?? 0) + 1;
    const cooldownMs = resumeCooldownMs(failures);
    this.streaks.set(tournamentId, { failures, untilMs: nowMs + cooldownMs });
    return cooldownMs;
  }

  /** A resume of this id left a manager behind: the streak is over. */
  forget(tournamentId: string): void {
    this.streaks.delete(tournamentId);
  }

  coolingDown(tournamentId: string, nowMs: number): boolean {
    const streak = this.streaks.get(tournamentId);
    return streak !== undefined && nowMs < streak.untilMs;
  }

  /**
   * End every streak whose id got a manager or left the RUNNING board. Call it
   * with a board that was actually read: an unreadable board says nothing
   * about which ids are still waiting, so it must not clear anything.
   */
  settle(
    board: Iterable<{ id: string | number }>,
    hasManager: (tournamentId: string) => boolean
  ): void {
    if (this.streaks.size === 0) return;
    const stillWaiting = new Set<string>();
    for (const row of board) {
      const tournamentId = String(row.id);
      if (!hasManager(tournamentId)) stillWaiting.add(tournamentId);
    }
    for (const tournamentId of [...this.streaks.keys()]) {
      if (!stillWaiting.has(tournamentId)) this.streaks.delete(tournamentId);
    }
  }

  /** Ids still on a streak, cooling down or due again: /health's tournamentResumesFailing. */
  get size(): number {
    return this.streaks.size;
  }
}
