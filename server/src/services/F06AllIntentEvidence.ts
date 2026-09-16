import type {
  OriginalSessionWriterObservation,
  SessionWriterObservation,
} from './F06OriginalIntentSession.js';
import type { RetainedRetirementBinding } from './F06RetirementEvidence.js';

/** Wire preparation only. Accounting0039 was rejected for installation-boundary
 * gaps. No RPC caller, unknown-clear method or retirement permission is added. */
export const F06_ALL_INTENT_WIRE_DEPENDENCY = Object.freeze({
  packet: 'Accounting0039',
  sha256: 'af868ca68107e40bc1b58404f61b7b75db73eb35c0a886f5c982a5adace56eb3',
  status: 'unaccepted' as const,
});
export interface AllIntentExpectation {
  readonly original: RetainedRetirementBinding;
  readonly writers: OriginalSessionWriterObservation;
  readonly breakId: string;
  readonly parkCustodyId: string;
  readonly parkRevision: string;
}
export interface AllIntentHandEvidence {
  readonly permitId: string;
  readonly handNumber: string;
  readonly originalAdmissionRevision: string;
  readonly outcome: 'accepted' | 'never_started';
  readonly evidenceId: string;
}
export interface MatchedOriginalAttempt {
  readonly attempt: number;
  readonly kind: SessionWriterObservation['kind'];
  readonly operationId: string;
  readonly observedState: SessionWriterObservation['state'];
  readonly canonicalHand: AllIntentHandEvidence | null;
}
export interface AllIntentEvidence {
  readonly original: RetainedRetirementBinding['admission'];
  readonly originalAdmissionRevision: string;
  readonly retiringAdmissionRevision: string;
  readonly breakId: string;
  readonly parkCustodyId: string;
  readonly parkRevision: string;
  readonly canonicalHands: readonly AllIntentHandEvidence[];
  readonly matchedAttempts: readonly MatchedOriginalAttempt[];
  readonly authority: 'none';
  readonly dependencyStatus: 'unaccepted';
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const id = (x: unknown): x is string => typeof x === 'string' && uuid.test(x);
const positive = (x: unknown): x is string =>
  typeof x === 'string' && /^[1-9][0-9]{0,18}$/.test(x) && BigInt(x) <= 9223372036854775807n;
const hand = (x: unknown): x is string =>
  positive(x) && BigInt(x) >= 1000000n && BigInt(x) <= BigInt(Number.MAX_SAFE_INTEGER);
function fail(): never {
  throw new Error('f06_all_intent_evidence_unproven');
}
function row(x: unknown): Record<string, unknown> {
  if (!x || typeof x !== 'object' || Array.isArray(x)) return fail();
  return x as Record<string, unknown>;
}
/** Pure decoder and attempt matcher. Inputs must eventually come from the actual
 * retained binding under qualified custody. It cannot establish provenance,
 * physically join writers, certify SQL installation or mutate session outcomes. */
export function decodeF06AllIntentDisposition(
  value: unknown,
  expected: AllIntentExpectation
): AllIntentEvidence {
  const original = expected.original;
  const a = original.admission;
  if (
    !positive(a.lifecycle) ||
    !positive(original.admissionRevision) ||
    !id(a.admission_id) ||
    !id(a.tournament_id) ||
    !id(a.table_id) ||
    !id(a.lease_generation) ||
    !id(a.custody_id) ||
    !id(expected.breakId) ||
    !id(expected.parkCustodyId) ||
    !positive(expected.parkRevision)
  )
    return fail();
  const originalRevision = original.admissionRevision;
  const retiring = (BigInt(originalRevision) + 1n).toString();
  if (!positive(retiring)) return fail();
  const r = row(value),
    b = row(r.binding);
  const binding = {
    admission_id: a.admission_id,
    original_admission_revision: original.admissionRevision,
    retiring_admission_revision: retiring,
    tournament_id: a.tournament_id,
    table_id: a.table_id,
    lifecycle: a.lifecycle,
    origin_generation: a.lease_generation,
    original_custody_id: a.custody_id,
    break_id: expected.breakId,
    park_custody_id: expected.parkCustodyId,
    park_revision: expected.parkRevision,
  };
  for (const [key, v] of Object.entries(binding)) if (b[key] !== v) return fail();
  if (
    r.contract_version !== 1 ||
    r.kind !== 'original_all_intent_disposition' ||
    r.authority !== 'canonical_database_disposition_only' ||
    r.new_original_intents_excluded !== true ||
    !Array.isArray(r.canonical_hands) ||
    !Number.isSafeInteger(r.intent_count) ||
    r.intent_count !== r.canonical_hands.length
  )
    return fail();
  let previous = 0n;
  const permits = new Map<string, AllIntentHandEvidence>();
  const hands = r.canonical_hands.map((value: unknown): AllIntentHandEvidence => {
    const h = row(value);
    if (
      !id(h.permit_id) ||
      permits.has(h.permit_id) ||
      !hand(h.hand_number) ||
      BigInt(h.hand_number) <= previous ||
      h.original_admission_revision !== original.admissionRevision ||
      !id(h.evidence_id) ||
      (h.state !== 'accepted' && h.state !== 'never_started') ||
      (h.state === 'never_started' && h.evidence_id !== expected.parkCustodyId)
    )
      return fail();
    previous = BigInt(h.hand_number);
    const result = Object.freeze({
      permitId: h.permit_id,
      handNumber: h.hand_number,
      originalAdmissionRevision: originalRevision,
      outcome: h.state,
      evidenceId: h.evidence_id,
    });
    permits.set(h.permit_id, result);
    return result;
  });
  if (original.intent.kind === 'retained') {
    const i = original.intent.binding;
    if (
      Object.entries(a).some(([k, v]) => (i as unknown as Record<string, unknown>)[k] !== v) ||
      i.admission_revision !== original.admissionRevision ||
      !hand(i.hand_number) ||
      permits.get(i.permit_id)?.handNumber !== i.hand_number
    )
      return fail();
  } else if (original.intent.kind === 'unresolved') {
    // Missing UUID is not an explicit negative resolver result. Keep uncertain
    // allocation open even if a proposed all-intent list happens to omit it.
    if (!id(original.intent.permitId) || !permits.has(original.intent.permitId)) return fail();
  } else if (original.intent.kind !== 'not_retained') return fail();
  const observation = expected.writers;
  if (
    observation.admissionId !== a.admission_id ||
    observation.admissionRevision !== original.admissionRevision ||
    observation.originalGeneration !== a.lease_generation ||
    observation.coverage !== 'captured-before-first-writer' ||
    !Array.isArray(observation.writers) ||
    !Number.isSafeInteger(observation.lastAttempt) ||
    observation.lastAttempt !== observation.writers.length
  )
    return fail();
  let ordinal = 0;
  const rpcNames = {
    admission: 'fn_f06_register_engine_admission',
    allocator: 'fn_f06_allocate_original_intent',
    begin: 'fn_f06_begin_hand_with_intent',
  };
  const matched = observation.writers.map((w: SessionWriterObservation): MatchedOriginalAttempt => {
    if (
      !['admission', 'allocator', 'begin'].includes(w.kind) ||
      w.rpc !== rpcNames[w.kind] ||
      !Number.isSafeInteger(w.attempt) ||
      w.attempt !== ordinal + 1 ||
      !id(w.operationId) ||
      !['returned', 'unknown', 'positively-resolved'].includes(w.state)
    )
      return fail();
    ordinal = w.attempt;
    let canonicalHand: AllIntentHandEvidence | null = null;
    if (w.kind === 'admission') {
      if (w.operationId !== a.admission_id || w.admissionRevision !== null || w.handNumber !== null)
        return fail();
    } else {
      if (w.admissionRevision !== original.admissionRevision) return fail();
      canonicalHand = permits.get(w.operationId) ?? null;
      if (
        !canonicalHand ||
        (w.kind === 'begin'
          ? !hand(w.handNumber) || w.handNumber !== canonicalHand.handNumber
          : w.handNumber !== null)
      )
        return fail();
    }
    return Object.freeze({
      attempt: w.attempt,
      kind: w.kind,
      operationId: w.operationId,
      observedState: w.state,
      canonicalHand,
    });
  });
  return Object.freeze({
    original: Object.freeze({ ...a }),
    originalAdmissionRevision: originalRevision,
    retiringAdmissionRevision: retiring,
    breakId: expected.breakId,
    parkCustodyId: expected.parkCustodyId,
    parkRevision: expected.parkRevision,
    canonicalHands: Object.freeze(hands),
    matchedAttempts: Object.freeze(matched),
    authority: 'none',
    dependencyStatus: 'unaccepted',
  });
}
