import type { ActionType, ActionRecord, HorseDecision } from '../types.js';
import type { LiveHorseDecisionSnapshot } from './horseDecision/protocol.js';
import type { HorsePolicyGraphReceipt } from './HorsePolicyGraph.js';
import { noteFire } from './BrainTelemetry.js';
import { copyPhase6Attribution } from './HorsePhase6Attribution.js';
import { horseTournamentUtilityEvidenceSha256 } from './HorseTournamentUtilityEvidence.js';
import { plo4InputBindingSha256, type Plo4RangeStatus } from './plo4/Plo4LivePolicy.js';
import {
  omahaVariantInputBindingSha256,
  type OmahaVariantRangeStatus,
} from './omaha/OmahaVariantLivePolicy.js';
import type { OmahaPolicyVariant } from './omaha/OmahaVariantPolicyPack.js';
import {
  remainingVariantInputBindingSha256,
  type RemainingVariantRangeStatus,
} from './remainingVariants/RemainingVariantLivePolicy.js';
import type { RemainingPolicyVariant } from './remainingVariants/RemainingVariantPolicyPack.js';
import type { Phase8Selection } from './HorseTournamentPostflop.js';
import type { HorseAuthorityReceipt, HorseAuthorityVerdict } from './HorseQualifiedAuthority.js';
import {
  anchorHorseDecisionHand,
  type HorseDecisionHandAnchor,
  type HorseDecisionHandBinding,
} from './HorseDecisionHandBinding.js';

export type HorseExecutionRetirement =
  | 'caller_settled'
  | 'turn_abandoned'
  | 'response_fence'
  | 'second_look_replaced'
  | 'second_look_unchanged'
  | 'brain_exception'
  | 'action_rejected'
  | 'accepted_without_record'
  | 'accepted_context_mismatch'
  | 'accepted_amount_unverifiable'
  | 'multiple_accepted_actions';

/** Phase 8 authority binding: the exact continuation version, the worker
 * authority generation that admitted the decision and its final selection
 * outcome. Present whenever the decision carried a Phase 8 receipt. */
export interface HorseWitnessPhase8Authority {
  readonly continuationVersion: string;
  readonly mode: 'shadow' | 'candidate';
  selection: Phase8Selection;
  readonly authority: HorseAuthorityReceipt | null;
  /** Main scheduler verdict immediately before acceptance. */
  verdict: HorseAuthorityVerdict | null;
  readonly candidate: Readonly<{ action: ActionType; amount: number | null }>;
  readonly reference: Readonly<{ action: ActionType; amount: number | null }>;
}

/** P10.3 PLO4 authority binding: the Phase 8 shape, reused. Here
 * `continuationVersion` is the running PLO4 pack version, `candidate` is the
 * pack's proposal (the action selected when authority is usable) and
 * `reference` is the shadow baseline the table executes otherwise. The accepted
 * action is the witness's own `acceptedActions` / `executedAction`. Present
 * whenever the decision carried a P10.3 PLO4 receipt. */
export type HorseWitnessPhase10Authority = HorseWitnessPhase8Authority;

/** P11.3 PLO5/PLO6/PLO8 authority binding: the Phase 8 shape, reused as
 * Phase 10 reuses it. `continuationVersion` is the deciding pack's running
 * version (which names the variant), `candidate` its proposal and `reference`
 * the shadow baseline. Present whenever the decision carried a P11.3 Phase 11
 * receipt; absent on retained witnesses and every other variant. */
export type HorseWitnessPhase11Authority = HorseWitnessPhase8Authority;

type QualifiedAuthorityKey = 'phase8Authority' | 'phase10Authority' | 'phase11Authority';

export interface HorseAcceptedAction {
  readonly record: Readonly<
    Pick<ActionRecord, 'seat' | 'action' | 'amount' | 'stage'> &
      Partial<Pick<ActionRecord, 'userId' | 'timestamp' | 'isFullRaise'>>
  >;
  readonly intended: boolean;
}

/** Private, bounded receipt for a returned betting decision. This is not a
 * durable ledger or a replay input. Never serialize it into public table state:
 * the canonical digest binds the hero's private input, even though no cards or
 * RNG seeds are copied here. The existing flush publishes only finite counters.
 */
export interface HorseExecutionWitness {
  readonly version: 'horse-execution-witness-v4';
  readonly handAnchor: HorseDecisionHandAnchor;
  committedHand: HorseDecisionHandBinding;
  readonly identity: Readonly<{
    decisionKey: string;
    requestId: number;
    generation: number;
    fence: string;
    decisionTimeMs: number;
    lane: 'fast' | 'deep' | 'worker_fallback';
    variant: string;
    gameMode: string | null;
    stage: string;
    heroSeat: number | null;
    boardCount: number | null;
  }>;
  /** The intent the executor will submit. Readonly except for the Phase 8,
   * Phase 10 and Phase 11 authority withdrawals below, which re-select the
   * reference before acceptance. */
  readonly selected: Readonly<{ action: ActionType; amount: number | null }>;
  /** Canonical controller amount expected from the original request. Calls
   * record added chips; all-ins record the resulting street total. Null is
   * unavailable evidence, never permission to accept any wager amount. */
  readonly expectedExecutionAmount: number | null;
  readonly policyFallback: HorseDecision['policyFallback'] | null;
  readonly policyGraph: HorsePolicyGraphReceipt | null;
  /** Optional for retained v4 compatibility; absence never proves attribution. */
  readonly phase6Attribution?: HorseDecision['tournamentPreflopAttribution'] | null;
  /** Compact private commitment to the utility inputs and original read view.
   * Legacy absence is unavailable provenance, never calibrated-model proof. */
  readonly phase7Evidence?: Readonly<{
    version: 'horse-phase7-accepted-evidence-v1';
    inputSha256: string;
    evidenceSha256: string;
    readFrameSha256: string | null;
    selectedAction: ActionType;
    selectedAmount: number | null;
  }> | null;
  /** P10.1 compact private commitment to the facts the PLO4 proposal used and
   * the read frame it was decided against. Absent on retained legacy receipts
   * and null for a refused proposal; never strength or calibration proof. */
  readonly phase10Inputs?: Readonly<{
    version: 'horse-phase10-input-binding-v1';
    inputSha256: string;
    readFrameSha256: string | null;
    rangeStatus: Plo4RangeStatus;
  }> | null;
  /** P11.1 compact private commitment to the facts a PLO5/PLO6/PLO8 proposal
   * used. Present only on decisions with a Phase 11 receipt that carries the
   * binding field (null for a refused proposal); absent on retained witnesses
   * and every other variant. The variant sampler reads the public action line
   * only, so no read frame is bound. Never strength or calibration proof. */
  readonly phase11Inputs?: Readonly<{
    version: 'horse-phase11-input-binding-v1';
    variant: OmahaPolicyVariant;
    inputSha256: string;
    rangeStatus: OmahaVariantRangeStatus;
  }> | null;
  /** P12.1 compact private commitment to the facts a Short Deck, Pineapple,
   * FLH or FLO8 proposal used. Present only on decisions with a Phase 12
   * receipt that carries the binding field (null for a refused proposal);
   * absent on retained witnesses and every other variant. The sampler reads
   * the public action line only, so no read frame is bound. Never strength or
   * calibration proof. */
  readonly phase12Inputs?: Readonly<{
    version: 'horse-phase12-input-binding-v1';
    variant: RemainingPolicyVariant;
    inputSha256: string;
    rangeStatus: RemainingVariantRangeStatus;
  }> | null;
  readonly policyOwnership: Readonly<NonNullable<HorseDecision['policyOwnership']>> | null;
  /** Optional for retained v4 compatibility; absent means no Phase 8 receipt. */
  readonly phase8Authority?: HorseWitnessPhase8Authority | null;
  /** P10.3; absent on retained witnesses and decisions without a P10.3 PLO4 receipt. */
  readonly phase10Authority?: HorseWitnessPhase10Authority | null;
  /** P11.3; absent on retained witnesses and decisions without a P11.3 Phase 11 receipt. */
  readonly phase11Authority?: HorseWitnessPhase11Authority | null;
  readonly computeMs: number;
  readonly governorScale: number;
  executionStatus: 'pending' | 'intended' | 'coerced' | 'fallback' | 'not_executed' | 'unverified';
  executedAction: ActionType | null;
  executedAmount: number | null;
  retirementReason: HorseExecutionRetirement | null;
  acceptedActions: HorseAcceptedAction[];
}

/** Controller amount the canonical request expects for `decision`. */
export function expectedHorseExecutionAmount(
  snapshot: Pick<LiveHorseDecisionSnapshot, 'player' | 'gameState'>,
  decision: Pick<HorseDecision, 'action' | 'amount'>
): number | null {
  const chips = (value: unknown): value is number =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0;
  let expectedAmount: number | null = null;
  if (decision.action === 'check' || decision.action === 'fold') expectedAmount = 0;
  else if (decision.action === 'all_in') {
    if (chips(snapshot.player?.stack) && chips(snapshot.player?.bet))
      expectedAmount = snapshot.player.stack + snapshot.player.bet;
  } else if (chips(decision.amount)) expectedAmount = decision.amount;
  else if (
    decision.action === 'call' &&
    chips(snapshot.gameState.toCall) &&
    chips(snapshot.player?.stack)
  )
    expectedAmount = Math.min(snapshot.gameState.toCall, snapshot.player.stack);
  // Match the controller's cent normalization, including floating additions.
  if (expectedAmount !== null) {
    expectedAmount = Math.round(expectedAmount * 100) / 100;
    if (!Number.isFinite(expectedAmount)) expectedAmount = null;
  }
  return expectedAmount;
}

/**
 * The main scheduler found the authority behind a selected Phase 8 candidate
 * unusable immediately before acceptance. The pending witness keeps the
 * candidate in `phase8Authority` and re-selects the reference decision the
 * shadow path would have executed, so the exact accepted-wager check compares
 * the controller record against the action actually submitted.
 */
export function withdrawHorsePhase8Selection(
  witness: HorseExecutionWitness | undefined,
  snapshot: Pick<LiveHorseDecisionSnapshot, 'player' | 'gameState'>,
  verdict: HorseAuthorityVerdict
): void {
  withdrawHorseQualifiedSelection(witness, snapshot, verdict, 'phase8Authority');
}

/** P10.3: the same re-selection for a selected PLO4 candidate. */
export function withdrawHorsePhase10Selection(
  witness: HorseExecutionWitness | undefined,
  snapshot: Pick<LiveHorseDecisionSnapshot, 'player' | 'gameState'>,
  verdict: HorseAuthorityVerdict
): void {
  withdrawHorseQualifiedSelection(witness, snapshot, verdict, 'phase10Authority');
}

/** P11.3: the same re-selection for a selected PLO5/PLO6/PLO8 candidate. */
export function withdrawHorsePhase11Selection(
  witness: HorseExecutionWitness | undefined,
  snapshot: Pick<LiveHorseDecisionSnapshot, 'player' | 'gameState'>,
  verdict: HorseAuthorityVerdict
): void {
  withdrawHorseQualifiedSelection(witness, snapshot, verdict, 'phase11Authority');
}

function withdrawHorseQualifiedSelection(
  witness: HorseExecutionWitness | undefined,
  snapshot: Pick<LiveHorseDecisionSnapshot, 'player' | 'gameState'>,
  verdict: HorseAuthorityVerdict,
  key: QualifiedAuthorityKey
): void {
  const binding = witness?.[key];
  if (!witness || witness.executionStatus !== 'pending' || !binding) return;
  if (binding.selection !== 'selected') return;
  const reference = { action: binding.reference.action, amount: binding.reference.amount };
  const mutable = witness as {
    -readonly [K in 'selected' | 'expectedExecutionAmount']: HorseExecutionWitness[K];
  };
  mutable.selected = Object.freeze(reference);
  mutable.expectedExecutionAmount = expectedHorseExecutionAmount(snapshot, {
    action: reference.action,
    amount: reference.amount ?? undefined,
  });
  binding.selection = 'withdrawn_before_acceptance';
  binding.verdict = verdict;
}

/** Record the usable verdict observed immediately before acceptance. */
export function recordHorsePhase8Verdict(
  witness: HorseExecutionWitness | undefined,
  verdict: HorseAuthorityVerdict
): void {
  const phase8 = witness?.phase8Authority;
  if (witness?.executionStatus === 'pending' && phase8) phase8.verdict = verdict;
}

/** P10.3: record the usable Phase 10 verdict observed immediately before acceptance. */
export function recordHorsePhase10Verdict(
  witness: HorseExecutionWitness | undefined,
  verdict: HorseAuthorityVerdict
): void {
  const phase10 = witness?.phase10Authority;
  if (witness?.executionStatus === 'pending' && phase10) phase10.verdict = verdict;
}

/** P11.3: record the usable Phase 11 verdict observed immediately before acceptance. */
export function recordHorsePhase11Verdict(
  witness: HorseExecutionWitness | undefined,
  verdict: HorseAuthorityVerdict
): void {
  const phase11 = witness?.phase11Authority;
  if (witness?.executionStatus === 'pending' && phase11) phase11.verdict = verdict;
}

/** The client calls this only after matching the worker FIFO, type and fence.
 * Bind the canonical request already validated by the worker, not a fresh live
 * table snapshot that may have changed while the decision was computing.
 */
export function createHorseExecutionWitness(
  snapshot: LiveHorseDecisionSnapshot,
  decision: HorseDecision,
  result: {
    requestId: number;
    lane: HorseExecutionWitness['identity']['lane'];
    computeMs: number;
    governorScale: number;
  }
): HorseExecutionWitness {
  const expectedAmount = expectedHorseExecutionAmount(snapshot, decision);
  const phase8 = decision.tournamentPostflop;
  const plo4 = decision.plo4Policy;
  const phase10 = plo4 && Object.hasOwn(plo4, 'selection') && plo4.selection ? plo4 : null;
  const omaha = decision.omahaVariantPolicy;
  const phase11 = omaha && Object.hasOwn(omaha, 'selection') && omaha.selection ? omaha : null;
  return {
    version: 'horse-execution-witness-v4',
    handAnchor: anchorHorseDecisionHand(snapshot),
    committedHand: Object.freeze({ status: 'pending' }),
    identity: Object.freeze({
      decisionKey: snapshot.decisionKey,
      requestId: result.requestId,
      generation: snapshot.generation,
      fence: snapshot.fence,
      decisionTimeMs: snapshot.decisionTimeMs,
      lane: result.lane,
      variant: snapshot.gameState.gameVariant || 'nlh',
      gameMode: snapshot.gameState.gameMode ?? null,
      stage: snapshot.gameState.stage,
      heroSeat:
        Number.isInteger(snapshot.player?.seat) && snapshot.player.seat >= 0
          ? snapshot.player.seat
          : null,
      boardCount: snapshot.gameState.boardCount ?? null,
    }),
    selected: Object.freeze({ action: decision.action, amount: decision.amount ?? null }),
    expectedExecutionAmount: expectedAmount,
    policyFallback: decision.policyFallback ?? null,
    phase6Attribution: decision.tournamentPreflopAttribution
      ? copyPhase6Attribution(decision.tournamentPreflopAttribution)
      : null,
    phase7Evidence: decision.tournamentUtility?.evidence
      ? Object.freeze({
          version: 'horse-phase7-accepted-evidence-v1' as const,
          inputSha256: decision.tournamentUtility.evidence.inputSha256,
          evidenceSha256: horseTournamentUtilityEvidenceSha256(decision.tournamentUtility.evidence),
          readFrameSha256: decision.tournamentUtility.readFrameSha256 ?? null,
          selectedAction: decision.tournamentUtility.selectedAction,
          selectedAmount: decision.tournamentUtility.selectedAmount,
        })
      : null,
    phase10Inputs: decision.plo4Policy?.inputs
      ? Object.freeze({
          version: 'horse-phase10-input-binding-v1' as const,
          inputSha256: plo4InputBindingSha256(decision.plo4Policy.inputs),
          readFrameSha256: decision.plo4Policy.readFrameSha256 ?? null,
          rangeStatus: decision.plo4Policy.inputs.range.status,
        })
      : null,
    ...(decision.omahaVariantPolicy && Object.hasOwn(decision.omahaVariantPolicy, 'inputs')
      ? {
          phase11Inputs: decision.omahaVariantPolicy.inputs
            ? Object.freeze({
                version: 'horse-phase11-input-binding-v1' as const,
                variant: decision.omahaVariantPolicy.inputs.variant,
                inputSha256: omahaVariantInputBindingSha256(decision.omahaVariantPolicy.inputs),
                rangeStatus: decision.omahaVariantPolicy.inputs.range.status,
              })
            : null,
        }
      : {}),
    ...(decision.remainingVariantPolicy && Object.hasOwn(decision.remainingVariantPolicy, 'inputs')
      ? {
          phase12Inputs: decision.remainingVariantPolicy.inputs
            ? Object.freeze({
                version: 'horse-phase12-input-binding-v1' as const,
                variant: decision.remainingVariantPolicy.inputs.variant,
                inputSha256: remainingVariantInputBindingSha256(
                  decision.remainingVariantPolicy.inputs
                ),
                rangeStatus: decision.remainingVariantPolicy.inputs.range.status,
              })
            : null,
        }
      : {}),
    policyOwnership: decision.policyOwnership
      ? Object.freeze({ ...decision.policyOwnership })
      : null,
    ...(phase8
      ? {
          phase8Authority: {
            continuationVersion: phase8.version,
            mode: phase8.mode,
            selection: phase8.selection,
            authority: phase8.authority ? Object.freeze({ ...phase8.authority }) : null,
            verdict: null,
            candidate: Object.freeze({
              action: phase8.candidateAction,
              amount: phase8.candidateAmount,
            }),
            reference: Object.freeze({
              action: phase8.baselineAction,
              amount: phase8.baselineAmount,
            }),
          },
        }
      : {}),
    ...(phase10
      ? {
          phase10Authority: {
            continuationVersion: phase10.version,
            mode: phase10.mode === 'candidate' ? ('candidate' as const) : ('shadow' as const),
            selection: phase10.selection!,
            authority: phase10.authority ? Object.freeze({ ...phase10.authority }) : null,
            verdict: null,
            candidate: Object.freeze({
              action: phase10.proposalAction,
              amount: phase10.proposalAmount,
            }),
            reference: Object.freeze({
              action: phase10.baselineAction,
              amount: phase10.baselineAmount,
            }),
          },
        }
      : {}),
    ...(phase11
      ? {
          phase11Authority: {
            continuationVersion: phase11.version,
            mode: phase11.mode === 'candidate' ? ('candidate' as const) : ('shadow' as const),
            selection: phase11.selection!,
            authority: phase11.authority ? Object.freeze({ ...phase11.authority }) : null,
            verdict: null,
            candidate: Object.freeze({
              action: phase11.proposalAction,
              amount: phase11.proposalAmount,
            }),
            reference: Object.freeze({
              action: phase11.baselineAction,
              amount: phase11.baselineAmount,
            }),
          },
        }
      : {}),
    policyGraph: decision.policyGraph
      ? {
          version: decision.policyGraph.version,
          transitions: decision.policyGraph.transitions.map((transition) => ({
            ...transition,
            before: transition.before ? { ...transition.before } : null,
            after: { ...transition.after },
          })),
          finalAction: { ...decision.policyGraph.finalAction },
        }
      : null,
    computeMs: result.computeMs,
    governorScale: result.governorScale,
    executionStatus: 'pending',
    executedAction: null,
    executedAmount: null,
    retirementReason: null,
    acceptedActions: [],
  };
}

function countFinal(witness: HorseExecutionWitness): void {
  noteFire(`phase15_execution_${witness.executionStatus}`);
  noteFire(`phase15_${witness.identity.lane}_execution_${witness.executionStatus}`);
  const callback = finalizers.get(witness);
  finalizers.delete(witness);
  try {
    callback?.(witness);
  } catch {
    noteFire('phase15_journal_capture_unavailable');
  }
}

const finalizers = new WeakMap<HorseExecutionWitness, (witness: HorseExecutionWitness) => void>();
/** Private callback is never serialized with the executor receipt. */
export function onHorseExecutionFinalized(
  witness: HorseExecutionWitness,
  callback: (witness: HorseExecutionWitness) => void
): void {
  if (witness.executionStatus !== 'pending') throw Error('Horse execution already finalized');
  finalizers.set(witness, callback);
}

export function retireHorseExecutionWitness(
  witness: HorseExecutionWitness | undefined,
  reason: HorseExecutionRetirement
): void {
  if (!witness || witness.executionStatus !== 'pending') return;
  witness.executionStatus = 'not_executed';
  witness.retirementReason = reason;
  countFinal(witness);
}

/** Call after the actual executor's intended and check/fold fallback attempts.
 * The controller receipt, not the submitted action or the boolean return,
 * identifies what landed. Keep a missing/conflicting receipt explicitly unknown.
 */
export function settleHorseExecutionWitness(
  witness: HorseExecutionWitness | undefined,
  result: {
    applied: boolean;
    acceptedActions: readonly HorseAcceptedAction[];
  }
): void {
  if (!witness || witness.executionStatus !== 'pending') return;
  witness.acceptedActions = result.acceptedActions.map(({ record, intended }) => ({
    record: {
      seat: record.seat,
      action: record.action,
      amount: record.amount,
      stage: record.stage,
      ...(record.userId !== undefined ? { userId: record.userId } : {}),
      ...(record.timestamp !== undefined ? { timestamp: record.timestamp } : {}),
      ...(record.isFullRaise !== undefined ? { isFullRaise: record.isFullRaise } : {}),
    },
    intended,
  }));
  if (
    result.acceptedActions.length > 1 ||
    (result.applied && result.acceptedActions.length === 0)
  ) {
    witness.executionStatus = 'unverified';
    witness.retirementReason =
      result.acceptedActions.length > 1 ? 'multiple_accepted_actions' : 'accepted_without_record';
    countFinal(witness);
    return;
  }
  const accepted = result.acceptedActions[0];
  if (!accepted) {
    retireHorseExecutionWitness(witness, 'action_rejected');
    return;
  }
  // A controller record proves an action only for the actor and street that
  // produced this decision. Keep conflicting evidence, without crediting it
  // as this Horse's execution or inventing an executed action.
  if (
    witness.identity.heroSeat === null ||
    accepted.record.seat !== witness.identity.heroSeat ||
    accepted.record.stage !== witness.identity.stage
  ) {
    witness.executionStatus = 'unverified';
    witness.retirementReason = 'accepted_context_mismatch';
    countFinal(witness);
    return;
  }
  if (
    accepted.record.action === witness.selected.action &&
    witness.expectedExecutionAmount === null
  ) {
    witness.executionStatus = 'unverified';
    witness.retirementReason = 'accepted_amount_unverifiable';
    countFinal(witness);
    return;
  }
  const matched =
    accepted.record.action === witness.selected.action &&
    accepted.record.amount === witness.expectedExecutionAmount;
  witness.executedAction = accepted.record.action;
  witness.executedAmount = ['fold', 'check'].includes(accepted.record.action)
    ? null
    : accepted.record.amount;
  witness.executionStatus =
    !accepted.intended ||
    witness.identity.lane === 'worker_fallback' ||
    witness.policyFallback === 'brain_exception'
      ? 'fallback'
      : matched
        ? 'intended'
        : 'coerced';
  for (const key of ['phase8Authority', 'phase10Authority', 'phase11Authority'] as const) {
    const binding = witness[key];
    if (
      binding?.selection === 'selected' &&
      binding.verdict === 'usable' &&
      witness.executionStatus === 'intended'
    )
      binding.selection = 'controller_accepted';
  }
  countFinal(witness);
}
