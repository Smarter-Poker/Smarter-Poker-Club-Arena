import {
  retainOriginalRoster,
  assertOriginalRosterIdentity,
  decodeOriginalRoster,
  type OriginalRosterBinding,
  type DecodedOriginalRoster,
} from './F06OriginalRosterTransport.js';
import type { MTTPreReserveSnapshot } from '../engine/MTTPreReserveRoster.js';
import { LifecycleDiagnostics } from './LifecycleDiagnostics.js';
import { captureCurrentEngineWriterOrigin } from './F06EngineWriterCapture.js';
import type { RetainedRetirementBinding } from './F06RetirementEvidence.js';
import type { F06Rpc } from './F06HandPermit.js';

export type SessionWriterKind = 'admission' | 'allocator' | 'begin';
export interface SessionWriterObservation {
  readonly kind: SessionWriterKind;
  readonly rpc: string;
  readonly operationId: string;
  readonly attempt: number;
  /** Original launch inputs, never inferred from a later receipt. */
  readonly admissionRevision: string | null;
  readonly handNumber: string | null;
  /** Private engine-owned origin identity captured at this actual raw launch. */
  readonly engineWriterOrigin?: ReturnType<typeof captureCurrentEngineWriterOrigin>;
  /** Returned only describes transport, never canonical success or permission. */
  readonly state: 'pending' | 'returned' | 'unknown' | 'positively-resolved';
}
export interface OriginalSessionWriterObservation {
  readonly admissionId: string;
  readonly admissionRevision: string | null;
  readonly originalGeneration: string;
  readonly coverage: 'captured-before-first-writer';
  readonly lastAttempt: number;
  readonly writers: readonly SessionWriterObservation[];
}
type WriterAttempt = {
  kind: SessionWriterKind;
  rpc: string;
  operationId: string;
  attempt: number;
  admissionRevision: string | null;
  handNumber: string | null;
  engineWriterOrigin: ReturnType<typeof captureCurrentEngineWriterOrigin>;
  state: SessionWriterObservation['state'];
  physical: Promise<void>;
};

export interface OriginalAdmissionIdentity {
  admission_id: string;
  tournament_id: string;
  table_id: string;
  lifecycle: string;
  lease_generation: string;
  custody_id: string;
}
export interface OriginalIntentIdentity extends OriginalAdmissionIdentity {
  admission_revision: string;
  permit_id: string;
  hand_number: string;
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const positive = (x: unknown): x is string =>
  typeof x === 'string' && /^[1-9][0-9]{0,18}$/.test(x) && BigInt(x) <= 9223372036854775807n;
function record(x: unknown): Record<string, unknown> {
  if (!x || typeof x !== 'object' || Array.isArray(x))
    throw new Error('f06_intent_response_unknown');
  return x as Record<string, unknown>;
}
/** Prospective protocol client. No legacy fallback, SQL installation or automatic adoption. */
export class F06OriginalIntentSession {
  readonly identity: Readonly<OriginalAdmissionIdentity>;
  private readonly lifecycleDiagnostics = new LifecycleDiagnostics();
  private revision: string | null = null;
  private pendingPermit: string | null = null;
  private intent: Readonly<OriginalIntentIdentity> | null = null;
  private retiring = false;
  private originalRoster: OriginalRosterBinding | null = null;
  private readonly writers: WriterAttempt[] = [];
  private writerOrdinal = 0;
  private tail: Promise<unknown> = Promise.resolve();
  constructor(
    identity: OriginalAdmissionIdentity,
    private readonly rpc: F06Rpc,
    private readonly ownerCurrent: () => boolean,
    private readonly newPermitId: () => string
  ) {
    for (const [key, value] of Object.entries(identity)) {
      if (key === 'lifecycle' ? !positive(value) : !uuid.test(value))
        throw new Error('f06_intent_identity');
    }
    this.identity = Object.freeze({ ...identity });
  }
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.tail.then(work);
    this.tail = next.then(
      () => undefined,
      () => undefined
    );
    return next;
  }
  private assertOwner(): void {
    if (!this.ownerCurrent()) {
      this.lifecycleDiagnostics.record('owner_changed');
      throw new Error('f06_intent_owner_changed');
    }
  }
  canRetryAdmission(): boolean {
    return !this.retiring && this.ownerCurrent();
  }
  canStart(): boolean {
    return this.canRetryAdmission() && this.revision !== null;
  }
  private async call(
    name: string,
    extra: Record<string, unknown> = {}
  ): Promise<Record<string, unknown>> {
    this.assertOwner();
    const args = Object.fromEntries(Object.entries(this.identity).map(([k, v]) => ['p_' + k, v]));
    const result = await this.captureWriter(name, { ...args, ...extra });
    this.assertOwner();
    if (result.error) throw new Error('f06_intent_transport_unknown');
    return record(result.data);
  }
  /** Register before invoking transport, including synchronous/reentrant transports.
   * Physical settlement is separate from logical outcome and enclosing jobs. */
  private async captureWriter(name: string, args: Record<string, unknown>): ReturnType<F06Rpc> {
    const kind: SessionWriterKind | undefined =
      name === 'fn_f06_register_engine_admission'
        ? 'admission'
        : name === 'fn_f06_allocate_original_intent'
          ? 'allocator'
          : name === 'fn_f06_begin_hand_with_intent'
            ? 'begin'
            : undefined;
    if (!kind) return this.rpc(name, args);
    if (this.retiring) throw new Error('f06_admission_retiring');
    let settle!: () => void;
    const physical = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const attempt: WriterAttempt = {
      kind,
      rpc: name,
      operationId: kind === 'admission' ? this.identity.admission_id : String(args.p_permit_id),
      attempt: ++this.writerOrdinal,
      admissionRevision: kind === 'admission' ? null : String(args.p_admission_revision),
      handNumber: kind === 'begin' ? String(args.p_hand_number) : null,
      state: 'pending',
      physical,
      engineWriterOrigin: captureCurrentEngineWriterOrigin(),
    };
    this.writers.push(attempt);
    this.lifecycleDiagnostics.record('writer_pending', {
      operationId: attempt.operationId,
      attempt: attempt.attempt,
      writerKind: kind,
    });
    try {
      const result = await this.rpc(name, args);
      attempt.state =
        result &&
        !result.error &&
        result.data &&
        typeof result.data === 'object' &&
        !Array.isArray(result.data)
          ? 'returned'
          : 'unknown';
      return result;
    } catch (error) {
      attempt.state = 'unknown';
      throw error;
    } finally {
      this.lifecycleDiagnostics.record('writer_settled', {
        operationId: attempt.operationId,
        attempt: attempt.attempt,
        writerKind: kind,
        outcome: attempt.state === 'returned' ? 'returned' : 'unknown',
      });
      settle();
    }
  }
  /** Called only after exact canonical resolver validation. Pending raw calls
   * cannot be resolved by an earlier read; BEGIN needs its own canonical proof. */
  private resolveUnknown(kind: SessionWriterKind, operationId: string): void {
    for (const writer of this.writers) {
      if (writer.kind === kind && writer.operationId === operationId && writer.state === 'unknown')
        writer.state = 'positively-resolved';
    }
  }
  /** Observation only, never a movement/cleanup capability. Does not enter
   * serial itself or join a Manager job, which may be awaiting this method. */
  async inspectOriginalWriters(): Promise<OriginalSessionWriterObservation> {
    if (!this.retiring) throw new Error('f06_retirement_fence_required');
    this.assertOwner();
    for (;;) {
      const tail = this.tail;
      const ordinal = this.writerOrdinal;
      const pending = this.writers.filter((writer) => writer.state === 'pending');
      await Promise.all([tail, ...pending.map((writer) => writer.physical)]);
      this.assertOwner();
      if (
        tail !== this.tail ||
        ordinal !== this.writerOrdinal ||
        this.writers.some((writer) => writer.state === 'pending')
      )
        continue;
      return Object.freeze({
        admissionId: this.identity.admission_id,
        admissionRevision: this.revision,
        originalGeneration: this.identity.lease_generation,
        coverage: 'captured-before-first-writer' as const,
        lastAttempt: this.writerOrdinal,
        writers: Object.freeze(
          this.writers.map(({ physical: _physical, ...writer }) => Object.freeze(writer))
        ),
      });
    }
  }
  private exact(row: Record<string, unknown>): void {
    for (const [key, value] of Object.entries(this.identity))
      if (row[key] !== value) throw new Error('f06_intent_identity_mismatch');
  }
  admit(): Promise<void> {
    return this.serial(async () => {
      if (this.retiring) throw new Error('f06_admission_retiring');
      let row = await this.call('fn_f06_resolve_engine_admission');
      const resolvedAdmission = row.state === 'ACTIVE';
      if (!this.canRetryAdmission()) throw new Error('f06_admission_retiring');
      if (row.ok !== true) throw new Error('f06_admission_unresolved');
      if (row.state === 'ELIGIBLE') {
        // Eligibility is a positively issued enrollment challenge, not a null lookup.
        this.exact(row);
        if (
          !positive(row.protocol_epoch) ||
          typeof row.enrollment_token !== 'string' ||
          !/^[0-9a-f]{64}$/.test(row.enrollment_token)
        )
          throw new Error('f06_enrollment_unproven');
        row = await this.call('fn_f06_register_engine_admission', {
          p_protocol_epoch: row.protocol_epoch,
          p_enrollment_token: row.enrollment_token,
        });
      }
      if (this.retiring) throw new Error('f06_admission_retiring');
      this.exact(row);
      if (row.ok !== true || row.state !== 'ACTIVE' || !positive(row.revision))
        throw new Error('f06_admission_unresolved');
      if (this.revision !== null && this.revision !== row.revision)
        throw new Error('f06_admission_revision_changed');
      this.revision = row.revision;
      if (resolvedAdmission) this.resolveUnknown('admission', this.identity.admission_id);
    });
  }
  allocate(): Promise<Readonly<OriginalIntentIdentity>> {
    return this.serial(async () => {
      if (!this.canStart()) throw new Error('f06_admission_not_active');
      if (this.pendingPermit) {
        const prior = await this.call('fn_f06_resolve_original_intent', {
          p_permit_id: this.pendingPermit,
        });
        if (prior.ok !== true) throw new Error('f06_intent_unresolved');
        this.exact(prior);
        if (prior.permit_id !== this.pendingPermit || prior.admission_revision !== this.revision)
          throw new Error('f06_intent_identity_mismatch');
        if (!this.canStart()) throw new Error('f06_admission_not_active');
        this.retainHand(prior);
        if (prior.state === 'TERMINAL') {
          if (
            prior.canonical_terminal_verified !== true ||
            prior.terminal_permit_id !== this.pendingPermit
          )
            throw new Error('f06_intent_terminal_unproven');
          this.pendingPermit = null;
          this.intent = null;
        } else if (prior.state !== 'INTENT') throw new Error('f06_intent_unresolved');
        this.resolveUnknown('allocator', String(prior.permit_id));
      }
      if (!this.canStart()) throw new Error('f06_admission_not_active');
      if (!this.pendingPermit) {
        const id = this.newPermitId();
        if (!uuid.test(id)) throw new Error('f06_intent_uuid');
        this.pendingPermit = id;
      }
      const row = await this.call('fn_f06_allocate_original_intent', {
        p_permit_id: this.pendingPermit,
        p_admission_revision: this.revision,
      });
      if (!this.canStart()) throw new Error('f06_admission_not_active');
      this.exact(row);
      if (
        row.ok !== true ||
        row.state !== 'INTENT' ||
        row.permit_id !== this.pendingPermit ||
        row.admission_revision !== this.revision ||
        !positive(row.hand_number) ||
        BigInt(row.hand_number) < 1000000n ||
        BigInt(row.hand_number) > BigInt(Number.MAX_SAFE_INTEGER)
      )
        throw new Error('f06_allocation_unproven');
      this.retainHand(row);
      return this.intent!;
    });
  }
  private retainHand(row: Record<string, unknown>): void {
    if (
      !positive(row.hand_number) ||
      BigInt(row.hand_number) < 1000000n ||
      BigInt(row.hand_number) > BigInt(Number.MAX_SAFE_INTEGER)
    )
      throw new Error('f06_original_hand_unproven');
    if (this.intent && this.intent.hand_number !== row.hand_number)
      throw new Error('f06_original_hand_changed');
    this.intent = Object.freeze({
      ...this.identity,
      admission_revision: this.revision!,
      permit_id: this.pendingPermit!,
      hand_number: row.hand_number,
    });
  }
  forHand(hand: number | string): Readonly<OriginalIntentIdentity> {
    if (!this.canStart() || !this.intent || this.intent.hand_number !== String(hand))
      throw new Error('f06_original_hand_unproven');
    return this.intent;
  }
  /** Data-only binding before the first physical BEGIN. No runtime caller is enabled here. */
  bindOriginalRoster(snapshot: MTTPreReserveSnapshot): void {
    if (!this.canStart() || !this.intent) throw new Error('f06_original_begin_unproven');
    const next = retainOriginalRoster(snapshot, this.intent);
    if (this.originalRoster?.intent.permit_id === this.intent.permit_id) {
      assertOriginalRosterIdentity(this.originalRoster, this.intent);
      if (JSON.stringify(this.originalRoster.request) !== JSON.stringify(next.request))
        throw new Error('f06_original_roster_changed');
      return;
    }
    if (this.writers.some((w) => w.kind === 'begin' && w.operationId === this.intent!.permit_id))
      throw new Error('f06_original_roster_late_binding');
    this.originalRoster = next;
  }
  async begin(
    input: Record<string, unknown>
  ): Promise<{ data: unknown; error: unknown; originalRoster?: DecodedOriginalRoster }> {
    if (!this.canStart() || !this.intent) throw new Error('f06_original_begin_unproven');
    const expected = {
      ...this.identity,
      permit_id: this.intent.permit_id,
      hand_number: this.intent.hand_number,
    };
    for (const [k, v] of Object.entries(expected)) {
      if ((k !== 'admission_id' || input.p_admission_id !== undefined) && input['p_' + k] !== v)
        throw new Error('f06_original_begin_changed');
    }
    const roster =
      this.originalRoster?.intent.permit_id === this.intent.permit_id ? this.originalRoster : null;
    if (roster) assertOriginalRosterIdentity(roster, this.intent);
    if (
      'p_expected_complete_roster' in input ||
      ('p_admission_revision' in input &&
        input.p_admission_revision !== this.intent.admission_revision)
    )
      throw new Error('f06_original_begin_changed');
    const row = await this.call('fn_f06_begin_hand_with_intent', {
      ...input,
      p_admission_revision: this.intent.admission_revision,
      ...(roster ? { p_expected_complete_roster: roster.request } : {}),
    });
    if (!this.canStart()) throw new Error('f06_original_begin_retired');
    const numberRefused = row.ok === false && row.reason === 'hand_number_already_used';
    const originalRoster =
      roster && !numberRefused ? decodeOriginalRoster(roster, row, this.intent!) : undefined;
    return { data: row, error: null, ...(originalRoster ? { originalRoster } : {}) }; // Existing permit remains the custody owner.
  }
  /** Exact original-process observation after fencing; never a restart permit.
   * The SQL resolver still requires the original live lease/current lifecycle.
   * No local intent means only NOT_RETAINED, never a proof of zero durable work. */
  inspectQuarantine(): Promise<
    Readonly<{ admissionState: string; admissionRevision: string; intentState: string }>
  > {
    return this.serial(async () => {
      if (!this.retiring) throw new Error('f06_quarantine_fence_required');
      const admission = await this.call('fn_f06_resolve_engine_admission');
      this.exact(admission);
      if (
        admission.ok !== true ||
        !positive(admission.revision) ||
        !['ACTIVE', 'RETIRING', 'TERMINAL'].includes(String(admission.state))
      )
        throw new Error('f06_quarantine_admission_unknown');
      if (this.revision !== null) {
        const increment =
          admission.state === 'ACTIVE' ? 0n : admission.state === 'RETIRING' ? 1n : 2n;
        if (BigInt(admission.revision) !== BigInt(this.revision) + increment)
          throw new Error('f06_quarantine_revision_changed');
      }
      let intentState = 'NOT_RETAINED';
      if (this.pendingPermit) {
        const intent = await this.call('fn_f06_resolve_original_intent', {
          p_permit_id: this.pendingPermit,
        });
        this.exact(intent);
        if (
          intent.ok !== true ||
          intent.permit_id !== this.pendingPermit ||
          intent.admission_revision !== this.revision ||
          !['INTENT', 'BOUND', 'TERMINAL'].includes(String(intent.state))
        )
          throw new Error('f06_quarantine_intent_unknown');
        this.retainHand(intent);
        if (
          intent.state === 'TERMINAL' &&
          (intent.canonical_terminal_verified !== true ||
            intent.terminal_permit_id !== this.pendingPermit)
        )
          throw new Error('f06_intent_terminal_unproven');
        intentState = String(intent.state);
      }
      return Object.freeze({
        admissionState: String(admission.state),
        admissionRevision: admission.revision,
        intentState,
      });
    });
  }
  /** Local evidence only. Queue behind admit/allocate/inspect without new RPCs.
   * BEGIN is not on that queue: completion is NOT an original writer fence.
   * Missing local intent remains unknown, never proof of zero hands. */
  retainedRetirementBinding(): Promise<RetainedRetirementBinding> {
    return this.serial(async () => {
      if (!this.retiring) throw new Error('f06_retirement_fence_required');
      this.assertOwner();
      const intent: RetainedRetirementBinding['intent'] = this.intent
        ? Object.freeze({ kind: 'retained' as const, binding: Object.freeze({ ...this.intent }) })
        : this.pendingPermit
          ? Object.freeze({ kind: 'unresolved' as const, permitId: this.pendingPermit })
          : Object.freeze({ kind: 'not_retained' as const });
      this.assertOwner();
      return Object.freeze({
        admission: Object.freeze({ ...this.identity }),
        admissionRevision: this.revision,
        intent,
      });
    });
  }
  /** Immediate read-only view; no owner callbacks, waits, RPCs or authority. */
  getLifecycleDiagnosticSnapshot() {
    return Object.freeze({
      ...this.lifecycleDiagnostics.snapshot(),
      original: this.identity,
      admissionRevision: this.revision,
      permitId: this.pendingPermit,
      retiring: this.retiring,
      totalWriterAttempts: this.writerOrdinal,
      pendingWriters: this.writers.reduce((n, writer) => n + Number(writer.state === 'pending'), 0),
      recentWriters: Object.freeze(
        this.writers.slice(-32).map((writer) =>
          Object.freeze({
            operationId: writer.operationId,
            attempt: writer.attempt,
            kind: writer.kind,
            handNumber: writer.handNumber,
            admissionRevision: writer.admissionRevision,
            state: writer.state,
          })
        )
      ),
    });
  }
  /** Call before retirement's first await. Refusal stays latched on unknown outcome. */
  fenceForRetirement(): void {
    if (!this.retiring) this.lifecycleDiagnostics.record('retirement_fenced');
    this.retiring = true;
  }
}
