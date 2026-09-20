/**
 * PostgREST caps table-returning RPC responses as well as ordinary reads.
 * Bound the INPUT instead of paging a mutating heartbeat after execution.
 * The caller validates the complete snapshot before dispatch and retains its
 * monotonic proof deadline while these workers drain the captured claims.
 */
const HEARTBEAT_CLAIMS_PER_REQUEST = 500;
const HEARTBEAT_REQUEST_CONCURRENCY = 4;

type RetainedBatch<Outcome> = {
  keys: string[];
  current: () => boolean;
  request: () => Promise<Outcome>;
  deliver: (outcome: Outcome) => void;
  failed: (error: unknown) => void;
};

/**
 * The normal renewal pass may finish while a sibling transport is unresolved.
 * Retain exact claims, not the whole fleet: later passes can renew completed
 * claims without overlapping an outstanding request. The same four workers
 * serve every pass. No timer, retry, or fresh deadline is created here.
 */
export class RetainedLeaseHeartbeatBatches<Claim, Outcome> {
  private readonly retained = new Map<string, RetainedBatch<Outcome>>();
  private queued: RetainedBatch<Outcome>[] = [];
  private active = 0;

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
    const available = claims.filter((claim) => !this.retained.has(key(claim)));
    for (let start = 0; start < available.length; start += HEARTBEAT_CLAIMS_PER_REQUEST) {
      const captured = available.slice(start, start + HEARTBEAT_CLAIMS_PER_REQUEST);
      const batch: RetainedBatch<Outcome> = {
        keys: captured.map(key),
        current,
        request: () => heartbeat(captured),
        deliver,
        failed,
      };
      for (const claimKey of batch.keys) this.retained.set(claimKey, batch);
      this.queued.push(batch);
    }
    this.drain();
  }

  private release(batch: RetainedBatch<Outcome>): void {
    for (const key of batch.keys) {
      if (this.retained.get(key) === batch) this.retained.delete(key);
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
