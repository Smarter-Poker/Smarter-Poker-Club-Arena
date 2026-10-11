import type { SeatPlayer } from '../../types.js';
import type { HorseGameStateV2 } from '../HorseLogic.js';
import type { HorseTournamentJointSamplerProvenance } from '../HorseTournamentUtilityEvidence.js';
import { maxSeatsForVariant } from '../../config/tableSeating.js';
import { isKnownVariant, maxSeatsFor } from '../VariantRules.js';
import { bettingStructureFor } from '../BettingStructure.js';
import { REMAINING_VARIANT_DOMAIN } from '../remainingVariants/RemainingVariantPolicyPack.js';
import { validateDealtSeatCensus } from './DealtSeatCensus.js';
import {
  JOINT_RANGE_PACK,
  jointStateKey,
  sampleJointRanges,
  type JointRangeSamples,
} from './JointRangeSampler.js';

export const JOINT_LIVE_DOMAIN = Object.freeze({
  version: 'joint-multiway-round1-v4',
  defaultMode: 'shadow',
  calibratedConfidence: null,
  maxStackBB: 250,
  // Match the Phase 12 fixed-limit domain. Fixed wager bounds control each
  // candidate's exposure even when the table permits a 1000 BB starting stack.
  fixedLimitMaxStackBB: REMAINING_VARIANT_DOMAIN.fixedLimitMaxStackBB,
  maxActions: 256,
  defaultSamples: 16,
  fullSampleMaxDealtPlayers: 4,
  largeTableSamples: 8,
  minSamples: 8,
  // Declared values the P13.2 contract records (JOINT_STRENGTH_CONTRACT,
  // policy_clock_and_sampling) and the Phase 7 tournament allowance
  // (JOINT_SAMPLE_WORK_BUDGET_MS). Since 2026-10-11 the Phase 13 policy and the
  // joint acquisition read no clock to decide their work: a live decision does
  // exactly the fixed work the matrix priced (see acquireJointSamples and
  // evaluateJointLivePolicy), so these two are no longer live cut-offs.
  liveBudgetMs: 4,
  samplingDeadlineMs: 2.5,
});
/**
 * P13.3: the full sample count for a table of `dealtPlayers`: 16 through four
 * dealt players, 8 above. Every P13.2 matrix proposal was priced on it, and
 * since 2026-10-11 it is the live request too, whatever the equity governor
 * says (the #6592 rule for the Omaha and remaining-variant samplers). The
 * P13.3 completion record still counts a smaller request as governor-reduced.
 */
export function jointFullSamples(dealtPlayers: number): number {
  return dealtPlayers > JOINT_LIVE_DOMAIN.fullSampleMaxDealtPlayers
    ? JOINT_LIVE_DOMAIN.largeTableSamples
    : JOINT_LIVE_DOMAIN.defaultSamples;
}
/** Phase 7's own tournament allowance for pricing its utility on the joint
 * samples (HorseLogic's jointWithinBudget). Phase 7 consumes the same physical
 * samples without enabling the Phase 13 action policy; neither the joint
 * acquisition nor the Phase 13 policy reads it. */
export const JOINT_SAMPLE_WORK_BUDGET_MS = JOINT_LIVE_DOMAIN.liveBudgetMs;

interface JointAcquisitionFacts {
  readonly eligible: boolean;
  readonly dealtPlayers: number;
  readonly liveOpponents: number;
  readonly requestedSamples: number;
  /** Entire acquisition cost, including validation and immutable sealing: a
   * measurement only. The work itself is fixed (the full sample count and the
   * sampler's declared rejection attempts); no clock decides it. */
  readonly samplingMs: number;
}
export type JointSampleAcquisition = JointAcquisitionFacts &
  (
    | {
        readonly status: 'acquired';
        readonly reason: 'joint_samples_acquired';
        readonly evidence: JointRangeSamples;
        readonly provenance: HorseTournamentJointSamplerProvenance;
      }
    | {
        readonly status: 'refused';
        readonly reason: string;
        readonly evidence: JointRangeSamples | null;
        readonly provenance: null;
      }
  );

// Object identity is deliberately internal. A JSON/structured-clone roundtrip,
// copied marginal rows, or a recomputed public hash cannot mint an acquisition.
const acquisitions = new WeakMap<object, string | null>();
function freezeTree<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const item of Object.values(value)) freezeTree(item);
    Object.freeze(value);
  }
  return value;
}

/** A bridge is valid only for the exact facts from which this module acquired
 * it. Equal copied state is fine; copied evidence, changed cards, commitments,
 * rules, public history or table/hand identity are not. */
export function jointSampleAcquisitionMatches(
  hero: SeatPlayer,
  state: HorseGameStateV2,
  acquisition: unknown
): acquisition is JointSampleAcquisition {
  if (!acquisition || typeof acquisition !== 'object') return false;
  const stateKey = acquisitions.get(acquisition);
  if (typeof stateKey !== 'string') return false;
  try {
    return jointStateKey(hero, state) === stateKey;
  } catch {
    return false;
  }
}

/** Acquire a bounded population, independent of any policy mode. This is an
 * internal decision-local API: no seed, replacement rows, or physical-card tap
 * is accepted from callers. The existing sampler owns shared-deck validity.
 *
 * THE LIVE WORK IS THE MEASURED WORK (2026-10-11). The request is always the
 * full count (jointFullSamples), never scaled by the equity governor, and the
 * sampler is never stopped by a clock: its work is bounded by the declared
 * sample count, the opponents dealt and JOINT_RANGE_PACK.rejectionAttempts per
 * opponent, exactly what the P13.2 matrix ran on its fixed clock. On release
 * f47ad93c (PLO8 cash, 20:02 to 20:50Z) the 2.5 ms deadline cut 8 of 1,295
 * eligible populations short and the governor reduced 94, each one a decision
 * that was not the measured policy. `options.now` only measures samplingMs. */
export function acquireJointSamples(
  hero: SeatPlayer,
  s: HorseGameStateV2,
  options: { now?: () => number } = {}
): JointSampleAcquisition {
  const now = options.now ?? (() => performance.now());
  const start = now();
  const boardCount = s.boardCount ?? 1;
  let dealtPlayers = 0;
  let liveOpponents = 0;
  let eligible = false;
  let requestedSamples = 0;
  let evidence: JointRangeSamples | null = null;
  const finish = (
    reason: string,
    provenance: HorseTournamentJointSamplerProvenance | null = null
  ): JointSampleAcquisition => {
    // Seal nested score arrays before granting any consumer access. The source
    // request itself stays caller-owned and is checked again on reuse.
    freezeTree(evidence);
    freezeTree(provenance);
    let stateKey: string | null = evidence?.stateKey ?? null;
    if (stateKey === null) {
      try {
        stateKey = jointStateKey(hero, s);
      } catch {
        /* named refusal retained */
      }
    }
    // Measured, never a cut-off: the population is the declared work.
    const samplingMs = now() - start;
    const facts = { eligible, dealtPlayers, liveOpponents, requestedSamples, samplingMs };
    const result: JointSampleAcquisition =
      provenance && evidence
        ? { ...facts, status: 'acquired', reason: 'joint_samples_acquired', evidence, provenance }
        : { ...facts, status: 'refused', reason, evidence, provenance: null };
    Object.freeze(result);
    acquisitions.set(result, stateKey);
    return result;
  };
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
    !s.legalActions?.length ||
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
  dealtPlayers = ids.length;
  const contenders = s.players.filter((p) => !p.is_folded && ids.includes(p.seat));
  liveOpponents = contenders.filter((p) => p.user_id !== hero.user_id).length;
  if (liveOpponents < 1) return finish('no_opponent');
  if (!s.bombPot && boardCount === 1 && liveOpponents === 1)
    return finish('heads_up_owned_by_variant_policy');
  const cap =
    s.gameMode === 'cash'
      ? maxSeatsForVariant(s.gameVariant)
      : Math.min(10, maxSeatsFor(s.gameVariant));
  if (ids.length > cap) return finish('seats_outside_launch_domain');
  if (s.stage === 'preflop' && (s.bombPot || boardCount > 1))
    return finish('bomb_hand_has_no_preflop_decision');
  if (s.bbjConfig === undefined) return finish('deductions_unavailable');
  if (
    s.chipUnit !== (s.asset === 'diamonds' || s.gameMode === 'tournament' ? 1 : 0.01) ||
    !['chips', 'diamonds'].includes(s.asset ?? '')
  )
    return finish('chip_rules_unavailable');
  if (s.asset === 'diamonds' && s.gameVariant !== 'nlh')
    return finish('diamond_variant_unavailable');
  if (s.asset === 'diamonds' && s.gameMode !== 'cash')
    return finish('diamond_tournament_unavailable');
  if (s.asset === 'diamonds' && s.rakeConfig?.cap !== 0)
    return finish('diamond_deductions_unavailable');
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
      hero.stack + hero.bet,
      Math.max(...contenders.filter((p) => p.user_id !== hero.user_id).map((p) => p.stack + p.bet))
    ) /
      s.bigBlind >
    (s.bettingStructure === 'fixed_limit'
      ? JOINT_LIVE_DOMAIN.fixedLimitMaxStackBB
      : JOINT_LIVE_DOMAIN.maxStackBB)
  )
    return finish('depth_outside_domain');
  if ((s.actionHistory?.length ?? 0) > JOINT_LIVE_DOMAIN.maxActions)
    return finish('history_budget');
  if (s.players.some((p) => !Array.isArray(p.cards) || p.cards.length || p.knownDeadCards?.length))
    return finish('private_state_rejected');
  const requested = jointFullSamples(ids.length);
  eligible = true;
  requestedSamples = requested;
  try {
    evidence = sampleJointRanges(hero, s, {
      samples: requested,
      // The declared work, never a clock (see above).
      withinBudget: () => true,
    });
    if (!evidence) return finish('joint_samples_unavailable');
    if (evidence.samples.length < JOINT_LIVE_DOMAIN.minSamples)
      return finish('insufficient_joint_samples');
    return finish('joint_samples_acquired', {
      version: 'horse-joint-sampler-provenance-v1',
      samplerVersion: 'joint-public-range-round1-v1',
      stateKey: evidence.stateKey,
      layout: 'independent',
      sharedPrefixLength: 0,
      boardCount: evidence.boardCount as 1 | 2 | 3,
      requestedSamples: evidence.requestedSamples,
      completedSamples: evidence.samples.length,
      sampleBudgetExhausted: evidence.sampleBudgetExhausted,
      uniformEscapes: evidence.uniformEscapes,
      physicalCardsPerSample: evidence.physicalCardsPerSample,
      unknownDealtCardsPerSample: evidence.unknownDealtCardsPerSample,
      rangeModel: {
        version: 'joint-public-range-round1-v1',
        source: JOINT_RANGE_PACK.source,
        confidence: JOINT_RANGE_PACK.confidence,
      },
    });
  } catch (error) {
    return finish(
      error instanceof Error && error.message.startsWith('joint_')
        ? error.message
        : 'joint_analysis_unavailable'
    );
  }
}
