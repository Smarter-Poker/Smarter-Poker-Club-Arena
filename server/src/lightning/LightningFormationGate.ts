/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  ONE FORMATION IN FLIGHT PER CLUSTER (Lightning Phase 12, 2026-10-09)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Spec "SURGE PROTECTION": reservation control - burst traffic must never
 * cause a duplicate seat, hand, buy-in, blind or settlement. The database
 * already serializes `fn_lightning_match_and_form` per Cluster (an advisory
 * lock answers a second pass `pass_in_progress`) and replays a request id it
 * has recorded. This gate is the engine's half: within one process at most
 * ONE match_and_form call is in flight for a Cluster, whichever worker
 * object issued it, and an answer nobody processed is never forgotten.
 *
 *   - A worker that is stopped (crash, config flip, leadership) while its
 *     call is in flight leaves the gate held; its successor skips
 *     (`formation_in_flight`) instead of overlapping it.
 *   - A call that timed out or failed in transport leaves its request id
 *     here as OUTCOME UNKNOWN (a late answer to a timed-out call is acted on
 *     by nobody). The next forming pass for the Cluster - the same worker or
 *     its successor -
 *     re-asks under THAT id, and the database answers from its record: the
 *     hands it formed are dealt (the host refuses a replayed instance it
 *     already has), and nothing is formed twice.
 *   - A call that never answers at all stops holding the gate after
 *     LIGHTNING_FORM_GATE_STALE_MS; its id is re-asked like any unknown one.
 *
 * BOUNDED. One entry per Cluster at most; an unknown outcome is forgotten
 * after LIGHTNING_FORM_GATE_UNKNOWN_TTL_MS (the formation reaper has voided
 * anything such a pass left by then).
 */

/** A match_and_form call still unanswered after this is treated as failed (outcome unknown). */
export const LIGHTNING_FORM_RPC_TIMEOUT_MS = 10_000;
/** A call in flight this long no longer holds the gate. */
export const LIGHTNING_FORM_GATE_STALE_MS = 60_000;
/** An unknown outcome nobody re-asked is forgotten after this. */
export const LIGHTNING_FORM_GATE_UNKNOWN_TTL_MS = 10 * 60_000;

interface GateEntry {
  requestId: string;
  startedAtMs: number;
  inFlight: boolean;
  unknownSinceMs: number;
}

export interface LightningFormationGateCheck {
  /** Another call for this Cluster is in flight: do not call. */
  busy: boolean;
  /** A request id whose outcome is unknown: re-ask under it. */
  pendingRequestId: string | null;
}

export class LightningFormationGate {
  private readonly entries = new Map<string, GateEntry>();
  private overlapCount = 0;

  /** May a forming call for this Cluster go out now, and under which id? */
  check(clusterId: string, nowMs: number): LightningFormationGateCheck {
    const e = this.entries.get(clusterId);
    if (!e) return { busy: false, pendingRequestId: null };
    if (e.inFlight) {
      if (nowMs - e.startedAtMs < LIGHTNING_FORM_GATE_STALE_MS)
        return { busy: true, pendingRequestId: null };
      return { busy: false, pendingRequestId: e.requestId };
    }
    if (nowMs - e.unknownSinceMs >= LIGHTNING_FORM_GATE_UNKNOWN_TTL_MS) {
      this.entries.delete(clusterId);
      return { busy: false, pendingRequestId: null };
    }
    return { busy: false, pendingRequestId: e.requestId };
  }

  /** A call goes out. (A second open while one is in flight is counted: it must never happen.) */
  open(clusterId: string, requestId: string, nowMs: number): void {
    const e = this.entries.get(clusterId);
    if (e?.inFlight && nowMs - e.startedAtMs < LIGHTNING_FORM_GATE_STALE_MS) this.overlapCount++;
    this.entries.set(clusterId, {
      requestId,
      startedAtMs: nowMs,
      inFlight: true,
      unknownSinceMs: 0,
    });
  }

  /**
   * The call answered. `unknown`: nobody acted on the answer (transport or
   * timeout), so the id stays to be re-asked.
   * Only the call that holds the entry can close it.
   */
  close(clusterId: string, requestId: string, unknown: boolean, nowMs: number): void {
    const e = this.entries.get(clusterId);
    if (!e || e.requestId !== requestId) return;
    if (!unknown) {
      this.entries.delete(clusterId);
      return;
    }
    e.inFlight = false;
    e.unknownSinceMs = nowMs;
  }

  /** Overlapping opens observed (tests and the load suite assert zero). */
  get overlaps(): number {
    return this.overlapCount;
  }

  /** Entries held (memory bound checks). */
  get size(): number {
    return this.entries.size;
  }

  /** Is a call for this Cluster in flight right now? */
  inFlight(clusterId: string): boolean {
    return this.entries.get(clusterId)?.inFlight === true;
  }
}

/** The process-wide gate every Cluster worker shares. */
export const lightningFormationGate = new LightningFormationGate();
