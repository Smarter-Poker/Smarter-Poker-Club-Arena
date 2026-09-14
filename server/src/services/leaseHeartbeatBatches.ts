/**
 * PostgREST caps table-returning RPC responses as well as ordinary reads.
 * Bound the INPUT instead of paging a mutating heartbeat after execution.
 * The caller validates the complete snapshot before dispatch and retains its
 * monotonic proof deadline while these workers drain the captured claims.
 */
const HEARTBEAT_CLAIMS_PER_REQUEST = 500;
const HEARTBEAT_REQUEST_CONCURRENCY = 4;

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
