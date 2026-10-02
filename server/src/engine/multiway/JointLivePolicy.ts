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
import { evaluateJointActions } from './JointActionModel.js';
import { prepareJointPots, jointPotDistribution } from './JointPotDistribution.js';

export { JOINT_LIVE_DOMAIN } from './JointSampleAcquisition.js';
export type JointPolicyMode = 'off' | 'shadow' | 'candidate';
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
}
const same = (a: HorseDecision, b: HorseDecision) =>
  a.action === b.action && (!['bet', 'raise'].includes(a.action) || a.amount === b.amount);

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
  acquisition?: JointSampleAcquisition
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
  };
  const finish = (reason: string) => {
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
    receipt.actionModel = evaluateJointActions(
      hero,
      s,
      baseline,
      jointEvidence,
      () => elapsed() < JOINT_LIVE_DOMAIN.liveBudgetMs
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
    proposal = { ...baseline, action: selected.action, amount: selected.amount ?? undefined };
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
