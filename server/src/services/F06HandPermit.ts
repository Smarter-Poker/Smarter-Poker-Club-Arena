import { observeCurrentEngineWriter } from './F06EngineWriterCapture.js';
import { createHmac, timingSafeEqual } from 'node:crypto';
export type F06Rpc = (
  name: string,
  input: Record<string, unknown>
) => Promise<{ data: unknown; error: unknown }>;
export interface F06HandIdentity {
  tournament_id: string;
  lease_generation: string;
  table_id: string;
  lifecycle: string;
  permit_id: string;
  hand_number: string;
  custody_id: string;
}
export interface F06TerminationReceipt extends F06HandIdentity {
  schema_version: 1;
  evidence_id: string;
  process_boot_id: string;
  engine_generation: string;
  key_id: string;
  outcome: 'never_started';
  signature: string;
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function identity(input: F06HandIdentity): Readonly<F06HandIdentity> {
  for (const key of [
    'tournament_id',
    'lease_generation',
    'table_id',
    'permit_id',
    'custody_id',
  ] as const)
    if (!uuid.test(input[key])) throw new Error('f06_identity_invalid');
  for (const key of ['lifecycle', 'hand_number'] as const)
    if (
      typeof input[key] !== 'string' ||
      !/^(0|[1-9][0-9]{0,18})$/.test(input[key]) ||
      BigInt(input[key]) > 9223372036854775807n
    )
      throw new Error('f06_bigint_invalid');
  return Object.freeze({ ...input });
}
function payload(r: Omit<F06TerminationReceipt, 'signature'>): string {
  return JSON.stringify([
    r.schema_version,
    r.evidence_id,
    r.tournament_id,
    r.lease_generation,
    r.table_id,
    r.lifecycle,
    r.permit_id,
    r.hand_number,
    r.custody_id,
    r.process_boot_id,
    r.engine_generation,
    r.key_id,
    r.outcome,
  ]);
}
/** The delegated key must be provisioned/registered by SQL's trusted custody
 * authority, scoped to this boot, engine and exact permit. Signing is NOT
 * durability: finish_hand may use evidence_id only after SQL stores/verifies it. */
export class F06HandPermit {
  readonly binding: Readonly<F06HandIdentity>;
  private phase: 'new' | 'reserved' | 'unknown' | 'attempted' | 'terminated' | 'number_refused' =
    'new';
  private receipt: Readonly<F06TerminationReceipt> | null = null;
  private drainedWithoutStart = false;
  private durableCustodyEvidence: string | null = null;
  constructor(
    input: F06HandIdentity,
    private readonly rpc: F06Rpc,
    private readonly current: () => boolean,
    private readonly startAllowed: () => boolean = current
  ) {
    this.binding = identity(input);
  }
  recoveryState(): string {
    return this.phase;
  }
  private reserveInFlight = false;
  async reserve(): Promise<void> {
    if (this.reserveInFlight) throw new Error('f06_begin_in_flight');
    this.reserveInFlight = true;
    try {
      await this.reserveOriginal();
    } finally {
      this.reserveInFlight = false;
    }
  }
  private async reserveOriginal(): Promise<void> {
    if (this.phase === 'reserved') {
      if (!this.current()) throw new Error('f06_owner_changed');
      return;
    }
    if (this.phase !== 'new' && this.phase !== 'unknown') throw new Error('f06_permit_consumed');
    if (!this.current()) throw new Error('f06_owner_changed');
    this.phase = 'unknown';
    const b = this.binding;
    const result = await this.rpc(
      'fn_f06_begin_hand',
      Object.fromEntries(Object.entries(b).map(([k, v]) => ['p_' + k, v]))
    );
    if (!this.current() || this.phase !== 'unknown') throw new Error('f06_owner_changed');
    const r = result.data as Record<string, unknown> | null;
    if (!result.error && r?.ok === false && r.reason === 'hand_number_already_used') {
      this.phase = 'number_refused';
      throw new Error('f06_hand_number_already_used');
    }
    if (
      result.error ||
      !r ||
      r.ok !== true ||
      r.tournament_id !== b.tournament_id ||
      r.generation !== b.lease_generation ||
      r.custody_id !== b.custody_id ||
      r.permit_id !== b.permit_id ||
      r.table_id !== b.table_id ||
      r.lifecycle !== b.lifecycle ||
      r.hand_number !== b.hand_number ||
      r.state !== 'reserved'
    )
      throw new Error('f06_permit_unproven');
    this.phase = 'reserved';
  }
  knownNumberRefusal(): boolean {
    return this.phase === 'number_refused';
  }
  async drainNeverStarted(stop: () => Promise<void>, released: () => boolean): Promise<void> {
    if (this.phase === 'attempted') throw new Error('f06_hand_may_have_started');
    this.phase = 'terminated';
    await stop();
    if (!released() || !this.current()) throw new Error('f06_termination_unproven');
    this.drainedWithoutStart = true;
  }
  async finishNeverStartedWithCustody(
    expected: { break_id: string; custody_id: string; revision: string },
    claim: () => Promise<unknown>
  ): Promise<void> {
    if (!this.drainedWithoutStart || this.phase !== 'terminated' || !this.current())
      throw new Error('f06_original_no_start_unproven');
    const row = (await claim()) as Record<string, unknown> | null;
    const b = this.binding;
    if (
      !this.current() ||
      !row ||
      row.ok !== true ||
      row.state !== 'park_requested' ||
      row.break_id !== expected.break_id ||
      row.custody_id !== expected.custody_id ||
      row.revision !== expected.revision ||
      row.custody_generation !== b.lease_generation ||
      row.tournament_id !== b.tournament_id ||
      row.source_table_id !== b.table_id ||
      row.lifecycle !== b.lifecycle
    )
      throw new Error('f06_original_custody_unproven');
    if (
      !/^[1-9][0-9]{0,18}$/.test(expected.revision) ||
      BigInt(expected.revision) > 9223372036854775807n
    )
      throw new Error('f06_custody_revision_invalid');
    this.durableCustodyEvidence = expected.custody_id;
    await this.finish('never_started', expected.custody_id);
  }
  /** Proposed Accounting exact-original adapter; not a claim of installation.
   * Covers committed/absent/delayed original BEGIN only after positive local drain. */
  async finishOriginalNeverStartedWithCustody(
    expected: { break_id: string; custody_id: string; revision: string },
    claim: () => Promise<unknown>
  ): Promise<void> {
    if (!this.drainedWithoutStart || this.phase !== 'terminated' || !this.current())
      throw new Error('f06_original_no_start_unproven');
    const row = (await claim()) as Record<string, unknown> | null;
    const b = this.binding;
    if (
      !this.current() ||
      !row ||
      row.ok !== true ||
      row.state !== 'park_requested' ||
      row.break_id !== expected.break_id ||
      row.custody_id !== expected.custody_id ||
      row.revision !== expected.revision ||
      row.custody_generation !== b.lease_generation ||
      row.tournament_id !== b.tournament_id ||
      row.source_table_id !== b.table_id ||
      row.lifecycle !== b.lifecycle ||
      !uuid.test(expected.break_id) ||
      !uuid.test(expected.custody_id) ||
      !/^[1-9][0-9]{0,18}$/.test(expected.revision) ||
      BigInt(expected.revision) > 9223372036854775807n
    )
      throw new Error('f06_original_custody_unproven');
    const validResponse = (value: unknown) => {
      const r = value as Record<string, unknown> | null;
      return (
        !!r &&
        r.ok === true &&
        r.state === 'never_started' &&
        r.tournament_id === b.tournament_id &&
        r.table_id === b.table_id &&
        r.permit_id === b.permit_id &&
        r.lifecycle === b.lifecycle &&
        r.hand_number === b.hand_number &&
        r.custody_id === b.custody_id &&
        r.generation === b.lease_generation &&
        r.evidence_id === expected.custody_id
      );
    };
    const result = await observeCurrentEngineWriter(
      'permit-finish',
      JSON.stringify({
        ...b,
        retirementBreakId: expected.break_id,
        parkCustodyId: expected.custody_id,
        parkRevision: expected.revision,
        kind: 'raw-no-start',
      }),
      () =>
        this.rpc('fn_f06_finish_original_no_start', {
          p_tournament_id: b.tournament_id,
          p_lease_generation: b.lease_generation,
          p_table_id: b.table_id,
          p_lifecycle: b.lifecycle,
          p_permit_id: b.permit_id,
          p_hand_number: b.hand_number,
          p_original_custody_id: b.custody_id,
          p_break_id: expected.break_id,
          p_park_custody_id: expected.custody_id,
          p_park_revision: expected.revision,
        }),
      (value) => !!value.error || !validResponse(value.data)
    );
    const r = result.data as Record<string, unknown> | null;
    if (
      !this.current() ||
      result.error ||
      !r ||
      r.ok !== true ||
      r.state !== 'never_started' ||
      r.tournament_id !== b.tournament_id ||
      r.table_id !== b.table_id ||
      r.permit_id !== b.permit_id ||
      r.lifecycle !== b.lifecycle ||
      r.hand_number !== b.hand_number ||
      r.custody_id !== b.custody_id ||
      r.generation !== b.lease_generation ||
      r.evidence_id !== expected.custody_id
    )
      throw new Error('f06_original_finish_unproven');
  }
  async finish(outcome: 'accepted' | 'never_started', evidenceId: string): Promise<void> {
    if (!uuid.test(evidenceId)) throw new Error('f06_evidence_invalid');
    if (outcome === 'accepted' && this.phase !== 'attempted')
      throw new Error('f06_hand_not_attempted');
    if (outcome === 'never_started' && this.durableCustodyEvidence !== evidenceId)
      throw new Error('f06_termination_evidence_missing');
    if (!this.current()) throw new Error('f06_owner_changed');
    const b = this.binding;
    // SQL must verify the evidence row, not trust the local phase or signature.
    const result = await this.rpc('fn_f06_finish_hand', {
      p_tournament_id: b.tournament_id,
      p_lease_generation: b.lease_generation,
      p_permit_id: b.permit_id,
      p_outcome: outcome,
      p_evidence_id: evidenceId,
    });
    if (!this.current()) throw new Error('f06_owner_changed');
    const row = result.data as Record<string, unknown> | null;
    if (
      result.error ||
      !row ||
      row.ok !== true ||
      row.tournament_id !== b.tournament_id ||
      row.generation !== b.lease_generation ||
      row.custody_id !== b.custody_id ||
      row.evidence_id !== evidenceId ||
      row.permit_id !== b.permit_id ||
      row.table_id !== b.table_id ||
      row.lifecycle !== b.lifecycle ||
      row.hand_number !== b.hand_number ||
      row.state !== outcome
    )
      throw new Error('f06_finish_unproven');
  }
  /** Must wrap the final synchronous persistence/start block, with no await. */
  start(actuate: () => void): void {
    if (this.phase !== 'reserved' || !this.current() || !this.startAllowed())
      throw new Error('f06_start_unproven');
    this.phase = 'attempted'; // A partial throw never becomes never_started.
    actuate();
  }
  async terminateUnstarted(
    stop: () => Promise<void>,
    released: () => boolean,
    proof: {
      evidence_id: string;
      process_boot_id: string;
      engine_generation: string;
      key_id: string;
      key: Uint8Array;
    }
  ): Promise<Readonly<F06TerminationReceipt>> {
    if (this.receipt) return this.receipt;
    if (this.phase === 'attempted') throw new Error('f06_hand_may_have_started');
    for (const value of [
      proof.evidence_id,
      proof.process_boot_id,
      proof.engine_generation,
      proof.key_id,
    ])
      if (!uuid.test(value)) throw new Error('f06_termination_identity_invalid');
    if (proof.key.byteLength < 32) throw new Error('f06_termination_key_invalid');
    // Invalidates start synchronously before stop joins any pending work.
    this.phase = 'terminated';
    await stop();
    if (!released() || !this.current()) throw new Error('f06_termination_unproven');
    const body = {
      ...this.binding,
      schema_version: 1 as const,
      evidence_id: proof.evidence_id,
      process_boot_id: proof.process_boot_id,
      engine_generation: proof.engine_generation,
      key_id: proof.key_id,
      outcome: 'never_started' as const,
    };
    this.receipt = Object.freeze({
      ...body,
      signature: createHmac('sha256', proof.key).update(payload(body)).digest('hex'),
    });
    return this.receipt;
  }
}
export function verifyF06TerminationReceipt(
  receipt: F06TerminationReceipt,
  key: Uint8Array
): boolean {
  try {
    identity(receipt);
    if (
      receipt.schema_version !== 1 ||
      receipt.outcome !== 'never_started' ||
      !/^[a-f0-9]{64}$/.test(receipt.signature)
    )
      return false;
    for (const v of [
      receipt.evidence_id,
      receipt.process_boot_id,
      receipt.engine_generation,
      receipt.key_id,
    ])
      if (!uuid.test(v)) return false;
    const expected = createHmac('sha256', key).update(payload(receipt)).digest();
    return timingSafeEqual(expected, Buffer.from(receipt.signature, 'hex'));
  } catch {
    return false;
  }
}
