import type { AllIntentExpectation, AllIntentHandEvidence } from './F06AllIntentEvidence.js';
import type { SessionWriterObservation } from './F06OriginalIntentSession.js';
import type { TerminalAdmissionEvidence } from './F06RetirementEvidence.js';

export interface AllocatorAbsenceEvidence {
  readonly kind: 'allocator_absence';
  readonly permitId: string;
  readonly originalAdmissionRevision: string;
  readonly rpc: 'fn_f06_allocate_original_intent';
  readonly handNumber: null;
  readonly binding: Readonly<Record<string, string>>;
}
export interface CanonicalHandDisposition {
  readonly kind: 'canonical_hand';
  readonly hand: AllIntentHandEvidence;
}
type AttemptBase = Readonly<{
  attempt: number;
  operationId: string;
  observedState: SessionWriterObservation['state'];
}>;
export type MatchedDispositionAttempt =
  | (AttemptBase &
      Readonly<{
        kind: 'admission';
        disposition: Readonly<{
          kind: 'admission_registration';
          admissionId: string;
          originalAdmissionRevision: string;
        }>;
      }>)
  | (AttemptBase &
      Readonly<{
        kind: 'allocator';
        disposition: CanonicalHandDisposition | AllocatorAbsenceEvidence;
      }>)
  | (AttemptBase & Readonly<{ kind: 'begin'; disposition: CanonicalHandDisposition }>);
export interface OriginalDispositionEvidence {
  readonly original: AllIntentExpectation['original']['admission'];
  readonly originalAdmissionRevision: string;
  readonly retiringAdmissionRevision: string;
  readonly breakId: string;
  readonly parkCustodyId: string;
  readonly parkRevision: string;
  readonly canonicalHands: readonly AllIntentHandEvidence[];
  readonly allocatorAbsences: readonly AllocatorAbsenceEvidence[];
  readonly attempts: readonly MatchedDispositionAttempt[];
  readonly authority: 'none';
}
export interface TerminalDispositionEvidence {
  readonly terminal: TerminalAdmissionEvidence;
  /** The exact pre-ACK absence objects, never reissued against TERMINAL. */
  readonly allocatorAbsences: OriginalDispositionEvidence['allocatorAbsences'];
  readonly preCleanup: OriginalDispositionEvidence;
  readonly authority: 'none';
}
const decodedPreCleanup = new WeakSet<object>();
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const id = (x: unknown): x is string => typeof x === 'string' && uuid.test(x);
const positive = (x: unknown): x is string =>
  typeof x === 'string' && /^[1-9][0-9]{0,18}$/.test(x) && BigInt(x) <= 9223372036854775807n;
const hand = (x: unknown): x is string =>
  positive(x) && BigInt(x) >= 1000000n && BigInt(x) <= BigInt(Number.MAX_SAFE_INTEGER);
function fail(): never {
  throw new Error('f06_disposition_consumer_unproven');
}
function row(x: unknown): Record<string, unknown> {
  if (!x || typeof x !== 'object' || Array.isArray(x)) return fail();
  return x as Record<string, unknown>;
}
/** Pure evidence composition only. The future caller must separately authenticate
 * Manager provenance, live original observations, full handle, custody and SQL.
 * Public decoded values cannot mint authority or clear Session unknown states. */
export function decodeF06OriginalDisposition(
  value: unknown,
  absenceRows: readonly unknown[],
  expected: AllIntentExpectation
): OriginalDispositionEvidence {
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

  if (!Array.isArray(absenceRows)) return fail();
  const absences = new Map<string, AllocatorAbsenceEvidence>();
  for (const value of absenceRows) {
    const absence = row(value),
      ab = row(absence.binding),
      attempt = row(absence.attempt);
    if (
      absence.contract_version !== 1 ||
      absence.kind !== 'original_allocation_absence' ||
      absence.disposition !== 'no_original_intent_committed_and_future_allocation_excluded' ||
      absence.authority !== 'canonical_database_allocation_exclusion_only' ||
      attempt.rpc !== 'fn_f06_allocate_original_intent' ||
      !id(attempt.permit_id) ||
      attempt.admission_revision !== originalRevision ||
      attempt.hand_number !== null ||
      absences.has(attempt.permit_id) ||
      permits.has(attempt.permit_id)
    )
      return fail();
    for (const [key, v] of Object.entries(binding)) if (ab[key] !== v) return fail();
    absences.set(
      attempt.permit_id,
      Object.freeze({
        kind: 'allocator_absence',
        permitId: attempt.permit_id,
        originalAdmissionRevision: originalRevision,
        rpc: 'fn_f06_allocate_original_intent',
        handNumber: null,
        binding: Object.freeze({ ...binding }),
      })
    );
  }
  if (original.intent.kind === 'retained') {
    const i = original.intent.binding;
    if (
      Object.entries(a).some(([k, v]) => (i as unknown as Record<string, unknown>)[k] !== v) ||
      i.admission_revision !== originalRevision ||
      !hand(i.hand_number) ||
      permits.get(i.permit_id)?.handNumber !== i.hand_number ||
      absences.has(i.permit_id)
    )
      return fail();
  } else if (original.intent.kind === 'unresolved') {
    if (
      !id(original.intent.permitId) ||
      (!permits.has(original.intent.permitId) && !absences.has(original.intent.permitId))
    )
      return fail();
  } else if (original.intent.kind !== 'not_retained') return fail();
  const observation = expected.writers;
  if (
    observation.admissionId !== a.admission_id ||
    observation.admissionRevision !== originalRevision ||
    observation.originalGeneration !== a.lease_generation ||
    observation.coverage !== 'captured-before-first-writer' ||
    !Array.isArray(observation.writers) ||
    !Number.isSafeInteger(observation.lastAttempt) ||
    observation.lastAttempt !== observation.writers.length
  )
    return fail();
  let ordinal = 0;
  const matchedAbsences = new Set<string>();
  const names = {
    admission: 'fn_f06_register_engine_admission',
    allocator: 'fn_f06_allocate_original_intent',
    begin: 'fn_f06_begin_hand_with_intent',
  };
  const attempts = observation.writers.map(
    (w: SessionWriterObservation): MatchedDispositionAttempt => {
      if (
        !['admission', 'allocator', 'begin'].includes(w.kind) ||
        w.rpc !== names[w.kind] ||
        !Number.isSafeInteger(w.attempt) ||
        w.attempt !== ++ordinal ||
        !id(w.operationId) ||
        !['returned', 'unknown', 'positively-resolved'].includes(w.state)
      )
        return fail();
      const base = { attempt: w.attempt, operationId: w.operationId, observedState: w.state };
      if (w.kind === 'admission') {
        if (
          w.operationId !== a.admission_id ||
          w.admissionRevision !== null ||
          w.handNumber !== null
        )
          return fail();
        return Object.freeze({
          ...base,
          kind: 'admission',
          disposition: Object.freeze({
            kind: 'admission_registration',
            admissionId: a.admission_id,
            originalAdmissionRevision: originalRevision,
          }),
        });
      }
      if (w.admissionRevision !== originalRevision) return fail();
      const h = permits.get(w.operationId),
        absence = absences.get(w.operationId);
      if (w.kind === 'begin') {
        if (absence || !h || !hand(w.handNumber) || w.handNumber !== h.handNumber) return fail();
        return Object.freeze({
          ...base,
          kind: 'begin',
          disposition: Object.freeze({ kind: 'canonical_hand', hand: h }),
        });
      }
      if (w.handNumber !== null || Boolean(h) === Boolean(absence)) return fail();
      if (absence) {
        matchedAbsences.add(w.operationId);
        return Object.freeze({ ...base, kind: 'allocator', disposition: absence });
      }
      return Object.freeze({
        ...base,
        kind: 'allocator',
        disposition: Object.freeze({ kind: 'canonical_hand', hand: h! }),
      });
    }
  );
  if (matchedAbsences.size !== absences.size) return fail();
  const result: OriginalDispositionEvidence = Object.freeze({
    original: Object.freeze({ ...a }),
    originalAdmissionRevision: originalRevision,
    retiringAdmissionRevision: retiring,
    breakId: expected.breakId,
    parkCustodyId: expected.parkCustodyId,
    parkRevision: expected.parkRevision,
    canonicalHands: Object.freeze(hands),
    allocatorAbsences: Object.freeze([...absences.values()]),
    attempts: Object.freeze(attempts),
    authority: 'none',
  });
  decodedPreCleanup.add(result);
  return result;
}
/** Retains exact decoded pre-ACK objects. This WeakSet proves codec provenance
 * only, not authentic Manager/Lease authority or current custody. No RPC occurs. */
export function decodeF06TerminalDisposition(
  value: unknown,
  pre: OriginalDispositionEvidence,
  cleanupKind: 'retired' | 'verified_absent'
): TerminalDispositionEvidence {
  if (!decodedPreCleanup.has(pre) || !['retired', 'verified_absent'].includes(cleanupKind))
    return fail();
  const r = row(value),
    receipt = row(r.terminal_receipt),
    a = pre.original;
  const terminalRevision = (BigInt(pre.originalAdmissionRevision) + 2n).toString();
  if (!positive(terminalRevision)) return fail();
  for (const [key, v] of Object.entries(a)) if (r[key] !== v) return fail();
  if (
    r.ok !== true ||
    r.state !== 'TERMINAL' ||
    r.revision !== terminalRevision ||
    r.origin_generation !== a.lease_generation ||
    r.original_custody_id !== a.custody_id ||
    r.retirement_break_id !== pre.breakId ||
    r.retirement_custody_id !== pre.parkCustodyId ||
    r.retirement_operation_revision !== pre.parkRevision
  )
    return fail();
  const fields = {
    admission_id: a.admission_id,
    table_id: a.table_id,
    tournament_id: a.tournament_id,
    lifecycle: a.lifecycle,
    origin_generation: a.lease_generation,
    original_custody_id: a.custody_id,
    revision: terminalRevision,
    break_id: pre.breakId,
    park_custody_id: pre.parkCustodyId,
    park_revision: pre.parkRevision,
    cleanup_kind: cleanupKind,
  };
  for (const [key, v] of Object.entries(fields)) if (receipt[key] !== v) return fail();
  if (
    !Array.isArray(receipt.canonical_hands) ||
    receipt.canonical_hands.length !== pre.canonicalHands.length
  )
    return fail();
  const canonicalHands = pre.canonicalHands.map((h, index) => {
    const actual = row((receipt.canonical_hands as unknown[])[index]);
    if (
      actual.permit_id !== h.permitId ||
      actual.hand_number !== h.handNumber ||
      actual.state !== h.outcome ||
      actual.evidence_id !== h.evidenceId
    )
      return fail();
    return Object.freeze({
      permitId: h.permitId,
      handNumber: h.handNumber,
      outcome: h.outcome,
      evidenceId: h.evidenceId,
    });
  });
  const terminal: TerminalAdmissionEvidence = Object.freeze({
    admission: a,
    revision: terminalRevision,
    breakId: pre.breakId,
    parkCustodyId: pre.parkCustodyId,
    parkRevision: pre.parkRevision,
    cleanupKind,
    canonicalHands: Object.freeze(canonicalHands),
  });
  return Object.freeze({
    terminal,
    allocatorAbsences: pre.allocatorAbsences,
    preCleanup: pre,
    authority: 'none',
  });
}
