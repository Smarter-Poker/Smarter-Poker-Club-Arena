import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
/** Pipeline transport adapter may read this correlation; it supplies proof. */
export const allocatorRequestContext = new AsyncLocalStorage<{
  requestId: string;
  issuerId: string;
}>();
type Row = {
  id: string;
  state: 'active' | 'unknown' | 'complete';
  localSettled: boolean;
  issuedAt: number;
  localSettledAt: number | null;
  completedAt: number | null;
  proof: string | null;
};
export class AllocatorIssuerMeasurement {
  private epoch = 0;
  private fence: { id: string; deadline: number } | null = null;
  private rows = new Map<string, Row>();
  private jobs = new Map<string, string>();
  private invalidators = new Map<() => void, () => number>();
  constructor(
    readonly issuerId: string,
    private now = () => Date.now()
  ) {}
  capture(): number {
    return this.epoch;
  }
  assertAdmission(epoch: number): void {
    if (this.fence || epoch !== this.epoch) throw new Error('allocator_issuer_fenced');
  }
  onFence(invalidate: () => void, countReusable: () => number): void {
    this.invalidators.set(invalidate, countReusable);
  }
  async job<T>(
    kind: 'producer' | 'retry' | 'preparation',
    epoch: number,
    work: () => Promise<T>
  ): Promise<T> {
    this.assertAdmission(epoch);
    const id = randomUUID();
    this.jobs.set(id, kind);
    try {
      return await work();
    } finally {
      this.jobs.delete(id);
    }
  }
  async request<T>(epoch: number, work: () => Promise<T>): Promise<T> {
    this.assertAdmission(epoch);
    const id = randomUUID();
    const row: Row = {
      id,
      state: 'active',
      localSettled: false,
      issuedAt: this.now(),
      localSettledAt: null,
      completedAt: null,
      proof: null,
    };
    this.rows.set(id, row);
    try {
      const result = await allocatorRequestContext.run(
        { requestId: id, issuerId: this.issuerId },
        work
      );
      this.assertAdmission(epoch);
      return result;
    } finally {
      row.localSettled = true;
      row.localSettledAt = this.now();
      if (row.state === 'active') row.state = 'unknown';
    }
  }
  complete(
    requestId: string,
    proof: {
      requestId: string;
      receiptId: string;
      kind: 'database_response_complete' | 'transport_owner_barrier';
    }
  ): void {
    const row = this.rows.get(requestId);
    if (
      !row ||
      proof.requestId !== requestId ||
      !proof.receiptId ||
      !['database_response_complete', 'transport_owner_barrier'].includes(proof.kind)
    )
      throw new Error('allocator_completion_unproven');
    const serialized = JSON.stringify(proof);
    if (row.proof && row.proof !== serialized) throw new Error('allocator_completion_conflict');
    row.state = 'complete';
    row.proof = serialized;
    row.completedAt = this.now();
  }
  beginAttempt(id: string, deadline: number): void {
    const now = this.now();
    const delta = deadline - now;
    if (
      this.fence ||
      !id ||
      !Number.isFinite(now) ||
      !Number.isFinite(deadline) ||
      !Number.isFinite(delta) ||
      delta <= 0 ||
      delta > 60000
    )
      throw new Error('allocator_attempt_invalid');
    this.fence = { id, deadline };
    this.epoch++;
    for (const invalidate of this.invalidators.keys()) invalidate();
  }
  expireUnqualified(id: string): void {
    const now = this.now();
    if (
      !Number.isFinite(now) ||
      !this.fence ||
      !Number.isFinite(this.fence.deadline) ||
      this.fence.id !== id ||
      now < this.fence.deadline
    )
      throw new Error('allocator_attempt_not_expired');
    this.fence = null;
    this.epoch++;
  }
  snapshot() {
    const count = (kind: string) => [...this.jobs.values()].filter((k) => k === kind).length;
    return {
      issuerId: this.issuerId,
      epoch: this.epoch,
      fence: this.fence ? { ...this.fence } : null,
      active: [...this.rows.values()].filter((r) => !r.localSettled).length,
      unknown: [...this.rows.values()].filter((r) => r.state === 'unknown').length,
      queuedProducers: count('producer'),
      scheduledRetries: count('retry'),
      pendingPreparations: count('preparation'),
      reusablePreparedValues: [...this.invalidators.values()].reduce((n, count) => n + count(), 0),
      requests: [...this.rows.values()].map((r) => ({ ...r })),
      floorEnabled: false,
      cutoverQualified: false,
    };
  }
}
