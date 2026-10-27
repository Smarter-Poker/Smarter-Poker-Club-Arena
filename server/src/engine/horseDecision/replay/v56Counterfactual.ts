/** Private, bounded FAST-only comparison. The caller must bind runningSource to
 * the actual clean executing checkout/image, as with exactReplay; this library
 * does not authenticate a supplied source string or acquire a journal. Old-source
 * records are never bridged. Output carries no hand coordinates, cards or amounts.
 * P14 hashes the replay framework: adding this verifier requires a new P14
 * composition before qualification; unchanged P8/P10–13 hashes do not waive it.
 */
import { enforceAuthoritativeDecision } from '../../HorseLogic.js';
import { calculateBettingState, validateAction } from '../../PokerEngine.js';
import { horseDecisionEffectsAreValid } from '../../HorseDecisionEffects.js';
import {
  horseDecisionReceiptIsValid,
  horseComputeMetadataIsValid,
  horseSamplingStateIsValid,
} from '../responseValidation.js';
import type { HorseReplayInput } from './reconstruct.js';
import type { HorseDecision } from '../../../types.js';
import type { CompletedHandObservation } from '../protocol.js';
import type { HorseExecutionWitness } from '../../HorseExecutionWitness.js';
import { bindHorseDecisionToCommittedHand } from '../../HorseDecisionHandBinding.js';
import { reconcileHorseJournalHand } from '../../../services/horseDecisionJournal/review.js';
import {
  horseJournalJson,
  journalHash,
  validateHorseJournalRecord,
  type HorseJournalRecord,
} from '../../../services/horseDecisionJournal/record.js';
import {
  horseDecisionReplayAdmissionMismatch,
  isHorseDecisionReplayState,
} from '../replayState.js';
import { reconstructHorseReplayInput } from './reconstruct.js';
import { replayThroughWorkerRuntime } from './runtimeReplay.js';
import {
  exactReplayHorseDecisionRecord,
  withFrozenHorseReplayClock,
  type HorseExactReplayOptions,
} from './exactReplay.js';

export const V56_COUNTERFACTUAL_VERSION = 'horse-v56-private-counterfactual-v1';
export type V56CounterfactualReason =
  | 'bounds'
  | 'busy'
  | 'invalid_records'
  | 'case_unbound'
  | 'unsupported_deep'
  | 'outside_domain'
  | 'original_v56_off'
  | 'pins_missing'
  | 'hand_not_reconciled'
  | 'execution_unbound'
  | 'baseline_not_exact'
  | 'baseline_not_accepted'
  | 'v56_witness_unavailable'
  | 'v56_not_observed'
  | 'off_arm_unavailable'
  | 'admission_changed'
  | 'original_mutated'
  | 'executed_no_difference'
  | 'causal_application_observed';
export interface V56CounterfactualCase {
  /** One exact original record digest, never an arbitrary executable candidate. */
  decisionSha256: string;
  records: readonly HorseJournalRecord[];
}
export interface V56CounterfactualResult {
  version: typeof V56_COUNTERFACTUAL_VERSION;
  reason: V56CounterfactualReason;
  decisionSha256: string | null;
  readFrameSha256: string | null;
  onActionSha256: string | null;
  offActionSha256: string | null;
  originalExact: boolean;
  originalAccepted: boolean;
  v56Observed: boolean;
  offComputed: boolean;
  sameAdmissions: boolean;
  actionChanged: boolean;
  /** The off arm is computed only, never an executed or accepted original. */
  offAccepted: false;
  activationAllowed: false;
}
let busy = false;
const HASH = /^[0-9a-f]{64}$/;
const actionHash = (decision: { action: string; amount?: number | null }) =>
  journalHash(horseJournalJson({ action: decision.action, amount: decision.amount ?? null }));
/** Read the original menu and amount owner without executing its corrected
 * result. A proposal that would be coerced is refused, never substituted. */
function offActionIsLegal(decision: HorseDecision, input: HorseReplayInput): boolean {
  const { player, gameState: gs } = input.request;
  if (gs.stateSchemaVersion !== 1 || !gs.legalActions?.includes(decision.action)) return false;
  if (['fold', 'check', 'all_in'].includes(decision.action) && decision.amount !== undefined)
    return false;
  const canonical = enforceAuthoritativeDecision(decision, player, gs);
  if (actionHash(canonical) !== actionHash(decision)) return false;
  const betting = calculateBettingState(
    gs.pot,
    gs.currentBet,
    player.bet,
    gs.bigBlind,
    gs.lastRaise ?? gs.minRaise,
    true
  );
  return validateAction(decision.action, decision.amount, player.stack, betting).valid;
}
const initial = (): V56CounterfactualResult => ({
  version: V56_COUNTERFACTUAL_VERSION,
  reason: 'invalid_records',
  decisionSha256: null,
  readFrameSha256: null,
  onActionSha256: null,
  offActionSha256: null,
  originalExact: false,
  originalAccepted: false,
  v56Observed: false,
  offComputed: false,
  sameAdmissions: false,
  actionChanged: false,
  offAccepted: false,
  activationAllowed: false,
});

/** No external writer, arbitrary overrides, reseeding, or decision-record edits.
 * Acquisition/source authentication remains the maintained private caller's duty.
 */
export async function verifyV56CounterfactualCases(
  cases: readonly V56CounterfactualCase[],
  options: Pick<HorseExactReplayOptions, 'runningSource' | 'stores' | 'releaseNotBeforeMs'>
): Promise<V56CounterfactualResult[]> {
  const no = (reason: V56CounterfactualReason) => [{ ...initial(), reason }];
  if (busy) return no('busy');
  try {
    if (
      !Array.isArray(cases) ||
      cases.length < 1 ||
      cases.length > 6 ||
      new Set(cases.map((c) => c.decisionSha256)).size !== cases.length ||
      Buffer.byteLength(JSON.stringify(cases)) > 32 * 1024 * 1024 ||
      cases.some(
        (c) =>
          !HASH.test(c.decisionSha256) ||
          !Array.isArray(c.records) ||
          c.records.length > 256 ||
          Buffer.byteLength(JSON.stringify(c.records)) > 8 * 1024 * 1024
      )
    )
      return no('bounds');
  } catch {
    return no('bounds');
  }
  busy = true;
  try {
    const results: V56CounterfactualResult[] = [];
    for (const item of cases) results.push(await verifyCase(item, options));
    return results;
  } finally {
    busy = false;
  }
}

async function verifyCase(
  item: V56CounterfactualCase,
  options: Pick<HorseExactReplayOptions, 'runningSource' | 'stores' | 'releaseNotBeforeMs'>
): Promise<V56CounterfactualResult> {
  const out = initial();
  const finish = (reason: V56CounterfactualReason) => ({ ...out, reason });
  try {
    for (const record of item.records) validateHorseJournalRecord(record);
    const matches = item.records.filter(
      (r) => r.kind === 'decision' && r.sha256 === item.decisionSha256
    );
    if (matches.length !== 1) return finish('case_unbound');
    const record = matches[0]!;
    out.decisionSha256 = record.sha256;
    if (
      item.records.some(
        (r) => r.handKey !== record.handKey || r.sourceRelease !== record.sourceRelease
      )
    )
      return finish('case_unbound');
    const body = JSON.parse(record.body);
    if (body.snapshot?.type !== 'DECIDE_FAST') return finish('unsupported_deep');
    const input = reconstructHorseReplayInput(record);
    out.readFrameSha256 = input.readFrame.sha256;
    const gs = input.request.gameState;
    if (
      !['plo4', 'plo5', 'plo6'].includes(gs.gameVariant ?? '') ||
      gs.gameMode !== 'cash' ||
      gs.stage !== 'river' ||
      gs.communityCards2?.length ||
      gs.communityCards3?.length
    )
      return finish('outside_domain');
    if (input.request.opts?.v56OmahaPressureRange === false) return finish('original_v56_off');
    if (!input.readiness.solverStoreIdentity || !isHorseDecisionReplayState(body.replayState))
      return finish('pins_missing');
    const review = reconcileHorseJournalHand(item.records, record.handKey);
    if (
      review.status !== 'reconciled' ||
      review.gaps.length ||
      review.acceptedHorseActions < 1 ||
      review.matchedActions !== review.acceptedHorseActions ||
      !review.requestLifecycleVerified
    )
      return finish('hand_not_reconciled');
    const executions = item.records.filter(
      (r) =>
        r.kind === 'execution' && r.turnKey === record.turnKey && r.producerId === record.producerId
    );
    const hands = item.records.filter((r) => r.kind === 'accepted_hand');
    if (executions.length !== 1 || hands.length !== 1) return finish('execution_unbound');
    const execution = executions[0]!;
    const witness = JSON.parse(execution.body) as HorseExecutionWitness;
    const hand = JSON.parse(hands[0]!.body) as CompletedHandObservation;
    if (
      witness.executionStatus !== 'intended' ||
      witness.retirementReason !== null ||
      bindHorseDecisionToCommittedHand(witness, hand).status !== 'bound'
    )
      return finish('execution_unbound');
    const receipts = item.records.filter(
      (r) =>
        r.kind === 'plan_receipt' &&
        r.turnKey === record.turnKey &&
        r.producerId === record.producerId
    );
    if (receipts.length > 1) return finish('execution_unbound');
    const baseline = await exactReplayHorseDecisionRecord(record, {
      ...options,
      execution,
      planReceipt: receipts[0] ?? null,
      captureV56PressureWitness: true,
    });
    if (!baseline.replayVerified) return finish('baseline_not_exact');
    out.originalExact = true;
    if (
      baseline.acceptance.status !== 'joined' ||
      baseline.acceptance.selectedEqualsDecision !== true ||
      baseline.acceptance.executionStatus !== 'intended' ||
      baseline.acceptance.acceptedActions !== 1 ||
      !['no_effects', 'applied'].includes(baseline.acceptance.durableEffectReceipt)
    )
      return finish('baseline_not_accepted');
    out.originalAccepted = true;
    out.onActionSha256 = actionHash(input.original);
    if (baseline.v56PressureRangeFires == null) return finish('v56_witness_unavailable');
    out.v56Observed = (baseline.v56PressureRangeFires ?? 0) > 0;
    if (!out.v56Observed) return finish('v56_not_observed');
    const originalDigest = journalHash(horseJournalJson(input));
    const state = body.replayState;
    const off = await withFrozenHorseReplayClock(input.request.decisionTimeMs, () =>
      replayThroughWorkerRuntime(input, {
        phase8SafetyDisabledReason: state.phase8SafetyDisabledReason,
        v56PressureCounterfactual: 'off',
        captureV56PressureWitness: true,
      })
    );
    if (journalHash(horseJournalJson(input)) !== originalDigest) return finish('original_mutated');
    if (
      !off.result ||
      off.error ||
      off.v56PressureRangeFires !== 0 ||
      off.result.rngBefore !== input.rngBefore ||
      off.result.governorScale !== input.governorScale ||
      off.result.type !== 'FAST_RESULT' ||
      off.result.requestId !== input.request.requestId ||
      off.result.generation !== input.request.generation ||
      off.result.fence !== input.request.fence ||
      !horseComputeMetadataIsValid(off.result) ||
      !horseSamplingStateIsValid(off.result.rngAfter) ||
      !horseDecisionEffectsAreValid(off.result.effects) ||
      !horseDecisionReceiptIsValid(off.result.decision, gs.gameVariant, {
        player: input.request.player,
        gameState: gs,
      }) ||
      !offActionIsLegal(off.result.decision, input)
    )
      return finish('off_arm_unavailable');
    out.offComputed = true;
    out.sameAdmissions =
      horseDecisionReplayAdmissionMismatch(off.admission, state.admission) === null &&
      (state.corrective
        ? horseJournalJson(off.corrective) === horseJournalJson(state.corrective)
        : off.corrective?.mode !== 'candidate');
    if (!out.sameAdmissions) return finish('admission_changed');
    out.offActionSha256 = actionHash(off.result.decision);
    out.actionChanged = out.onActionSha256 !== out.offActionSha256;
    return finish(out.actionChanged ? 'causal_application_observed' : 'executed_no_difference');
  } catch {
    return finish('invalid_records');
  }
}
