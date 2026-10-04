import { plo4LiveReceiptBindingIsValid } from '../plo4/Plo4LivePolicy.js';
import { omahaVariantReceiptBindingIsValid } from '../omaha/OmahaVariantLivePolicy.js';
import { horsePhase6AttributionIsValid } from '../HorsePhase6Attribution.js';
import { horseTournamentUtilityEvidenceIsValid } from '../HorseTournamentUtilityEvidence.js';
import type { HorseDecision, HorseTournamentUtilityLedger, SeatPlayer } from '../../types.js';
import type { HorseGameStateV2 } from '../HorseLogic.js';
import { MAX_UTILITY_OUTCOMES } from '../HorseTournamentUtility.js';
import { jointStateKey } from '../multiway/JointRangeSampler.js';
import { HORSE_POLICY_ORDER, type HorsePolicyAction } from '../HorsePolicyGraph.js';
import { horsePolicyOwnershipMatches } from '../HorsePolicyRegistry.js';
import type { GovernorSnapshot } from '../EquityLoadGovernor.js';
import { PHASE8_POLICY } from '../HorseTournamentPostflop.js';
import { horseAuthorityReceiptIsWellFormed } from '../HorseQualifiedAuthority.js';
import { PLO4_POLICY_PACK } from '../plo4/Plo4PolicyPack.js';
import { isOmahaPolicyVariant, OMAHA_VARIANT_PACKS } from '../omaha/OmahaVariantPolicyPack.js';

const ACTIONS = ['fold', 'check', 'call', 'bet', 'raise', 'all_in'] as const;
type RecordValue = Record<string, unknown>;
function record(value: unknown): value is RecordValue {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function exact(value: RecordValue, keys: readonly string[]): boolean {
  return (
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.prototype.hasOwnProperty.call(value, key))
  );
}
function nonnegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

export function horseGovernorScaleIsValid(value: unknown): value is number {
  return nonnegative(value) && value > 0 && value <= 1;
}

/** Only finite, complete worker-owned readings may enter readiness or health.
 * A stale but well-formed reading stays explicitly stale; no replacement value
 * is inferred here. The governor itself continues to own load adaptation. */
export function horseGovernorSnapshotIsValid(value: unknown): value is GovernorSnapshot {
  return (
    record(value) &&
    exact(value, [
      'enabled',
      'scale',
      'p50Ms',
      'p99Ms',
      'sampledAt',
      'throttledForS',
      'stale',
      'timerLateMs',
    ]) &&
    typeof value.enabled === 'boolean' &&
    typeof value.stale === 'boolean' &&
    horseGovernorScaleIsValid(value.scale) &&
    ['p50Ms', 'p99Ms', 'sampledAt', 'throttledForS', 'timerLateMs'].every((key) =>
      nonnegative(value[key])
    )
  );
}

export function horseSamplingStateIsValid(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 0xffffffff;
}

export function horseComputeMetadataIsValid(value: {
  computeMs: unknown;
  governorScale: unknown;
}): boolean {
  return nonnegative(value.computeMs) && horseGovernorScaleIsValid(value.governorScale);
}
function action(value: unknown): value is HorsePolicyAction {
  return (
    record(value) &&
    exact(value, ['action', 'amount']) &&
    ACTIONS.includes(value.action as (typeof ACTIONS)[number]) &&
    (value.amount === null || nonnegative(value.amount))
  );
}
function same(a: HorsePolicyAction, b: HorsePolicyAction): boolean {
  return a.action === b.action && a.amount === b.amount;
}

/** Legacy receipts can be read without being promoted to input provenance.
 * New evidence-bearing receipts must be bounded and internally consistent
 * before their immutable copy enters the execution witness. This validates
 * structure and reconciliation; it does not establish response calibration. */
export function horseTournamentUtilityReceiptIsValid(
  value: unknown,
  decision: Pick<HorseDecision, 'action' | 'amount'>
): value is HorseTournamentUtilityLedger {
  if (!record(value)) return false;
  if (value.evidence === undefined) return true;
  const nullableAmount = (n: unknown) => n === null || nonnegative(n);
  const uint = (n: unknown) => nonnegative(n) && Number.isSafeInteger(n);
  const probability = (n: unknown) => nonnegative(n) && n <= 1;
  const finite = (n: unknown) => typeof n === 'number' && Number.isFinite(n);
  const actions = (n: unknown) => ACTIONS.includes(n as (typeof ACTIONS)[number]);
  const ids = (n: unknown): n is string[] =>
    Array.isArray(n) &&
    n.length <= 9 &&
    new Set(n).size === n.length &&
    n.every((id) => typeof id === 'string' && id.length > 0 && id.length <= 256);
  if (
    !exact(value, [
      'schemaVersion',
      'model',
      'outcomeModel',
      'objective',
      'utilityUnit',
      'chipEvUnit',
      'baselineAction',
      'baselineAmount',
      'selectedAction',
      'selectedAmount',
      'executedAction',
      'executedAmount',
      'executionStatus',
      'overrodeBaseline',
      'baselineRetainedForUncertainty',
      'baselineRetainedForContinuation',
      'sidePotCount',
      'playersBehind',
      'coveringPlayers',
      'conditionedOpponentRanges',
      'equitySampleSize',
      'utilityOutcomeSamples',
      'equityStandardError',
      'equityCalibrationError',
      'effectiveOutcomeSamples',
      'fieldPlayersActual',
      'fieldPlayersModeled',
      'fieldReconciliationErrorChips',
      'icmMethod',
      'icmErrorBound',
      'componentReconciliationError',
      'candidates',
      'evidence',
      ...(Object.hasOwn(value, 'readFrameSha256') ? ['readFrameSha256'] : []),
    ]) ||
    value.schemaVersion !== 1 ||
    !['horse-tournament-utility-phase7-round1', 'horse-tournament-utility-phase8-round1'].includes(
      value.model as string
    ) ||
    value.outcomeModel !==
      (value.model === 'horse-tournament-utility-phase7-round1'
        ? 'conditioned_showdown_samples'
        : 'conditioned_public_street_continuation') ||
    ![
      'mtt_payout',
      'satellite_seat_equity',
      'pko',
      'mystery_bounty',
      'sng',
      'spin_chip_ev',
      'spin_payout',
    ].includes(value.objective as string) ||
    value.utilityUnit !== 'total_funded_pool_pct' ||
    value.chipEvUnit !== 'tournament_chips' ||
    !actions(value.baselineAction) ||
    !nullableAmount(value.baselineAmount) ||
    value.selectedAction !== decision.action ||
    value.selectedAmount !== (decision.amount ?? null) ||
    !actions(value.selectedAction) ||
    !nullableAmount(value.selectedAmount) ||
    (value.executedAction !== null && !actions(value.executedAction)) ||
    !nullableAmount(value.executedAmount) ||
    !['pending', 'intended', 'coerced', 'fallback', 'not_executed'].includes(
      value.executionStatus as string
    ) ||
    ![
      'overrodeBaseline',
      'baselineRetainedForUncertainty',
      'baselineRetainedForContinuation',
    ].every((key) => typeof value[key] === 'boolean') ||
    !ids(value.playersBehind) ||
    !ids(value.coveringPlayers) ||
    ![
      'sidePotCount',
      'conditionedOpponentRanges',
      'equitySampleSize',
      'utilityOutcomeSamples',
      'fieldPlayersActual',
      'fieldPlayersModeled',
    ].every((key) => uint(value[key])) ||
    ![
      'equityStandardError',
      'equityCalibrationError',
      'effectiveOutcomeSamples',
      'fieldReconciliationErrorChips',
      'icmErrorBound',
      'componentReconciliationError',
    ].every((key) => nonnegative(value[key])) ||
    !['exact_mh', 'plackett_luce_mc'].includes(value.icmMethod as string) ||
    !horseTournamentUtilityEvidenceIsValid(value.evidence) ||
    (Object.hasOwn(value, 'readFrameSha256') &&
      value.readFrameSha256 !== null &&
      (typeof value.readFrameSha256 !== 'string' ||
        !/^[a-f0-9]{64}$/.test(value.readFrameSha256))) ||
    !Array.isArray(value.candidates) ||
    value.candidates.length < 1 ||
    value.candidates.length > 16
  )
    return false;
  const opponentIds = new Set(value.evidence.opponents.map((row) => row.userId));
  if (
    (value.evidence.sampler !== undefined &&
      (value.evidence.sampler.completedSamples !== value.utilityOutcomeSamples ||
        value.evidence.sampler.completedSamples !== value.equitySampleSize)) ||
    (value.conditionedOpponentRanges as number) !==
      value.evidence.opponents.filter((row) => row.range !== null).length ||
    (value.playersBehind as string[]).some((id) => !opponentIds.has(id)) ||
    (value.coveringPlayers as string[]).some((id) => !opponentIds.has(id)) ||
    (value.playersBehind as string[]).length !==
      value.evidence.opponents.filter((row) => row.actsAfterHero).length ||
    value.evidence.opponents.some(
      (row) => row.actsAfterHero && !(value.playersBehind as string[]).includes(row.userId)
    ) ||
    value.fieldPlayersActual !== value.fieldPlayersModeled ||
    (value.fieldPlayersActual as number) < 2 ||
    (value.utilityOutcomeSamples as number) < 1 ||
    (value.utilityOutcomeSamples as number) > MAX_UTILITY_OUTCOMES ||
    (value.effectiveOutcomeSamples as number) > (value.utilityOutcomeSamples as number) + 1e-9 ||
    (value.sidePotCount as number) > 10 ||
    (value.componentReconciliationError as number) > 0.005 ||
    ((value.executionStatus === 'pending' || value.executionStatus === 'not_executed') &&
      (value.executedAction !== null || value.executedAmount !== null)) ||
    (value.executionStatus === 'intended' &&
      (value.executedAction !== value.selectedAction ||
        value.executedAmount !== value.selectedAmount))
  )
    return false;
  const candidateIds = new Set<string>();
  let matchingSelected = 0;
  for (const candidate of value.candidates) {
    if (
      !record(candidate) ||
      !exact(candidate, [
        'id',
        'action',
        'amount',
        'investment',
        'chipEv',
        'payoutEv',
        'bountyEv',
        'optionEv',
        'combinedUtility',
        'utilityStandardError',
        'utilityConfidenceHalfWidth',
        'winProbability',
        'allFoldProbability',
        'bustProbability',
        'bountyWinProbability',
        'outcomeCount',
        'resultingStackVectors',
        'terminalForHero',
        'sidePotCount',
        'stackConservationError',
        ...(Object.hasOwn(candidate, 'continuation') ? ['continuation'] : []),
      ]) ||
      typeof candidate.id !== 'string' ||
      candidate.id.length < 1 ||
      candidate.id.length > 64 ||
      candidateIds.has(candidate.id) ||
      !actions(candidate.action) ||
      !nullableAmount(candidate.amount) ||
      (['bet', 'raise'].includes(candidate.action as string)
        ? !nonnegative(candidate.amount)
        : candidate.amount !== null) ||
      ![
        'investment',
        'payoutEv',
        'utilityStandardError',
        'utilityConfidenceHalfWidth',
        'stackConservationError',
      ].every((key) => nonnegative(candidate[key])) ||
      !['chipEv', 'bountyEv', 'optionEv', 'combinedUtility'].every((key) =>
        finite(candidate[key])
      ) ||
      !['winProbability', 'allFoldProbability', 'bustProbability', 'bountyWinProbability'].every(
        (key) => probability(candidate[key])
      ) ||
      !['outcomeCount', 'resultingStackVectors', 'sidePotCount'].every((key) =>
        uint(candidate[key])
      ) ||
      typeof candidate.terminalForHero !== 'boolean' ||
      candidate.outcomeCount !== value.utilityOutcomeSamples ||
      (candidate.resultingStackVectors as number) > (candidate.outcomeCount as number) ||
      (candidate.sidePotCount as number) > (value.sidePotCount as number) ||
      (candidate.stackConservationError as number) > 0.005 ||
      Math.abs(
        (candidate.combinedUtility as number) -
          ((candidate.payoutEv as number) +
            (candidate.bountyEv as number) +
            (candidate.optionEv as number))
      ) > 1e-7
    )
      return false;
    candidateIds.add(candidate.id);
    const selectedAmount = candidate.action === 'call' ? candidate.investment : candidate.amount;
    if (candidate.action === decision.action && selectedAmount === (decision.amount ?? null))
      matchingSelected++;
    if (candidate.continuation !== undefined) {
      const c = candidate.continuation;
      if (
        !record(c) ||
        !exact(c, [
          'shortStackCollisionProbability',
          'expectedRetainedStackBb',
          'expectedCoveredStacks',
          'noFullBlindRaiseProbability',
          ...['futureHands', 'futureForcedPaid', 'futureLevelUtilityEnvelope'].filter((key) =>
            Object.hasOwn(c, key)
          ),
        ]) ||
        !probability(c.shortStackCollisionProbability) ||
        !probability(c.noFullBlindRaiseProbability) ||
        !nonnegative(c.expectedRetainedStackBb) ||
        !nonnegative(c.expectedCoveredStacks) ||
        ['futureHands', 'futureForcedPaid', 'futureLevelUtilityEnvelope'].some(
          (key) => Object.hasOwn(c, key) && !nonnegative(c[key])
        )
      )
        return false;
    }
  }
  return matchingSelected === 1;
}

export type HorsePhase7EvidenceMismatch =
  | 'phase7_foreign_opponent'
  | 'phase7_marginal_multi_board'
  | 'phase7_sampler_single_board'
  | 'phase7_sampler_board_count'
  | 'phase7_sampler_state';

/** Request binding for an evidence-bearing Phase 7 receipt. The structural
 * validator above cannot see the request, so a well-formed sampler for another
 * state or board layout, or a multi-board receipt with no physical joint
 * acquisition (marginal draws), was admissible. Recompute each binding from the
 * request the worker actually received and return the first named mismatch.
 * Legacy receipts without evidence keep no new authority and are not refused. */
export function horsePhase7EvidenceMismatch(
  decision: Pick<HorseDecision, 'tournamentUtility'>,
  request: { player: SeatPlayer; gameState: HorseGameStateV2 }
): HorsePhase7EvidenceMismatch | null {
  const evidence = decision.tournamentUtility?.evidence;
  if (!evidence) return null;
  const state = request.gameState;
  const hero = request.player;
  const opponents = new Set(
    (Array.isArray(state?.players) ? state.players : [])
      .filter((player) => player.user_id !== hero?.user_id)
      .map((player) => player.user_id)
  );
  if (evidence.opponents.some((row) => !opponents.has(row.userId)))
    return 'phase7_foreign_opponent';
  // Same multi-board test as the ordinary Phase 7 caller in HorseLogic.
  const boardCount = state.boardCount ?? 1;
  const multiBoard =
    (state.communityCards2?.length ?? 0) > 0 ||
    (state.communityCards3?.length ?? 0) > 0 ||
    boardCount > 1;
  const sampler = evidence.sampler;
  if (!sampler) return multiBoard ? 'phase7_marginal_multi_board' : null;
  if (!multiBoard) return 'phase7_sampler_single_board';
  if (sampler.boardCount !== boardCount) return 'phase7_sampler_board_count';
  try {
    if (sampler.stateKey !== jointStateKey(hero, state)) return 'phase7_sampler_state';
  } catch {
    return 'phase7_sampler_state';
  }
  return null;
}

/** Bounded structured-clone validation before witness construction. A graph
 * may be absent on legacy or caught-failure decisions; absence is not proof
 * of graph execution. A supplied graph must be complete, continuous and
 * action-only, and its final action must match the returned decision. */
/**
 * The Phase 8 receipt as the worker returns it. A changed action is legitimate
 * only as an authority-backed selection: candidate mode, a usable worker
 * authority receipt for the running continuation, and the final action equal
 * to the ledger's candidate. Acceptance-time fields stay unset in the worker.
 */
export function horsePhase8LedgerIsValid(value: unknown, decision: RecordValue): boolean {
  if (value === undefined) return true;
  if (!record(value)) return false;
  const wager = (action: unknown) => action === 'bet' || action === 'raise';
  const authority = value.authority;
  const authorityState = record(authority) ? authority.state : undefined;
  const authorityVersion = record(authority) ? authority.continuationVersion : undefined;
  if (
    value.version !== PHASE8_POLICY.version ||
    !['shadow', 'candidate'].includes(value.mode as string) ||
    typeof value.applied !== 'boolean' ||
    typeof value.changed !== 'boolean' ||
    !['none', 'shadow_change', 'selected'].includes(value.selection as string) ||
    value.authorityVerdict !== null ||
    (authority !== null && !horseAuthorityReceiptIsWellFormed(authority)) ||
    (authority !== null && authorityVersion !== PHASE8_POLICY.version)
  )
    return false;
  if (value.mode === 'candidate' && authorityState !== 'usable') return false;
  if (!value.applied) return value.selection !== 'selected';
  return (
    value.mode === 'candidate' &&
    value.changed === true &&
    value.selection === 'selected' &&
    decision.action === value.candidateAction &&
    (!wager(decision.action) || (decision.amount ?? null) === value.candidateAmount)
  );
}

/**
 * P10.3: the PLO4 receipt's selection as the worker returns it. A changed
 * action is legitimate only as an authority-backed cash selection: candidate
 * mode, a usable worker Phase 10 authority receipt for the running pack
 * version, cash utility ownership (never a tournament objective decision) and
 * the final action equal to the proposal. Acceptance-time fields stay unset.
 * A receipt retained before P10.3 carries no selection and claims no
 * authority, so it may not carry an applied candidate either.
 */
export function horsePhase10SelectionIsValid(value: unknown, decision: RecordValue): boolean {
  if (value === undefined) return true;
  if (!record(value)) return false;
  const wager = (action: unknown) => action === 'bet' || action === 'raise';
  if (!Object.hasOwn(value, 'selection'))
    return (
      value.applied !== true &&
      !Object.hasOwn(value, 'authority') &&
      !Object.hasOwn(value, 'authorityVerdict')
    );
  const authority = value.authority;
  if (
    !['none', 'shadow_change', 'selected'].includes(value.selection as string) ||
    typeof value.applied !== 'boolean' ||
    typeof value.changed !== 'boolean' ||
    !['shadow', 'candidate'].includes(value.mode as string) ||
    (value.authorityVerdict !== undefined && value.authorityVerdict !== null) ||
    (value.selectionRefusal !== undefined &&
      value.selectionRefusal !== null &&
      value.selectionRefusal !== 'illegal_candidate') ||
    (authority !== undefined &&
      authority !== null &&
      (!horseAuthorityReceiptIsWellFormed(authority) ||
        authority.continuationVersion !== PLO4_POLICY_PACK.version))
  )
    return false;
  if (value.mode === 'candidate' && (!record(authority) || authority.state !== 'usable'))
    return false;
  if (!value.applied) return value.selection !== 'selected';
  return (
    value.mode === 'candidate' &&
    value.changed === true &&
    value.selection === 'selected' &&
    value.utilityOwner === 'cash' &&
    decision.action === value.proposalAction &&
    decision.action === value.finalAction &&
    (!wager(decision.action) ||
      ((decision.amount ?? null) === value.proposalAmount &&
        (decision.amount ?? null) === value.finalAmount))
  );
}

/**
 * P11.3: a PLO5/PLO6/PLO8 receipt's selection as the worker returns it, by
 * the P10.3 law. A changed action is legitimate only as an authority-backed
 * cash selection: candidate mode, a usable worker authority receipt for the
 * running version of the receipt's own pack (a PLO5 authority never backs a
 * PLO6 receipt), cash utility ownership (never a tournament objective
 * decision) and the final action equal to the proposal. Acceptance-time fields
 * stay unset. A receipt retained before P11.3 carries no selection and claims
 * no authority, so it may not carry an applied candidate either.
 */
export function horsePhase11SelectionIsValid(value: unknown, decision: RecordValue): boolean {
  if (value === undefined) return true;
  if (!record(value)) return false;
  const wager = (action: unknown) => action === 'bet' || action === 'raise';
  if (!Object.hasOwn(value, 'selection'))
    return (
      value.applied !== true &&
      !Object.hasOwn(value, 'authority') &&
      !Object.hasOwn(value, 'authorityVerdict') &&
      !Object.hasOwn(value, 'selectionRefusal')
    );
  const packVersion = isOmahaPolicyVariant(value.variant)
    ? OMAHA_VARIANT_PACKS[value.variant].version
    : null;
  const authority = value.authority;
  if (
    packVersion === null ||
    value.version !== packVersion ||
    !['none', 'shadow_change', 'selected'].includes(value.selection as string) ||
    typeof value.applied !== 'boolean' ||
    typeof value.changed !== 'boolean' ||
    !['shadow', 'candidate'].includes(value.mode as string) ||
    (value.authorityVerdict !== undefined && value.authorityVerdict !== null) ||
    (value.selectionRefusal !== undefined &&
      value.selectionRefusal !== null &&
      value.selectionRefusal !== 'illegal_candidate') ||
    (authority !== undefined &&
      authority !== null &&
      (!horseAuthorityReceiptIsWellFormed(authority) ||
        authority.continuationVersion !== packVersion))
  )
    return false;
  if (value.mode === 'candidate' && (!record(authority) || authority.state !== 'usable'))
    return false;
  if (!value.applied) return value.selection !== 'selected';
  return (
    value.mode === 'candidate' &&
    value.changed === true &&
    value.selection === 'selected' &&
    value.utilityOwner === 'cash' &&
    decision.action === value.proposalAction &&
    decision.action === value.finalAction &&
    (!wager(decision.action) ||
      ((decision.amount ?? null) === value.proposalAmount &&
        (decision.amount ?? null) === value.finalAmount))
  );
}

/** Phase 7 owns the action Phase 8 received; an applied candidate replaces it. */
function phase7Selection(value: RecordValue): Pick<HorseDecision, 'action' | 'amount'> {
  const phase8 = value.tournamentPostflop;
  if (record(phase8) && phase8.applied === true)
    return {
      action: phase8.baselineAction as HorseDecision['action'],
      amount: (phase8.baselineAmount as number | null) ?? undefined,
    };
  return value as unknown as Pick<HorseDecision, 'action' | 'amount'>;
}

export function horseDecisionReceiptIsValid(
  value: unknown,
  expectedVariant?: string
): value is HorseDecision {
  if (
    !record(value) ||
    !ACTIONS.includes(value.action as (typeof ACTIONS)[number]) ||
    !nonnegative(value.thinkTime) ||
    (value.amount !== undefined && !nonnegative(value.amount)) ||
    (value.policyFallback !== undefined && value.policyFallback !== 'brain_exception')
  )
    return false;
  if (
    value.policyFallback === 'brain_exception' &&
    (!['check', 'fold'].includes(value.action as string) ||
      value.amount !== undefined ||
      value.policyGraph !== undefined ||
      value.policyOwnership !== undefined ||
      value.tournamentPreflopAttribution !== undefined ||
      value.tournamentUtility !== undefined)
  )
    return false;
  if (
    value.tournamentUtility !== undefined &&
    !horseTournamentUtilityReceiptIsValid(value.tournamentUtility, phase7Selection(value))
  )
    return false;
  if (!horsePhase8LedgerIsValid(value.tournamentPostflop, value)) return false;
  if (value.plo4Policy !== undefined && !plo4LiveReceiptBindingIsValid(value.plo4Policy))
    return false;
  if (!horsePhase10SelectionIsValid(value.plo4Policy, value)) return false;
  // P11.1: a Phase 11 receipt's input binding is shape-checked at the boundary.
  if (
    value.omahaVariantPolicy !== undefined &&
    !omahaVariantReceiptBindingIsValid(value.omahaVariantPolicy)
  )
    return false;
  if (!horsePhase11SelectionIsValid(value.omahaVariantPolicy, value)) return false;
  if (
    value.tournamentPreflopAttribution !== undefined &&
    !horsePhase6AttributionIsValid(value.tournamentPreflopAttribution)
  )
    return false;
  if (!horsePolicyOwnershipMatches(value as unknown as HorseDecision)) return false;
  if (
    value.policyOwnership !== undefined &&
    expectedVariant !== undefined &&
    (value.policyOwnership as HorseDecision['policyOwnership'])?.variant !== expectedVariant
  )
    return false;
  if (value.policyGraph === undefined) return true;
  const graph = value.policyGraph;
  if (
    !record(graph) ||
    !exact(graph, ['version', 'transitions', 'finalAction']) ||
    graph.version !== 'horse-policy-order-v1' ||
    !Array.isArray(graph.transitions) ||
    graph.transitions.length !== HORSE_POLICY_ORDER.length ||
    !action(graph.finalAction)
  )
    return false;
  let previous: HorsePolicyAction | null = null;
  for (let i = 0; i < HORSE_POLICY_ORDER.length; i++) {
    const transition = graph.transitions[i];
    if (
      !record(transition) ||
      !exact(transition, ['node', 'before', 'after', 'changed', 'elapsedMs']) ||
      transition.node !== HORSE_POLICY_ORDER[i] ||
      !action(transition.after) ||
      !nonnegative(transition.elapsedMs)
    )
      return false;
    if (
      previous === null
        ? transition.before !== null
        : !action(transition.before) || !same(previous, transition.before)
    )
      return false;
    const changed = previous !== null && !same(previous, transition.after);
    if (transition.changed !== changed || (transition.node === 'timing' && changed)) return false;
    previous = transition.after;
  }
  return (
    previous !== null &&
    same(previous, graph.finalAction) &&
    same(graph.finalAction, {
      action: value.action as HorseDecision['action'],
      amount: (value.amount as number | undefined) ?? null,
    })
  );
}
