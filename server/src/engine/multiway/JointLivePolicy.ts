import type { HorseDecision, SeatPlayer, HorseTournamentUtilityLedger } from '../../types.js';
import type { HorseGameStateV2 } from '../HorseLogic.js';
import { maxSeatsForVariant } from '../../config/tableSeating.js';
import { horseVariantRulesFor, isKnownVariant, maxSeatsFor } from '../VariantRules.js';
import { bettingStructureFor } from '../BettingStructure.js';
import { equityGovernor } from '../EquityLoadGovernor.js';
import { validateDealtSeatCensus } from './DealtSeatCensus.js';
import { sampleJointRanges, type JointRangeSamples } from './JointRangeSampler.js';
import { evaluateJointActions } from './JointActionModel.js';
import { prepareJointPots, jointPotDistribution } from './JointPotDistribution.js';

export const JOINT_LIVE_DOMAIN = Object.freeze({
  version: 'joint-multiway-round1-v1',
  defaultMode: 'shadow',
  calibratedConfidence: null,
  maxStackBB: 250,
  maxActions: 256,
  defaultSamples: 16,
  minSamples: 8,
  liveBudgetMs: 4,
  samplingDeadlineMs: 2,
});
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
  now = () => performance.now()
) {
  const start = now();
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
    receipt.latencyMs = Math.max(0, now() - start);
    if (receipt.latencyMs > JOINT_LIVE_DOMAIN.liveBudgetMs) {
      reason = 'work_budget';
      receipt.fired = false;
      proposal = baseline;
    }
    if (!receipt.fired) proposal = baseline;
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
  if (!isKnownVariant(s.gameVariant)) return finish('unknown_variant');
  if (s.stage === 'pineapple_discard') return finish('discard_owned_by_worker');
  if (!['preflop', 'flop', 'turn', 'river'].includes(s.stage))
    return finish('outside_betting_street');
  if (s.gameVariant === 'pineapple' && s.gameMode === 'tournament')
    return finish('pineapple_tournament_unavailable');
  if (
    s.gameMode === 'tournament' &&
    s.format === 'spin' &&
    !['nlh', 'plo4', 'plo5', 'plo6'].includes(s.gameVariant)
  )
    return finish('variant_spin_unavailable');
  if (
    s.stateSchemaVersion !== 1 ||
    !s.legalActions?.includes(baseline.action) ||
    s.bettingStructure !== bettingStructureFor(s.gameVariant) ||
    !['cash', 'tournament'].includes(s.gameMode ?? '') ||
    hero.is_folded ||
    hero.is_all_in ||
    hero.is_sitting_out
  )
    return finish('canonical_state_unavailable');
  let ids: number[];
  try {
    ids = validateDealtSeatCensus(s.players, hero.seat, s.dealtSeatIds);
  } catch {
    return finish('dealt_census_unavailable');
  }
  receipt.dealtPlayers = ids.length;
  const contenders = s.players.filter((p) => !p.is_folded && ids.includes(p.seat));
  receipt.liveOpponents = contenders.filter((p) => p.user_id !== hero.user_id).length;
  if (receipt.liveOpponents < 1) return finish('no_opponent');
  if (!s.bombPot && receipt.boardCount === 1 && receipt.liveOpponents === 1)
    return finish('heads_up_owned_by_variant_policy');
  const cap =
    s.gameMode === 'cash'
      ? maxSeatsForVariant(s.gameVariant)
      : Math.min(10, maxSeatsFor(s.gameVariant));
  if (ids.length > cap) return finish('seats_outside_launch_domain');
  if (s.stage === 'preflop' && (s.bombPot || receipt.boardCount > 1))
    return finish('bomb_hand_has_no_preflop_decision');
  if (s.bbjConfig === undefined) return finish('deductions_unavailable');
  if (
    s.chipUnit !== (s.asset === 'diamonds' || s.gameMode === 'tournament' ? 1 : 0.01) ||
    !['chips', 'diamonds'].includes(s.asset ?? '')
  )
    return finish('chip_rules_unavailable');
  if (s.asset === 'diamonds' && s.gameVariant !== 'nlh')
    return finish('diamond_variant_unavailable');
  if (!Number.isInteger(s.dealerSeat) || s.dealerSeat! < 1 || s.dealerSeat! > 10)
    return finish('button_unavailable');
  const unit = s.chipUnit!;
  const valid = (n: unknown) =>
    typeof n === 'number' &&
    Number.isFinite(n) &&
    n >= 0 &&
    Math.abs(n / unit - Math.round(n / unit)) < 1e-6;
  if (
    !valid(s.bigBlind) ||
    s.bigBlind <= 0 ||
    hero.stack <= 0 ||
    !valid(s.currentBet) ||
    !valid(s.pot) ||
    !valid(s.toCall) ||
    Math.abs(s.toCall! - Math.max(0, s.currentBet - hero.bet)) > unit / 1e4 ||
    Math.abs(s.players.reduce((n, p) => n + p.totalInvested, 0) - s.pot) > unit / 1e4 ||
    s.players.some(
      (p) =>
        ![
          p.stack,
          p.bet,
          p.totalInvested,
          p.deadInvested ?? 0,
          p.individualAnteInvested ?? 0,
        ].every(valid)
    )
  )
    return finish('invalid_chip_geometry');
  if (
    Math.min(
      hero.stack,
      Math.max(...contenders.filter((p) => p.user_id !== hero.user_id).map((p) => p.stack + p.bet))
    ) /
      s.bigBlind >
    JOINT_LIVE_DOMAIN.maxStackBB
  )
    return finish('depth_outside_domain');
  if ((s.actionHistory?.length ?? 0) > JOINT_LIVE_DOMAIN.maxActions)
    return finish('history_budget');
  if (s.players.some((p) => !Array.isArray(p.cards) || p.cards.length || p.knownDeadCards?.length))
    return finish('private_state_rejected');
  const requested = Math.max(
    JOINT_LIVE_DOMAIN.minSamples,
    Math.floor(
      JOINT_LIVE_DOMAIN.defaultSamples * Math.max(0, Math.min(1, equityGovernor.current()))
    )
  );
  receipt.eligible = true;
  receipt.requestedSamples = requested;
  try {
    jointEvidence = sampleJointRanges(hero, s, {
      samples: requested,
      withinBudget: () => now() - start < JOINT_LIVE_DOMAIN.samplingDeadlineMs,
    });
    if (!jointEvidence) return finish('joint_samples_unavailable');
    receipt.stateKey = jointEvidence.stateKey;
    receipt.ranges = jointEvidence.ranges;
    receipt.completedSamples = jointEvidence.samples.length;
    receipt.sampleBudgetExhausted = jointEvidence.sampleBudgetExhausted;
    if (jointEvidence.samples.length < JOINT_LIVE_DOMAIN.minSamples)
      return finish('insufficient_joint_samples');
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
      () => now() - start < JOINT_LIVE_DOMAIN.liveBudgetMs
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
