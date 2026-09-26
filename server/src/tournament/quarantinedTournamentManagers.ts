/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  A MANAGER THAT OWNS NOTHING IS NOT A MANAGER (2026-09-21)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Deliberately import-free, for the same reason as tournamentResumeBudget.ts:
 * the law is arithmetic and a bookkeeping map, and its test must not have to
 * half-initialise a database client to run.
 *
 * THE INCIDENT
 * Six RUNNING tournaments - 49 live seats, 4,908,000 tournament chips, the
 * oldest stranded since 2026-09-14 - held no row in engine_tournament_leases
 * and were never re-adopted. The engine had been up 58 hours and reported
 * activeTournaments: 472 against 465 lease rows and 471 RUNNING tournaments,
 * and /health reported tournamentResumesFailing: 0, tournamentResumesInFlight:
 * 0 and a full resume budget. A clean board, for seven days.
 *
 * The chain, every link of which is a correct component doing its job:
 *
 *   1. Each manager lost its lease and was asked to retire.
 *   2. stopOwnedTournamentManager (TournamentManagerOwnership.ts) could not
 *      stop it - the shutdown path still held an unresolved seat-move UUID -
 *      so it returned false WITHOUT deleting the map entry, exactly as its
 *      comment says it must: "A failed teardown is still the owner. Releasing
 *      the slot here would let a replacement start while the old generation
 *      may still have live table engines or callbacks. Keep it quarantined for
 *      the next cleanup pass."
 *   3. The custody-transfer fallback was refused by the database.
 *   4. The manager therefore stayed in GameServer.tournamentEngines: owning no
 *      lease, not running, unable to deal, and unable to leave.
 *   5. discoverRunningResumes asks hasManager(id) === tournamentEngines.has(id)
 *      and skips anything that answers yes. A corpse answers yes.
 *
 * THE QUARANTINE WAS NEVER A BUG. THE MISSING HALF WAS.
 * Step 2 is right and must not change: a slot whose table engines may still be
 * live is exactly the slot you do not hand to a replacement. What was missing
 * is the other half of the sentence - there is no "next cleanup pass". Nothing
 * in the process ever came back for a quarantined manager, and the one loop
 * that walks every RUNNING tournament every five seconds was structurally
 * unable to see it, because "an object is in the map" was standing in for
 * "somebody is dealing this".
 *
 * This module is that pass. It does not release a slot and it does not repair
 * anything a live path should have done (CLAUDE.md 10.12): it supplies the
 * continuation stopOwnedTournamentManager was written to depend on, so a stop
 * that failed once is retried until it succeeds, and is COUNTED AND NAMED
 * while it waits.
 *
 * THREE OUTCOMES, NOT TWO (CLAUDE.md 10.86 rule 1)
 * "Is this tournament owned?" has never had a yes/no answer. It has three:
 * owned, being admitted, and held by a manager that owns nothing. Folding the
 * third into the first is what made a seven-day outage look like a clean
 * board, so it gets its own name here and its own number on /health.
 */

/**
 * How long after a failed stop the quarantined manager is offered to the stop
 * path again. A stop fails for a reason that usually outlives one pass, so the
 * first retry is deliberately not immediate; the cap keeps a permanently stuck
 * manager from going quiet, because the retry is also what keeps its age and
 * its reason fresh on /health.
 */
export const QUARANTINE_FIRST_RETRY_MS = 10_000;
/** No quarantine retry is further away than this, however long the streak. */
export const QUARANTINE_RETRY_CAP_MS = 60_000;

/** The delay before the Nth retry of a quarantined stop. */
export function quarantineRetryDelayMs(attempts: number): number {
  // '|| 0': a NaN streak reads as the first step, never as a NaN deadline.
  const exponent = Math.max(0, Math.min(30, Math.floor(attempts) - 1) || 0);
  return Math.min(QUARANTINE_RETRY_CAP_MS, QUARANTINE_FIRST_RETRY_MS * 2 ** exponent);
}

/**
 * What this process can say about who owns one RUNNING tournament.
 *
 * `unowned` and `quarantined` are BOTH "nobody is dealing this". They are kept
 * apart because the remedy differs: an unowned tournament needs an admission,
 * a quarantined one needs its previous manager to finish stopping first, and
 * reporting the second as the first is how a stuck manager hides behind a
 * healthy-looking resume budget.
 */
export type TournamentOwnerVerdict = 'owned' | 'admitting' | 'quarantined' | 'unowned';

export interface TournamentOwnerObservation {
  /** A manager object is registered for this tournament in this process. */
  managerRegistered: boolean;
  /**
   * That manager still proves current tournament-lease authority. Read from
   * the manager, never inferred from the map: the map says an object exists,
   * which is not the same question.
   */
  managerOwnsLease: boolean;
  /** An admission (start, resume or retry) for this tournament is in flight. */
  admissionInFlight: boolean;
}

export function classifyTournamentOwner(
  observation: TournamentOwnerObservation
): TournamentOwnerVerdict {
  if (observation.managerRegistered) {
    return observation.managerOwnsLease ? 'owned' : 'quarantined';
  }
  return observation.admissionInFlight ? 'admitting' : 'unowned';
}

export interface QuarantinedTournamentManager {
  readonly tournamentId: string;
  /** Why the stop did not complete, as the stop path reported it. */
  readonly reason: string;
  /**
   * Why the custody transfer that would have released this manager was
   * refused, as `path:guard[:clause]` (see F06CustodyRefusal), or null when no
   * transfer has been refused for this manager. `reason` says a stop failed;
   * this says which of the fifteen guards behind it answered no. Added
   * 2026-09-25, when seventeen quarantined managers had a reason and nothing
   * else for hours.
   */
  readonly custodyRefusal: string | null;
  readonly sinceMs: number;
  readonly attempts: number;
  readonly dueAtMs: number;
}

/**
 * The process's record of managers that could not be stopped and therefore
 * still hold their slot.
 *
 * In-process on purpose, like RunningResumeCooldowns: a restart forgets it,
 * and a restart is also the one event that genuinely clears every quarantine,
 * because the corpse does not survive it.
 */
export class QuarantinedTournamentManagers {
  private readonly held = new Map<
    string,
    {
      reason: string;
      custodyRefusal: string | null;
      sinceMs: number;
      attempts: number;
      dueAtMs: number;
      owner: unknown;
    }
  >();

  /**
   * A stop for this tournament settled without releasing the slot. Returns the
   * delay until it will be offered to the stop path again.
   *
   * `custodyRefusal` names the refused custody transfer behind this stop, when
   * the stop path has one. Left undefined, a record by the SAME manager keeps
   * the refusal it already carries (the retry pass records the attempt before
   * the transfer runs, and must not blank what the previous transfer said);
   * a record by a different manager starts with none.
   */
  record(
    tournamentId: string,
    reason: string,
    nowMs: number,
    owner: unknown = null,
    custodyRefusal?: string | null
  ): number {
    const previous = this.held.get(tournamentId);
    // A DIFFERENT manager stuck on the same tournament is a new quarantine,
    // not a continuation: keeping the old age would date this one to a corpse
    // that has already left, and keeping the old streak would push its first
    // retry straight to the cap.
    const sameOwner = previous !== undefined && previous.owner === owner;
    const attempts = (sameOwner ? previous.attempts : 0) + 1;
    const delayMs = quarantineRetryDelayMs(attempts);
    this.held.set(tournamentId, {
      reason,
      custodyRefusal:
        custodyRefusal !== undefined ? custodyRefusal : sameOwner ? previous.custodyRefusal : null,
      sinceMs: sameOwner ? previous.sinceMs : nowMs,
      attempts,
      dueAtMs: nowMs + delayMs,
      owner,
    });
    return delayMs;
  }

  /** The manager this quarantine is held by, for an identity-exact settle. */
  heldBy(tournamentId: string): unknown {
    return this.held.get(tournamentId)?.owner ?? null;
  }

  /** The slot was released, or a live manager owns it again. */
  forget(tournamentId: string): void {
    this.held.delete(tournamentId);
  }

  has(tournamentId: string): boolean {
    return this.held.has(tournamentId);
  }

  /** Quarantined ids whose next stop attempt is due at `nowMs`, oldest first. */
  due(nowMs: number): string[] {
    const ready: Array<{ tournamentId: string; sinceMs: number }> = [];
    for (const [tournamentId, entry] of this.held) {
      if (nowMs >= entry.dueAtMs) ready.push({ tournamentId, sinceMs: entry.sinceMs });
    }
    return ready
      .sort((a, b) => a.sinceMs - b.sinceMs || a.tournamentId.localeCompare(b.tournamentId))
      .map((row) => row.tournamentId);
  }

  /**
   * Drop every id that is no longer held by a quarantined manager. Call it with
   * a board that was ACTUALLY READ and a predicate that reads the live map: an
   * unreadable board says nothing about who is still stuck, so it must not
   * clear anything (the same rule RunningResumeCooldowns.settle follows).
   */
  settle(stillQuarantined: (tournamentId: string) => boolean): void {
    if (this.held.size === 0) return;
    for (const tournamentId of [...this.held.keys()]) {
      if (!stillQuarantined(tournamentId)) this.held.delete(tournamentId);
    }
  }

  snapshot(nowMs: number): QuarantinedTournamentManager[] {
    return [...this.held]
      .map(([tournamentId, entry]) => ({
        tournamentId,
        reason: entry.reason,
        custodyRefusal: entry.custodyRefusal,
        sinceMs: entry.sinceMs,
        attempts: entry.attempts,
        dueAtMs: entry.dueAtMs,
      }))
      .sort((a, b) => a.sinceMs - b.sinceMs || a.tournamentId.localeCompare(b.tournamentId))
      .map((entry) => Object.freeze({ ...entry, ageMs: Math.max(0, nowMs - entry.sinceMs) }));
  }

  get size(): number {
    return this.held.size;
  }

  /** How long the longest-held quarantine has lasted; 0 when nothing is held. */
  oldestAgeMs(nowMs: number): number {
    let oldest = 0;
    for (const entry of this.held.values()) {
      oldest = Math.max(oldest, Math.max(0, nowMs - entry.sinceMs));
    }
    return oldest;
  }
}
