import type { HorseDecision, SeatPlayer, HorseTournamentUtilityLedger } from '../../types.js';
import type { HorseGameStateV2 } from '../HorseLogic.js';
import { horseVariantRulesFor } from '../VariantRules.js';
import type { JointRangeSamples } from './JointRangeSampler.js';
import {
  acquireJointSamples,
  jointSampleAcquisitionMatches,
  JOINT_LIVE_DOMAIN,
  type JointSampleAcquisition,
} from './JointSampleAcquisition.js';
import {
  evaluateJointActions,
  jointPlayersBehind,
  JOINT_ACTION_PACK,
  type JointActionCandidate,
} from './JointActionModel.js';
import { prepareJointPots, jointPotDistribution } from './JointPotDistribution.js';
import { JOINT_RANGE_PACK } from './JointRangeSampler.js';
import { validateDealtSeatCensus } from './DealtSeatCensus.js';
import { jointStreetOrder } from './JointResponseOrder.js';
import {
  buildJointInputBinding,
  jointInputBindingIsValid,
  type JointInputBinding,
} from './JointInputBinding.js';

export { JOINT_LIVE_DOMAIN } from './JointSampleAcquisition.js';
export {
  jointInputBindingIsValid,
  jointInputBindingSha256,
  type JointInputBinding,
  type JointRangeStatus,
} from './JointInputBinding.js';
export type JointPolicyMode = 'off' | 'shadow' | 'candidate';
export type JointResponseModelName = 'one_response_then_showdown' | 'bounded_raise_tree';
export type JointResponseLimits = {
  raiseStreets: string[];
  raisesPerTree: number;
  maxRaiseBranchOpponents: number;
  maxTerminalBranchesPerCandidate: number;
  riverRounds: number;
};
export interface JointResponseTreeSummary {
  terminalBranches: number;
  raiseBranches: number;
  raiseProbability: number;
  heroCallsRaiseProbability: number;
  heroFoldsToRaiseProbability: number;
  raiseLimitedResponders: number;
  riverRoundProbability: number | null;
  riverBetProbability: number | null;
}
/** P13.1: a plain copy of the response pack's declared work limits. */
export function jointResponseLimits(): JointResponseLimits {
  const l = JOINT_ACTION_PACK.limits;
  return {
    raiseStreets: [...l.raiseStreets],
    raisesPerTree: l.raisesPerTree,
    maxRaiseBranchOpponents: l.maxRaiseBranchOpponents,
    maxTerminalBranchesPerCandidate: l.maxTerminalBranchesPerCandidate,
    riverRounds: l.riverRounds,
  };
}
/** P13.1: why an applied Phase 13 candidate was not allowed to act. */
export type JointSelectionRefusal = 'illegal_candidate' | 'earlier_phase_applied';
type ActionModel = NonNullable<ReturnType<typeof evaluateJointActions>>;
export interface JointPolicyReceipt {
  version: string;
  variant: string;
  stateKey: string | null;
  mode: JointPolicyMode;
  eligible: boolean;
  fired: boolean;
  changed: boolean;
  applied: boolean;
  reason: string;
  street: string;
  boardCount: number;
  dealtPlayers: number;
  liveOpponents: number;
  confidence: 'explicit_joint_heuristic' | 'unavailable';
  baselineAction: HorseDecision['action'];
  baselineAmount: number | null;
  proposalAction: HorseDecision['action'];
  proposalAmount: number | null;
  finalAction: HorseDecision['action'];
  finalAmount: number | null;
  ranges: JointRangeSamples['ranges'];
  actionModel: ActionModel | null;
  callDistribution: ReturnType<typeof jointPotDistribution> | null;
  requestedSamples: number;
  completedSamples: number;
  sampleBudgetExhausted: boolean;
  utilityOwner: 'cash' | 'phase7_pending' | 'phase7_evaluated' | 'phase7_unavailable';
  utilityUnavailableReason?: string;
  shadowUtility?: HorseTournamentUtilityLedger;
  utilityLatencyMs?: number;
  latencyMs: number;
  executionStatus: 'pending' | 'intended' | 'coerced' | 'fallback' | 'not_executed';
  executedAction: HorseDecision['action'] | null;
  executedAmount: number | null;
  /** P13.1: the range and response packs the proposal ran. Absent on
   * retained receipts. */
  rangePackVersion?: string;
  actionPackVersion?: string;
  /** P13.1: seat draws the sampler accepted through its uniform escape. */
  uniformEscapes?: number;
  /** P13.1 over P13-A: the response identity and model that priced the
   * candidates (null when no model ran), the response pack's declared work
   * limits, and the top-ranked candidate's response-tree summary (null for
   * the one-response model). Absent on retained receipts. */
  responseVersion?: string | null;
  responseModel?: JointResponseModelName | null;
  responseLimits?: JointResponseLimits;
  responseTree?: JointResponseTreeSummary | null;
  /** P13.1: frozen inputs of an eligible proposal; null when it was refused.
   * Absent on retained receipts. */
  inputs?: JointInputBinding | null;
  /** P13.1: set when an applied candidate was refused before it could act
   * (the Phase 10/11/12 `illegal_candidate` law, and a candidate on top of an
   * applied earlier-phase candidate). Absent on retained receipts. */
  selectionRefusal?: JointSelectionRefusal | null;
}
const same = (a: HorseDecision, b: HorseDecision) =>
  a.action === b.action && (!['bet', 'raise'].includes(a.action) || a.amount === b.amount);
const SELECTION_REFUSALS: readonly JointSelectionRefusal[] = [
  'illegal_candidate',
  'earlier_phase_applied',
];

/**
 * P13.1 LEGAL FORM: the candidates in exactly the form the owner's legalizer
 * executes, before any is priced. Each built candidate is passed through
 * `legalForm` (HorseLogic.legalize) and rebuilt from the legal decision: a
 * cent wager becomes the whole-chip wager, a near-stack wager or a covering
 * call becomes the all-in the menu accepts. Candidates that legalize to the
 * same action and amount collapse to one, so no action is priced twice. The
 * map returns each candidate's exact legal decision, which is what the
 * receipt records and what the node may apply.
 */
export function jointLegalCandidates(
  candidates: JointActionCandidate[],
  hero: SeatPlayer,
  s: HorseGameStateV2,
  legalForm: (d: HorseDecision) => HorseDecision
): { candidates: JointActionCandidate[]; legal: Map<string, HorseDecision> } {
  const toCall = Math.min(hero.stack, Math.max(0, s.currentBet - hero.bet));
  const out: JointActionCandidate[] = [];
  const legal = new Map<string, HorseDecision>();
  for (const c of candidates) {
    const d = legalForm({
      action: c.action,
      ...(c.amount !== null ? { amount: c.amount } : {}),
      thinkTime: 0,
    });
    let next: JointActionCandidate;
    if (d.action === 'fold')
      next = { id: 'fold', kind: 'fold', action: 'fold', amount: null, investment: 0 };
    else if (d.action === 'check')
      next = { id: 'check', kind: 'check', action: 'check', amount: null, investment: 0 };
    else if (d.action === 'call')
      next = {
        id: 'call',
        kind: 'call',
        action: 'call',
        amount: null,
        investment: Math.min(hero.stack, d.amount ?? toCall),
      };
    else if (d.action === 'all_in')
      next =
        hero.stack <= toCall + 1e-9
          ? {
              id: 'call:all-in',
              kind: 'call',
              action: 'all_in',
              amount: null,
              investment: hero.stack,
            }
          : { id: 'jam', kind: 'jam', action: 'all_in', amount: null, investment: hero.stack };
    else if ((d.action === 'bet' || d.action === 'raise') && Number.isFinite(d.amount))
      next = {
        id: `${d.action}:${d.amount}`,
        kind: d.action,
        action: d.action,
        amount: d.amount!,
        investment: Math.max(0, Math.min(hero.stack, d.amount! - hero.bet)),
      };
    else continue;
    if (legal.has(next.id)) continue;
    legal.set(next.id, {
      action: d.action,
      ...(d.amount !== undefined ? { amount: d.amount } : {}),
      thinkTime: 0,
    });
    out.push(next);
  }
  return { candidates: out, legal };
}

/** Complete bounded proposal wrapper. Candidate mode is for offline control;
 * the worker must reject live candidate/evidence-clock options. This function
 * returns an internal joint sample bridge separately from the serializable
 * receipt so the existing Phase7 owner can price tournament outcomes. */
export function evaluateJointLivePolicy(
  hero: SeatPlayer,
  s: HorseGameStateV2,
  baseline: HorseDecision,
  mode: JointPolicyMode = 'shadow',
  now = () => performance.now(),
  acquisition?: JointSampleAcquisition,
  /** P13.1: the owner's legalizer. Every candidate is priced, ranked and
   * recorded in this exact form. Offline callers without one keep the
   * settlement-unit sizing and record `legalForm: not_supplied`. */
  legalForm?: (d: HorseDecision) => HorseDecision
) {
  const start = now();
  // Reuse excludes unrelated Phase 7 wall time, but not the sampling work this
  // policy would otherwise perform. Fresh acquisitions are already timed by
  // this wrapper and must not be charged twice.
  let reusedSamplingMs = 0;
  const elapsed = () => Math.max(0, now() - start) + reusedSamplingMs;
  let proposal = baseline;
  let jointEvidence: JointRangeSamples | null = null;
  const receipt: JointPolicyReceipt = {
    version: JOINT_LIVE_DOMAIN.version,
    variant: s.gameVariant,
    stateKey: null,
    mode,
    eligible: false,
    fired: false,
    changed: false,
    applied: false,
    reason: 'off',
    street: s.stage,
    boardCount: s.boardCount ?? 1,
    dealtPlayers: 0,
    liveOpponents: 0,
    confidence: 'unavailable',
    baselineAction: baseline.action,
    baselineAmount: baseline.amount ?? null,
    proposalAction: baseline.action,
    proposalAmount: baseline.amount ?? null,
    finalAction: baseline.action,
    finalAmount: baseline.amount ?? null,
    ranges: [],
    actionModel: null,
    callDistribution: null,
    requestedSamples: 0,
    completedSamples: 0,
    sampleBudgetExhausted: false,
    utilityOwner: s.gameMode === 'tournament' ? 'phase7_pending' : 'cash',
    latencyMs: 0,
    executionStatus: 'pending',
    executedAction: null,
    executedAmount: null,
    rangePackVersion: JOINT_RANGE_PACK.version,
    actionPackVersion: JOINT_ACTION_PACK.version,
    uniformEscapes: 0,
    responseVersion: null,
    responseModel: null,
    responseLimits: jointResponseLimits(),
    responseTree: null,
    inputs: null,
    selectionRefusal: null,
  };
  /** Assembled only once the acquisition's canonical checks have passed. */
  let bind: (() => JointInputBinding) | null = null;
  const finish = (reason: string) => {
    // Bound inside the timed region: recording the inputs is policy work.
    if (bind) receipt.inputs = bind();
    receipt.latencyMs = elapsed();
    if (receipt.latencyMs > JOINT_LIVE_DOMAIN.liveBudgetMs) {
      reason = 'work_budget';
      receipt.fired = false;
      proposal = baseline;
    }
    if (!receipt.fired) proposal = baseline;
    if (receipt.fired && baseline.action === 'fold' && baseline.continuationGuard) {
      proposal = baseline;
      reason = 'protected_' + baseline.continuationGuard;
    }
    if (!s.legalActions?.includes(proposal.action)) {
      reason = 'proposal_outside_legal_menu';
      receipt.fired = false;
      proposal = baseline;
    }
    receipt.reason = reason;
    receipt.proposalAction = proposal.action;
    receipt.proposalAmount = proposal.amount ?? null;
    receipt.changed = !same(proposal, baseline);
    const decision = mode === 'candidate' && receipt.fired ? proposal : baseline;
    receipt.applied = !same(decision, baseline);
    return { decision, proposal, receipt, jointEvidence };
  };
  if (mode === 'off') return finish('off');
  if (!['shadow', 'candidate'].includes(mode)) return finish('invalid_mode');
  if (!s.legalActions?.includes(baseline.action)) return finish('canonical_state_unavailable');
  if (acquisition !== undefined) {
    if (!jointSampleAcquisitionMatches(hero, s, acquisition))
      return finish('joint_acquisition_state_mismatch');
    reusedSamplingMs = acquisition.samplingMs;
  }
  const acquired = acquisition ?? acquireJointSamples(hero, s, { now });
  receipt.dealtPlayers = acquired.dealtPlayers;
  receipt.liveOpponents = acquired.liveOpponents;
  receipt.eligible = acquired.eligible;
  receipt.requestedSamples = acquired.requestedSamples;
  jointEvidence = acquired.evidence;
  if (jointEvidence) {
    receipt.stateKey = jointEvidence.stateKey;
    receipt.ranges = jointEvidence.ranges;
    receipt.completedSamples = jointEvidence.samples.length;
    receipt.sampleBudgetExhausted = jointEvidence.sampleBudgetExhausted;
    receipt.uniformEscapes = jointEvidence.uniformEscapes;
  }
  if (acquired.eligible) {
    // P13.1: the controller's own action order, from the posted blinds. A
    // state whose order cannot be read is not an eligible proposal.
    let order: number[], behind: string[], dealt: number[];
    try {
      dealt = validateDealtSeatCensus(s.players, hero.seat, s.dealtSeatIds);
      order = jointStreetOrder(s, dealt);
      behind = jointPlayersBehind(hero, s);
    } catch (error) {
      receipt.eligible = false;
      return finish(
        error instanceof Error && error.message.startsWith('joint_')
          ? error.message
          : 'joint_positions_unavailable'
      );
    }
    const evidence = acquired.evidence;
    const consumed = acquired.status === 'acquired';
    const reused = acquisition !== undefined;
    bind = () =>
      buildJointInputBinding({
        hero,
        state: s,
        dealtSeats: dealt,
        actionOrder: order,
        playersBehind: behind,
        evidence,
        requestedSamples: acquired.requestedSamples,
        consumed,
        reused,
        legalFormSupplied: legalForm !== undefined,
      });
  }
  if (acquired.status !== 'acquired') return finish(acquired.reason);
  jointEvidence = acquired.evidence;
  const unit = s.chipUnit!;
  try {
    const call = Math.min(hero.stack, Math.max(0, s.currentBet - hero.bet));
    const called = s.players.map((p) =>
      p.user_id === hero.user_id
        ? { ...p, stack: p.stack - call, bet: p.bet + call, totalInvested: p.totalInvested + call }
        : p
    );
    receipt.callDistribution = jointPotDistribution({
      prepared: prepareJointPots(called, unit),
      heroId: hero.user_id,
      opponentIds: jointEvidence.opponentIds,
      samples: jointEvidence.samples,
      splitLow: horseVariantRulesFor(s.gameVariant).splitLow8OrBetter,
      dealerSeat: s.dealerSeat!,
    });
    let legalOf: Map<string, HorseDecision> | null = null;
    receipt.actionModel = evaluateJointActions(
      hero,
      s,
      baseline,
      jointEvidence,
      () => elapsed() < JOINT_LIVE_DOMAIN.liveBudgetMs,
      {
        candidateForm: legalForm
          ? (built) => {
              const legal = jointLegalCandidates(built, hero, s, legalForm);
              legalOf = legal.legal;
              return legal.candidates;
            }
          : undefined,
      }
    );
    if (!receipt.actionModel) return finish('work_budget');
    const ranked = receipt.actionModel.candidates
      .slice()
      .sort(
        (a, b) =>
          b.expectedNetChips -
            0.5 * b.standardError -
            (a.expectedNetChips - 0.5 * a.standardError) || a.investment - b.investment
      );
    const selected = ranked[0];
    receipt.responseVersion = receipt.actionModel.version;
    receipt.responseModel = receipt.actionModel.responseModel;
    const tree = selected.responseTree;
    receipt.responseTree = tree
      ? {
          terminalBranches: tree.terminalBranches,
          raiseBranches: tree.raiseBranches,
          raiseProbability: tree.raiseProbability,
          heroCallsRaiseProbability: tree.heroCallsRaiseProbability,
          heroFoldsToRaiseProbability: tree.heroFoldsToRaiseProbability,
          raiseLimitedResponders: tree.raiseLimitedResponders,
          riverRoundProbability: tree.riverRoundProbability,
          riverBetProbability: tree.riverBetProbability,
        }
      : null;
    // With the legalizer, the proposal is the exact legal decision that was
    // priced (a call carries its exact amount); otherwise the raw candidate.
    const exact = (legalOf as Map<string, HorseDecision> | null)?.get(selected.id);
    proposal = exact
      ? { ...baseline, action: exact.action, amount: exact.amount }
      : { ...baseline, action: selected.action, amount: selected.amount ?? undefined };
    receipt.confidence = 'explicit_joint_heuristic';
    receipt.fired = true;
    return finish(
      s.gameMode === 'tournament' ? 'joint_candidate_for_phase7' : 'joint_cash_action_distribution'
    );
  } catch (error) {
    return finish(
      error instanceof Error && error.message.startsWith('joint_')
        ? error.message
        : 'joint_analysis_unavailable'
    );
  }
}

/**
 * The returned receipt's P13.1 fields: an eligible proposal carries a valid
 * binding of its own variant, domain and packs, and an ineligible one carries
 * none; the recorded pack versions and uniform escapes are the binding's own;
 * a selection refusal is a named one. A retained receipt without the fields
 * claims no binding and is not refused.
 */
export function jointReceiptBindingIsValid(value: unknown): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const receipt = value as Record<string, unknown>;
  if (
    Object.hasOwn(receipt, 'selectionRefusal') &&
    receipt.selectionRefusal !== null &&
    !SELECTION_REFUSALS.includes(receipt.selectionRefusal as JointSelectionRefusal)
  )
    return false;
  if (receipt.selectionRefusal && receipt.applied !== false) return false;
  if (!Object.hasOwn(receipt, 'inputs')) return true;
  if (
    receipt.rangePackVersion !== JOINT_RANGE_PACK.version ||
    receipt.actionPackVersion !== JOINT_ACTION_PACK.version ||
    !Number.isSafeInteger(receipt.uniformEscapes) ||
    (receipt.uniformEscapes as number) < 0
  )
    return false;
  if (!jointResponseFieldsAreValid(receipt)) return false;
  if (receipt.inputs === null) return receipt.eligible === false;
  if (!jointInputBindingIsValid(receipt.inputs)) return false;
  const inputs = receipt.inputs;
  return (
    receipt.eligible === true &&
    (receipt.responseModel === null || receipt.responseModel === inputs.response.model) &&
    inputs.variant === receipt.variant &&
    inputs.packs.domain === receipt.version &&
    inputs.boards.street === receipt.street &&
    inputs.boards.count === receipt.boardCount &&
    inputs.mode === (receipt.utilityOwner === 'cash' ? 'cash' : 'tournament') &&
    inputs.ranges.provenance.uniformEscapes === receipt.uniformEscapes &&
    inputs.ranges.provenance.requested === receipt.requestedSamples &&
    inputs.ranges.provenance.completed === receipt.completedSamples
  );
}

const unitInterval = (v: unknown) =>
  typeof v === 'number' && Number.isFinite(v) && v >= -1e-9 && v <= 1 + 1e-9;

/** P13.1 over P13-A: the first-class response fields agree with the pack and
 * with the embedded action model. */
function jointResponseFieldsAreValid(receipt: Record<string, unknown>): boolean {
  // Field by field: a journaled receipt is canonicalized with sorted keys.
  const declared = jointResponseLimits();
  const limitsSeen = receipt.responseLimits as Record<string, unknown> | null | undefined;
  if (
    !limitsSeen ||
    typeof limitsSeen !== 'object' ||
    Object.keys(limitsSeen).length !== Object.keys(declared).length ||
    !Array.isArray(limitsSeen.raiseStreets) ||
    limitsSeen.raiseStreets.join() !== declared.raiseStreets.join() ||
    (
      [
        'raisesPerTree',
        'maxRaiseBranchOpponents',
        'maxTerminalBranchesPerCandidate',
        'riverRounds',
      ] as const
    ).some((key) => limitsSeen[key] !== declared[key])
  )
    return false;
  const model = receipt.actionModel as Record<string, unknown> | null | undefined;
  if (receipt.responseVersion === null || receipt.responseModel === null)
    return (
      receipt.responseVersion === null && receipt.responseModel === null && !receipt.responseTree
    );
  if (
    receipt.responseVersion !== JOINT_ACTION_PACK.version ||
    !['one_response_then_showdown', 'bounded_raise_tree'].includes(
      receipt.responseModel as string
    ) ||
    !model ||
    model.version !== receipt.responseVersion ||
    model.responseModel !== receipt.responseModel
  )
    return false;
  const tree = receipt.responseTree as Record<string, unknown> | null | undefined;
  if (receipt.responseModel === 'one_response_then_showdown') return tree === null;
  const keys = [
    'terminalBranches',
    'raiseBranches',
    'raiseProbability',
    'heroCallsRaiseProbability',
    'heroFoldsToRaiseProbability',
    'raiseLimitedResponders',
    'riverRoundProbability',
    'riverBetProbability',
  ];
  const limits = JOINT_ACTION_PACK.limits;
  const river = receipt.street === 'river';
  return (
    !!tree &&
    typeof tree === 'object' &&
    Object.keys(tree).length === keys.length &&
    keys.every((k) => Object.hasOwn(tree, k)) &&
    Number.isSafeInteger(tree.terminalBranches) &&
    (tree.terminalBranches as number) >= 1 &&
    (tree.terminalBranches as number) <= limits.maxTerminalBranchesPerCandidate &&
    Number.isSafeInteger(tree.raiseBranches) &&
    (tree.raiseBranches as number) >= 0 &&
    (tree.raiseBranches as number) < (tree.terminalBranches as number) &&
    Number.isSafeInteger(tree.raiseLimitedResponders) &&
    (tree.raiseLimitedResponders as number) >= 0 &&
    [tree.raiseProbability, tree.heroCallsRaiseProbability, tree.heroFoldsToRaiseProbability].every(
      unitInterval
    ) &&
    (tree.heroCallsRaiseProbability as number) + (tree.heroFoldsToRaiseProbability as number) <=
      (tree.raiseProbability as number) + 1e-9 &&
    (river
      ? tree.riverRoundProbability === null && tree.riverBetProbability === null
      : unitInterval(tree.riverRoundProbability) && unitInterval(tree.riverBetProbability))
  );
}
