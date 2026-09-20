import type { F06HandPermit } from './F06HandPermit.js';
import type {
  OriginalAdmissionIdentity,
  OriginalIntentIdentity,
} from './F06OriginalIntentSession.js';

/** Retained local facts, not a durable no-start, drain or cleanup certificate. */
export interface RetainedRetirementBinding {
  readonly admission: Readonly<OriginalAdmissionIdentity>;
  readonly admissionRevision: string | null;
  readonly intent:
    | Readonly<{ kind: 'not_retained' }>
    | Readonly<{ kind: 'unresolved'; permitId: string }>
    | Readonly<{ kind: 'retained'; binding: Readonly<OriginalIntentIdentity> }>;
}
export interface TerminalAdmissionExpectation {
  readonly original: RetainedRetirementBinding;
  readonly breakId: string;
  readonly parkCustodyId: string;
  readonly parkRevision: string;
  readonly cleanupKind: 'retired' | 'verified_absent';
}
export interface CanonicalRetiredHand {
  readonly permitId: string;
  readonly handNumber: string;
  readonly outcome: 'accepted' | 'never_started';
  readonly evidenceId: string;
}
export interface TerminalAdmissionEvidence {
  readonly admission: Readonly<OriginalAdmissionIdentity>;
  readonly revision: string;
  readonly breakId: string;
  readonly parkCustodyId: string;
  readonly parkRevision: string;
  readonly cleanupKind: 'retired' | 'verified_absent';
  readonly canonicalHands: readonly CanonicalRetiredHand[];
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function fail(): never {
  throw new Error('f06_terminal_admission_unproven');
}
function row(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail();
  return value as Record<string, unknown>;
}
function positive(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[1-9][0-9]{0,18}$/.test(value) &&
    BigInt(value) <= 9223372036854775807n
  );
}
function id(value: unknown): value is string {
  return typeof value === 'string' && uuid.test(value);
}
function handNumber(value: unknown): value is string {
  return (
    positive(value) && BigInt(value) >= 1000000n && BigInt(value) <= BigInt(Number.MAX_SAFE_INTEGER)
  );
}
/** Pure shape/identity decoder. It performs no RPC or authority check and grants
 * no cleanup, movement, enrollment or restart permission. Callers must obtain
 * this row under a qualified exact original cleanup reservation and validate
 * that reservation before and after readback; no such caller is wired here. */
export function decodeF06TerminalAdmissionReceipt(
  value: unknown,
  expected: TerminalAdmissionExpectation
): Readonly<TerminalAdmissionEvidence> {
  const a = expected.original.admission;
  if (
    !positive(a.lifecycle) ||
    ['admission_id', 'tournament_id', 'table_id', 'lease_generation', 'custody_id'].some(
      (key) => !id(a[key as keyof OriginalAdmissionIdentity])
    ) ||
    !id(expected.breakId) ||
    !id(expected.parkCustodyId) ||
    !positive(expected.parkRevision) ||
    !positive(expected.original.admissionRevision) ||
    !['retired', 'verified_absent'].includes(expected.cleanupKind)
  )
    return fail();
  const revision = (BigInt(expected.original.admissionRevision) + 2n).toString();
  if (!positive(revision)) return fail();
  const r = row(value);
  for (const [key, value] of Object.entries(a)) if (r[key] !== value) return fail();
  if (
    r.ok !== true ||
    r.state !== 'TERMINAL' ||
    r.revision !== revision ||
    r.origin_generation !== a.lease_generation ||
    r.original_custody_id !== a.custody_id ||
    r.retirement_break_id !== expected.breakId ||
    r.retirement_custody_id !== expected.parkCustodyId ||
    r.retirement_operation_revision !== expected.parkRevision
  )
    return fail();
  const receipt = row(r.terminal_receipt);
  const fields: Record<string, string> = {
    admission_id: a.admission_id,
    table_id: a.table_id,
    tournament_id: a.tournament_id,
    lifecycle: a.lifecycle,
    origin_generation: a.lease_generation,
    original_custody_id: a.custody_id,
    revision,
    break_id: expected.breakId,
    park_custody_id: expected.parkCustodyId,
    park_revision: expected.parkRevision,
    cleanup_kind: expected.cleanupKind,
  };
  for (const [key, value] of Object.entries(fields)) if (receipt[key] !== value) return fail();
  if (!Array.isArray(receipt.canonical_hands)) return fail();
  const permits = new Set<string>();
  let previous = 0n;
  const hands: CanonicalRetiredHand[] = receipt.canonical_hands.map((value: unknown) => {
    const h = row(value);
    if (
      !id(h.permit_id) ||
      permits.has(h.permit_id) ||
      !handNumber(h.hand_number) ||
      BigInt(h.hand_number) <= previous ||
      !id(h.evidence_id) ||
      (h.state !== 'accepted' && h.state !== 'never_started') ||
      (h.state === 'never_started' && h.evidence_id !== expected.parkCustodyId)
    )
      return fail();
    permits.add(h.permit_id);
    previous = BigInt(h.hand_number);
    return Object.freeze({
      permitId: h.permit_id,
      handNumber: h.hand_number,
      outcome: h.state,
      evidenceId: h.evidence_id,
    });
  });
  const intent = expected.original.intent;
  if (intent.kind === 'retained') {
    const b = intent.binding;
    if (
      Object.entries(a).some(
        ([key, value]) => b[key as keyof OriginalAdmissionIdentity] !== value
      ) ||
      b.admission_revision !== expected.original.admissionRevision ||
      !id(b.permit_id) ||
      !handNumber(b.hand_number)
    )
      return fail();
    if (!hands.some((h) => h.permitId === b.permit_id && h.handNumber === b.hand_number))
      return fail();
  } else if (intent.kind === 'unresolved') {
    if (!id(intent.permitId) || !hands.some((h) => h.permitId === intent.permitId)) return fail();
  } else if (intent.kind !== 'not_retained') return fail();
  return Object.freeze({
    admission: Object.freeze({ ...a }),
    revision,
    breakId: expected.breakId,
    parkCustodyId: expected.parkCustodyId,
    parkRevision: expected.parkRevision,
    cleanupKind: expected.cleanupKind,
    canonicalHands: Object.freeze(hands),
  });
}

/** Compare the actual retained permit's shared identity, never its actuation or
 * drain state. Success is identity equality only, not retirement permission. */
export function assertF06RetainedPermitBinding(
  original: RetainedRetirementBinding,
  permit: Readonly<F06HandPermit['binding']>
): void {
  if (original.intent.kind !== 'retained' || !positive(original.admissionRevision)) return fail();
  const b = original.intent.binding;
  if (
    b.admission_revision !== original.admissionRevision ||
    Object.entries(original.admission).some(
      ([key, value]) => b[key as keyof OriginalAdmissionIdentity] !== value
    )
  )
    return fail();
  for (const key of [
    'tournament_id',
    'table_id',
    'lifecycle',
    'lease_generation',
    'custody_id',
    'permit_id',
    'hand_number',
  ] as const) {
    if (permit[key] !== b[key]) return fail();
  }
}
