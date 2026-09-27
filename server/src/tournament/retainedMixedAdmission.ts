/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  A LEASE IS HELD BY A DEALER, NOT BY AN ADMISSION (2026-09-27)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Deliberately import-free, for the same reason as quarantinedTournamentManagers.ts
 * and tournamentResumeBudget.ts: the law is arithmetic over three facts, and
 * its test must not have to half-initialise a database client to run.
 *
 * THE INCIDENT
 * 2026-09-26 09:08 UTC a release of engine cd5892e8 was sealed to production
 * mid-hour. The outgoing process drained its tournament managers, wrote 122
 * mixed manager-custody transfers between 09:33:05 and 09:34:23, and left.
 * Not one of those 122 transfers was ever completed. Thirty-six hours later,
 * at 2026-09-27 22:00 UTC, 120 of those events were still RUNNING with 32, 20,
 * 16, 12 and 7 players sitting in them, and none had dealt a hand since 09:32.
 *
 * Seventy-two of them held a lease taken by the LIVE engine, heartbeated two
 * seconds ago, by a manager registered in GameServer.tournamentEngines. They
 * were not stuck in a break, not waiting on an elimination sweep, not short of
 * seats: `continueAdmission` had thrown once, been caught, and returned.
 *
 *     } catch (error) {
 *       reportError(error, 'GameServer.mixed_original_recovery_retained', ...);
 *       return; // Unknown originals retain this admitted process ...
 *     }
 *
 * Retaining an admission whose outcome is genuinely UNKNOWN is right and does
 * not change here. What was missing is that the retention had no end, no
 * number and no second attempt:
 *
 *   - `manager.resume()` is on the far side of that return, so no dealer was
 *     ever built and `hands dealt` stayed at zero forever.
 *   - The manager stayed in `tournamentEngines`, so the RUNNING re-adoption
 *     lane skipped the id on every pass: `hasManager(id)` answers yes.
 *   - It kept proving its lease generation every 15 seconds, so no other
 *     process could take the event either.
 *   - `classifyTournamentOwner` called it `owned`, because it owned its lease.
 *     /health therefore reported tournamentManagersQuarantined: 0 and
 *     tournamentResumesFailing counted only the ids that never got this far.
 *
 * So the platform's own three-outcome law - owned, admitting, quarantined -
 * had a fourth state it could not name: HOLDING THE LEASE AND DEALING
 * NOTHING. A silent stall is not the absence of an error; it is an error that
 * was caught into a state nothing counts.
 *
 * THE RULE
 * An admission is a promise to deal. A manager that has not produced a dealer
 * either gets another attempt at the thing that failed, or it hands the lease
 * back so somebody else can try - and while it waits it is counted and named.
 * Nothing here repairs a row and nothing here is scheduled: the verdict is
 * read on the RUNNING pass that already walks the board every five seconds.
 *
 * IN-PROCESS ORIGINALS ARE THE ONE THING THAT MAY NOT BE ABANDONED. When the
 * retained admission carries a drained packet, the ORIGINAL table engines of
 * the previous manager are live objects in this process holding reserved F06
 * permits, and only they can attest them. Giving that lease up would strand
 * them, so such a retention is retried for as long as it takes and never
 * abandoned. A durable mixed transfer recovered from the database after a
 * restart has no in-process originals at all - there is nothing local to
 * strand - and that is the whole of the 2026-09-26 cohort.
 */

/** Why a manager is in the quarantine when its admission never produced a dealer. */
export const RETAINED_MIXED_ADMISSION = 'GameServer.mixed_recovery_retained';

/**
 * How long a retained admission with nothing local at stake may go on holding
 * the lease before it hands it back.
 *
 * Long enough that an ordinary transient - a PostgREST schema reload, a lock
 * timeout, one bad minute of database latency - is retried several times on
 * the quarantine's own 10s-doubling-to-60s schedule and simply succeeds; short
 * enough that a deterministic failure costs the field ten minutes rather than
 * the thirty-six hours it cost on 2026-09-26.
 */
export const RETAINED_MIXED_ADMISSION_LEASE_WINDOW_MS = 10 * 60 * 1000;

export interface RetainedMixedAdmissionObservation {
  /** The manager this admission published has started its gameplay lifecycle. */
  managerIsDealing: boolean;
  /**
   * The retention carries a drained packet whose original table engines are
   * live objects in THIS process. Their reserved permits cannot be attested by
   * anyone else, so the lease may not be handed back while they exist.
   */
  hasInProcessOriginals: boolean;
  /** Since the FIRST retention of this admission, not since the last attempt. */
  retainedForMs: number;
}

/**
 * `dealing`  - the admission kept its promise; drop the record.
 * `retry`    - offer the continuation again when the quarantine says it is due.
 * `give_up_the_lease` - it has had its window and has nothing local at stake.
 */
export type RetainedMixedAdmissionVerdict = 'dealing' | 'retry' | 'give_up_the_lease';

export function retainedMixedAdmissionVerdict(
  observation: RetainedMixedAdmissionObservation
): RetainedMixedAdmissionVerdict {
  if (observation.managerIsDealing) return 'dealing';
  // See the header: originals in this process are never abandoned, however
  // long the retention lasts. They are retried, counted and named instead.
  if (observation.hasInProcessOriginals) return 'retry';
  // A NaN or negative age reads as brand new, never as an expired window.
  const retainedForMs = Number.isFinite(observation.retainedForMs)
    ? Math.max(0, observation.retainedForMs)
    : 0;
  return retainedForMs >= RETAINED_MIXED_ADMISSION_LEASE_WINDOW_MS ? 'give_up_the_lease' : 'retry';
}
