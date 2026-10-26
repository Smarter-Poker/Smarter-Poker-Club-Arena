/** Kernel-specific dual binding: the executed decision remains actual FAST or
 * DEEP; only the information set comes from the uniquely retained FAST record. */
import type {
  FastHorseDecisionRequest,
  DeepHorseDecisionRequest,
} from '../../engine/horseDecision/protocol.js';
import { buildHorseDecisionKey } from '../../engine/horseDecision/protocol.js';
import type { HorseJournalRecord } from '../horseDecisionJournal/record.js';
import { validateHorseJournalRecord } from '../horseDecisionJournal/record.js';
import type { CorrectiveReferenceBinding } from './contract.js';
import { correctiveReferenceBinding } from './review.js';
import { evidenceDigest } from './authority.js';
const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
const hash = (v: unknown) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
interface Capture {
  snapshot: FastHorseDecisionRequest | DeepHorseDecisionRequest;
  readFrame: unknown;
  rngBefore: number;
  originalFastBinding?: unknown;
}
export interface KernelOriginalReferenceBinding extends CorrectiveReferenceBinding {
  kernelOriginal?: Readonly<{
    version: 'horse-kernel-original-reference-v1';
    decisionEventId: string;
    decisionDigest: string;
    executedInputDigest: string;
    executedReadFrameDigest: string;
  }>;
}
export type KernelOriginalInputResult =
  | {
      status: 'resolved';
      decisionSnapshot: FastHorseDecisionRequest | DeepHorseDecisionRequest;
      original: { snapshot: FastHorseDecisionRequest; readFrame: unknown };
      originalFastRecord: HorseJournalRecord;
    }
  | { status: 'unavailable'; reason: string };
/** Pure record resolver. It authenticates no arbitrary source: acquisition and
 * full accepted execution reconciliation remain required by its callers. */
export function resolveKernelRetainedFastInput(
  records: readonly HorseJournalRecord[],
  actualDecision: HorseJournalRecord
): KernelOriginalInputResult {
  const no = (reason: string): KernelOriginalInputResult => ({ status: 'unavailable', reason });
  try {
    validateHorseJournalRecord(actualDecision);
    if (actualDecision.kind !== 'decision' || !Array.isArray(records) || records.length > 256)
      return no('kernel_actual_decision_invalid');
    if (
      records.filter(
        (r) => r.eventId === actualDecision.eventId && r.sha256 === actualDecision.sha256
      ).length !== 1
    )
      return no('kernel_actual_decision_unbound');
    const capture = JSON.parse(actualDecision.body) as Capture,
      snapshot = capture.snapshot;
    if (
      !snapshot ||
      !['DECIDE_FAST', 'DECIDE_DEEP'].includes(snapshot.type) ||
      !snapshot.player ||
      !snapshot.gameState ||
      snapshot.decisionKey !== buildHorseDecisionKey(snapshot)
    )
      return no('kernel_actual_snapshot_invalid');
    if (
      !Number.isSafeInteger(capture.rngBefore) ||
      capture.rngBefore < 0 ||
      capture.rngBefore > 0xffffffff
    )
      return no('kernel_original_rng_unavailable');
    if (snapshot.type === 'DECIDE_FAST')
      return {
        status: 'resolved',
        decisionSnapshot: snapshot,
        original: { snapshot, readFrame: capture.readFrame },
        originalFastRecord: actualDecision,
      };
    if (!Number.isFinite(snapshot.deepEquity) || snapshot.deepEquity <= 1)
      return no('kernel_deep_request_invalid');
    const pin = capture.originalFastBinding;
    if (
      !object(pin) ||
      Object.keys(pin).sort().join(',') !== 'inputDigest,readFrameDigest' ||
      !hash(pin.inputDigest) ||
      !hash(pin.readFrameDigest) ||
      evidenceDigest(capture.readFrame) !== pin.readFrameDigest ||
      snapshot.rngBefore !== capture.rngBefore
    )
      return no('kernel_deep_original_binding_unavailable');
    const matches: Array<{ record: HorseJournalRecord; capture: Capture }> = [];
    for (const record of records) {
      validateHorseJournalRecord(record);
      if (
        record.kind !== 'decision' ||
        record.producerId !== actualDecision.producerId ||
        record.sourceRelease !== actualDecision.sourceRelease ||
        record.handKey !== actualDecision.handKey ||
        record.sequence >= actualDecision.sequence
      )
        continue;
      const prior = JSON.parse(record.body) as Capture,
        fast = prior.snapshot;
      if (fast?.type !== 'DECIDE_FAST') continue;
      if (
        evidenceDigest(fast) !== pin.inputDigest ||
        evidenceDigest(prior.readFrame) !== pin.readFrameDigest
      )
        continue;
      if (
        fast.decisionKey !== buildHorseDecisionKey(fast) ||
        fast.requestId >= snapshot.requestId ||
        fast.generation !== snapshot.generation ||
        fast.fence !== snapshot.fence ||
        fast.decisionTimeMs !== snapshot.decisionTimeMs ||
        fast.decisionKey !== snapshot.decisionKey ||
        fast.player.user_id !== snapshot.player.user_id ||
        fast.player.seat !== snapshot.player.seat ||
        prior.rngBefore !== capture.rngBefore
      )
        continue;
      matches.push({ record, capture: prior });
    }
    if (matches.length !== 1)
      return no(matches.length ? 'kernel_deep_original_ambiguous' : 'kernel_deep_original_missing');
    return {
      status: 'resolved',
      decisionSnapshot: snapshot,
      original: {
        snapshot: matches[0].capture.snapshot as FastHorseDecisionRequest,
        readFrame: matches[0].capture.readFrame,
      },
      originalFastRecord: matches[0].record,
    };
  } catch {
    return no('kernel_original_record_refused');
  }
}
export function resolveKernelOriginalInput(
  records: readonly HorseJournalRecord[],
  actualDecision: HorseJournalRecord,
  execution: HorseJournalRecord,
  accepted: HorseJournalRecord
):
  | (Extract<KernelOriginalInputResult, { status: 'resolved' }> & {
      binding: KernelOriginalReferenceBinding;
      executionBinding: CorrectiveReferenceBinding;
    })
  | Extract<KernelOriginalInputResult, { status: 'unavailable' }> {
  const resolved = resolveKernelRetainedFastInput(records, actualDecision);
  if (resolved.status !== 'resolved') return resolved;
  try {
    validateHorseJournalRecord(execution);
    validateHorseJournalRecord(accepted);
    if (
      execution.kind !== 'execution' ||
      accepted.kind !== 'accepted_hand' ||
      execution.turnKey !== actualDecision.turnKey ||
      execution.producerId !== actualDecision.producerId ||
      execution.sequence <= actualDecision.sequence ||
      execution.handKey !== actualDecision.handKey ||
      accepted.handKey !== actualDecision.handKey ||
      execution.sourceRelease !== actualDecision.sourceRelease ||
      accepted.sourceRelease !== actualDecision.sourceRelease
    )
      return { status: 'unavailable', reason: 'kernel_execution_chain_unbound' };
    const executionBinding = correctiveReferenceBinding(actualDecision, execution, accepted);
    const binding: KernelOriginalReferenceBinding =
      resolved.decisionSnapshot.type === 'DECIDE_FAST'
        ? executionBinding
        : {
            ...executionBinding,
            inputDigest: evidenceDigest(resolved.original.snapshot),
            readFrameDigest: evidenceDigest(resolved.original.readFrame),
            kernelOriginal: {
              version: 'horse-kernel-original-reference-v1',
              decisionEventId: resolved.originalFastRecord.eventId,
              decisionDigest: resolved.originalFastRecord.sha256,
              executedInputDigest: executionBinding.inputDigest,
              executedReadFrameDigest: executionBinding.readFrameDigest,
            },
          };
    return { ...resolved, binding, executionBinding };
  } catch {
    return { status: 'unavailable', reason: 'kernel_execution_chain_refused' };
  }
}
/** Used only after full maintained hand reconciliation has validated witness
 * selection, hand binding, amounts, retirement reason and accepted actions. */
export function kernelReconciledExecutionDisposition(
  execution: HorseJournalRecord
): 'accepted' | 'retired' | 'unavailable' {
  try {
    const w = JSON.parse(execution.body);
    if (
      w.executionStatus === 'not_executed' &&
      Array.isArray(w.acceptedActions) &&
      w.acceptedActions.length === 0 &&
      w.executedAction === null &&
      w.executedAmount === null &&
      [
        'caller_settled',
        'turn_abandoned',
        'response_fence',
        'second_look_replaced',
        'second_look_unchanged',
        'brain_exception',
        'action_rejected',
      ].includes(w.retirementReason)
    )
      return 'retired';
    if (
      w.executionStatus === 'intended' &&
      w.retirementReason === null &&
      Array.isArray(w.acceptedActions) &&
      w.acceptedActions.length === 1
    )
      return 'accepted';
    return 'unavailable';
  } catch {
    return 'unavailable';
  }
}
