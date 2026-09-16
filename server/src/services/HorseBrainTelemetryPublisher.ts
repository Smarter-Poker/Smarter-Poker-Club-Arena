import { createHash, randomUUID } from 'node:crypto';
import type { drainFires, drainDecisionLatency } from '../engine/BrainTelemetry.js';

export interface HorseBrainTelemetryCapture {
  fires: ReturnType<typeof drainFires>;
  latency: ReturnType<typeof drainDecisionLatency>;
}
interface Dependencies {
  capture(): HorseBrainTelemetryCapture;
  sourceRelease(): string | null;
  send(
    payload: string
  ): Promise<{ data: unknown; error: { message: string; code?: string } | null }>;
  now?(): Date;
  uuid?(): string;
}
export type HorseBrainTelemetryPublishResult = 'idle' | 'recorded' | 'replayed' | 'expired';

/** One retained, immutable batch per publisher. A transport error or malformed
 * acknowledgement keeps the exact bytes and ID for the next attempt; newly
 * arriving counters remain in their accumulators. This is not a disk spool
 * or a complete decision ledger and cannot account for process-crash loss. */
export class HorseBrainTelemetryPublisher {
  private readonly workerId: string;
  private sequence = 0;
  private pending: { payload: string; batchId: string; digest: string } | null = null;
  private inFlight: Promise<HorseBrainTelemetryPublishResult> | null = null;
  constructor(private readonly deps: Dependencies) {
    this.workerId = (deps.uuid ?? randomUUID)();
  }

  flush(): Promise<HorseBrainTelemetryPublishResult> {
    if (this.inFlight) return this.inFlight;
    const operation = this.publish();
    this.inFlight = operation;
    void operation
      .finally(() => {
        if (this.inFlight === operation) this.inFlight = null;
      })
      .catch(() => undefined);
    return operation;
  }

  private async publish(): Promise<HorseBrainTelemetryPublishResult> {
    if (!this.pending) {
      if (!Number.isSafeInteger(this.sequence + 1))
        throw Error('Horse telemetry sequence exhausted');
      const capture = this.deps.capture();
      if (!capture.fires.length && !capture.latency.length) return 'idle';
      const collectedAt = (this.deps.now ?? (() => new Date()))().toISOString();
      const batchId = (this.deps.uuid ?? randomUUID)();
      const release = this.deps.sourceRelease();
      const payload = JSON.stringify({
        version: 1,
        batchId,
        workerId: this.workerId,
        sequence: ++this.sequence,
        sourceRelease: release && /^[a-f0-9]{40}$/.test(release) ? release : null,
        day: collectedAt.slice(0, 10),
        collectedAt,
        fires: [...capture.fires].sort((a, b) =>
          a.feature < b.feature ? -1 : a.feature > b.feature ? 1 : 0
        ),
        latency: [...capture.latency].sort((a, b) =>
          a.scope < b.scope ? -1 : a.scope > b.scope ? 1 : 0
        ),
      });
      this.pending = {
        payload,
        batchId,
        digest: createHash('sha256').update(payload).digest('hex'),
      };
    }
    const pending = this.pending;
    const result = await this.deps.send(pending.payload);
    if (result.error) {
      // The writer refuses expired batches before any aggregate mutation,
      // even if their old deduplication receipt has already been pruned.
      if (result.error.code === 'P0001' && result.error.message === 'HORSE_FLUSH_EXPIRED') {
        this.pending = null;
        return 'expired';
      }
      throw Error('Horse telemetry batch write unconfirmed');
    }
    const ack = result.data as Record<string, unknown> | null;
    if (
      !ack ||
      typeof ack !== 'object' ||
      Array.isArray(ack) ||
      ack.version !== 1 ||
      !['recorded', 'replayed'].includes(ack.status as string) ||
      ack.batchId !== pending.batchId ||
      ack.payloadSha256 !== pending.digest
    ) {
      throw Error('Horse telemetry batch acknowledgement invalid');
    }
    this.pending = null;
    return ack.status as 'recorded' | 'replayed';
  }
}
