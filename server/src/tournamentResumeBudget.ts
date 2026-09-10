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
   * flight. Launching another would only join it, and must not spend budget.
   */
  admissionInFlight(tournamentId: string): boolean;
  /** Discovery-launched resume admissions still in flight from earlier passes. */
  resumesInFlight: number;
  /** This pass's budget (the C20 law, applied by the caller once per pass). */
  budget: number;
}

/**
 * The tournaments this pass may start resuming: board order preserved, owned
 * and already-admitting ids skipped without spending budget, and never more
 * than the room left under the budget once earlier in-flight resumes are
 * counted. The remainder is not dropped: it is still RUNNING without a manager,
 * so the next pass reads it again, still in started_at order.
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
    if (pass.hasManager(tournamentId) || pass.admissionInFlight(tournamentId)) continue;
    picked.push(row);
    if (picked.length >= room) break;
  }
  return picked;
}
