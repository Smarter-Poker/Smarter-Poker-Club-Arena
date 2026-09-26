/**
 * PostgREST caps table-returning RPC responses as well as ordinary reads.
 * Bound the INPUT instead of paging a mutating heartbeat after execution.
 * The caller validates the complete snapshot before dispatch and retains its
 * monotonic proof deadline while these workers drain the captured claims.
 */
const HEARTBEAT_CLAIMS_PER_REQUEST = 500;
const HEARTBEAT_REQUEST_CONCURRENCY = 4;

/**
 * A CLAIM NOBODY ANSWERED IS ASKED AGAIN (2026-09-26).
 *
 * At 04:45:26 UTC on 2026-09-26 all 338 tournament managers lost lease
 * authority in the same instant. The database still named this instance and
 * generation on every row. What happened, from the Supabase logs:
 *
 *   - heartbeats rode the SHARED PostgREST client (the dedicated renewal
 *     session was never configured: `poker_lease_heartbeat_session_enabled`
 *     reads 0 for both scopes, 0 dedicated statements), and
 *   - PostgREST answered 1,915 requests with 504 in that minute - its pool was
 *     full of game traffic - including `POST /rpc/heartbeat_tournament_leases_v4`
 *     at 04:45:26.49, the one request carrying all 338 claims.
 *
 * That request sat in the pool queue for its whole 20 s window. While it was
 * outstanding this class refused to send those claims again ("retain exact
 * claims ... without overlapping an outstanding request"), so for 20 s the
 * fleet asked the database exactly once, got no answer, and every proof ran
 * out. Hand history kept landing every second through the same pool: other
 * requests were getting through. One unlucky request was the whole verdict.
 *
 * So a claim whose only requests have been IN FLIGHT for a full renewal
 * cadence may be asked again, up to MAX_OUTSTANDING per claim. The new request
 * is an independent question with its own proof deadline, opened immediately
 * before it is sent (tournamentLease/tableLease), so a hedge can only ever
 * prove what the database said to it. Nothing about the answer rules changes:
 * the first validated `kept` on the exact generation renews, a later one never
 * shortens it, `busy` and UNKNOWN extend nothing, and any negative answer
 * (taken, stale, missing, another generation) still fences - so a lease that
 * really moved is stopped exactly as before, only sooner if anything.
 *
 * A claim still waiting in the local queue is not duplicated: that request has
 * not asked yet, and asking twice from the same queue proves nothing more.
 */
export const HEARTBEAT_HEDGE_AFTER_MS = 5_000;
export const HEARTBEAT_MAX_OUTSTANDING_PER_CLAIM = 3;

type RetainedBatch<Outcome> = {
  keys: string[];
  current: () => boolean;
  request: () => Promise<Outcome>;
  deliver: (outcome: Outcome) => void;
  failed: (error: unknown) => void;
  /** Monotonic instant the request was handed to its transport; null while queued. */
  startedAtMs: number | null;
};

/**
 * The normal renewal pass may finish while a sibling transport is unresolved.
 * Retain exact claims, not the whole fleet: later passes can renew completed
 * claims without piling onto a request that is still young. The same four
 * workers serve every pass. No timer, retry loop, or fresh deadline is created
 * here: a hedge is only ever sent by an ordinary renewal pass.
 */
export class RetainedLeaseHeartbeatBatches<Claim, Outcome> {
  private readonly retained = new Map<string, Set<RetainedBatch<Outcome>>>();
  private queued: RetainedBatch<Outcome>[] = [];
  private active = 0;

  constructor(private readonly monotonicNow: () => number = () => performance.now()) {}

  dispatch(
    claims: readonly Claim[],
    key: (claim: Claim) => string,
    current: () => boolean,
    heartbeat: (batch: Claim[]) => Promise<Outcome>,
    deliver: (outcome: Outcome) => void,
    failed: (error: unknown) => void
  ): void {
    // A later ordinary pass also drops work whose original authority expired
    // in the queue. Unsettled transports remain retained until they settle.
    this.queued = this.queued.filter((batch) => {
      if (batch.current()) return true;
      this.release(batch);
      return false;
    });
    if (!current()) return;
    const now = this.monotonicNow();
    const available = claims.filter((claim) => this.mayAsk(key(claim), now));
    for (let start = 0; start < available.length; start += HEARTBEAT_CLAIMS_PER_REQUEST) {
      const captured = available.slice(start, start + HEARTBEAT_CLAIMS_PER_REQUEST);
      const batch: RetainedBatch<Outcome> = {
        keys: captured.map(key),
        current,
        request: () => heartbeat(captured),
        deliver,
        failed,
        startedAtMs: null,
      };
      for (const claimKey of batch.keys) {
        let outstanding = this.retained.get(claimKey);
        if (!outstanding) this.retained.set(claimKey, (outstanding = new Set()));
        outstanding.add(batch);
      }
      this.queued.push(batch);
    }
    this.drain();
  }

  /**
   * True when no request for this claim is queued or young. An in-flight
   * request that has not answered within a cadence is not evidence of
   * anything, so it no longer stands between the claim and the database.
   */
  private mayAsk(claimKey: string, now: number): boolean {
    const outstanding = this.retained.get(claimKey);
    if (!outstanding || outstanding.size === 0) return true;
    if (outstanding.size >= HEARTBEAT_MAX_OUTSTANDING_PER_CLAIM) return false;
    for (const batch of outstanding) {
      if (batch.startedAtMs === null) return false;
      if (!(now - batch.startedAtMs >= HEARTBEAT_HEDGE_AFTER_MS)) return false;
    }
    return true;
  }

  private release(batch: RetainedBatch<Outcome>): void {
    for (const claimKey of batch.keys) {
      const outstanding = this.retained.get(claimKey);
      if (!outstanding) continue;
      outstanding.delete(batch);
      if (outstanding.size === 0) this.retained.delete(claimKey);
    }
  }

  private drain(): void {
    while (this.active < HEARTBEAT_REQUEST_CONCURRENCY && this.queued.length) {
      const batch = this.queued.shift()!;
      if (!batch.current()) {
        this.release(batch);
        continue;
      }
      this.active++;
      batch.startedAtMs = this.monotonicNow();
      void this.execute(batch);
    }
  }

  private async execute(batch: RetainedBatch<Outcome>): Promise<void> {
    try {
      const outcome = await batch.request();
      if (batch.current()) batch.deliver(outcome);
    } catch (error) {
      // Report a delivery failure once; never reinterpret an already parsed
      // answer as another RPC outcome or let diagnostics reject this owner.
      try {
        batch.failed(error);
      } catch {
        /* Diagnostics cannot hold a slot. */
      }
    } finally {
      this.release(batch);
      this.active--;
      this.drain();
    }
  }
}

export async function mapLeaseHeartbeatBatches<Claim, Outcome>(
  claims: readonly Claim[],
  heartbeat: (batch: Claim[]) => Promise<Outcome>
): Promise<Outcome[]> {
  const batchCount = Math.ceil(claims.length / HEARTBEAT_CLAIMS_PER_REQUEST);
  const outcomes = new Array<Outcome>(batchCount);
  let nextBatch = 0;
  await Promise.all(
    Array.from({ length: Math.min(batchCount, HEARTBEAT_REQUEST_CONCURRENCY) }, async () => {
      while (nextBatch < batchCount) {
        const index = nextBatch++;
        const start = index * HEARTBEAT_CLAIMS_PER_REQUEST;
        outcomes[index] = await heartbeat(
          claims.slice(start, start + HEARTBEAT_CLAIMS_PER_REQUEST)
        );
      }
    })
  );
  return outcomes;
}
