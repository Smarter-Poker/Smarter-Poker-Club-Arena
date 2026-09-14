import { randomUUID } from 'node:crypto';

export type LifecycleTransition =
  | 'writer_pending'
  | 'writer_settled'
  | 'retirement_fenced'
  | 'owner_changed'
  | 'stop_initiated'
  | 'owned_work_joined'
  | 'stop_completed'
  | 'stop_failed'
  | 'lease_release_observed'
  | 'engine_fenced';
export interface LifecycleDetail {
  operationId?: string;
  attempt?: number;
  writerKind?: 'admission' | 'allocator' | 'begin';
  outcome?: 'returned' | 'unknown';
  leaseStatus?: 'confirmed' | 'uncertain' | 'unknown';
  releasedCount?: number | null;
  reason?:
    | 'cash_lease_proof_expired'
    | 'tournament_lease_proof_expired'
    | 'dealing_loop_threw'
    | 'start_failed'
    | 'other';
  proofDeadlineMonotonicMs?: number | null;
}
/** Bounded local diagnostics only. Never an authority, registry or durable proof. */
export class LifecycleDiagnostics {
  readonly instanceId = randomUUID();
  private sequence = 0;
  private records: Readonly<
    LifecycleDetail & { sequence: number; observedAtMs: number; event: LifecycleTransition }
  >[] = [];
  record(event: LifecycleTransition, detail: LifecycleDetail = {}): void {
    // Explicit allowlist: no arbitrary payload, errors, credentials or row bodies.
    const entry = Object.freeze({
      sequence: ++this.sequence,
      observedAtMs: Date.now(),
      event,
      operationId: detail.operationId,
      attempt: detail.attempt,
      writerKind: detail.writerKind,
      outcome: detail.outcome,
      leaseStatus: detail.leaseStatus,
      releasedCount: detail.releasedCount,
      reason: detail.reason,
      proofDeadlineMonotonicMs: detail.proofDeadlineMonotonicMs,
    });
    this.records.push(entry);
    if (this.records.length > 32) this.records.shift();
  }
  snapshot() {
    return Object.freeze({
      diagnosticOnly: true as const,
      instanceId: this.instanceId,
      lastSequence: this.sequence,
      droppedRecords: Math.max(0, this.sequence - this.records.length),
      records: Object.freeze([...this.records]),
    });
  }
}
