import type { HorseDecision, SeatPlayer } from '../../types.js';
import type { HorseGameStateV2 } from '../HorseLogic.js';
import { horseVariantRulesFor } from '../VariantRules.js';
import type { JointRangeSamples } from './JointRangeSampler.js';
import { prepareJointPots, settleJointScores } from './JointPotDistribution.js';
import { applyJointDeductions } from './JointDeductions.js';
import { calculateContestablePot } from '../PokerEngine.js';
import {
  isJointWager,
  jointCallProbability,
  jointResponseDraw as responseDraw,
  prepareJointActionInput,
  type JointActionCandidate,
} from './JointActionShared.js';
import {
  JOINT_RESPONSE_CALIBRATION,
  jointResponseFrequencies,
  jointStrengthPercentiles,
} from './JointResponseCalibration.js';
import {
  evaluateJointResponseTree,
  JOINT_RESPONSE_LIMITS,
  JOINT_RESPONSE_LIMITS_ROUND2,
  JOINT_RESPONSE_RULES,
  type JointResponseCount,
} from './JointResponseTree.js';

export type { JointActionCandidate } from './JointActionShared.js';
export {
  jointPlayersBehind,
  jointCallProbability,
  jointResponseDraw,
} from './JointActionShared.js';
export { jointRaiseShare, jointRiverStrength } from './JointResponseTree.js';

/** The retained comparison identity: one response, then showdown. */
export const JOINT_ACTION_PACK_ROUND1 = Object.freeze({
  version: 'joint-action-response-round1-v2',
  source: 'explicit_one_response_then_showdown_heuristic',
  calibratedConfidence: null,
  responseBranches: 'opponent_specific_fold_call_short_all_in',
  futureRaises: 'not_modeled',
  maxSamples: 32,
});

/** The retained round-2 comparison identity (the pack the October 6 matrices
 * measured): the heuristic response formula, the bounded raise tree on the
 * turn and river and one response then showdown before them. */
export const JOINT_ACTION_PACK_ROUND2 = Object.freeze({
  version: 'joint-action-response-round2-v1',
  source: 'bounded_one_raise_response_tree_heuristic',
  calibratedConfidence: null,
  responseBranches: 'opponent_specific_fold_call_short_all_in_one_bounded_raise_hero_answer',
  futureRaises: 'one_bounded_raise_then_calls',
  continuation: 'turn_to_river_one_round',
  raiseStreets: JOINT_RESPONSE_LIMITS_ROUND2.raiseStreets,
  earlierStreets: 'one_response_then_showdown',
  raiseSize: 'pot_sized_under_structure_cap_fixed_increment_or_stack_via_action_builder',
  raiseProbability: 'present_board_strength_price_public_line_uncalibrated',
  heroRaiseAnswer: 'raise_weighted_heads_up_equity_over_joint_samples_vs_pot_odds',
  riverRound: 'first_live_player_at_strength_threshold_bets_pot_sized_others_answer_once',
  branchWeighting: 'exact_raise_branch_weights_deterministic_fold_call_draws',
  limits: JOINT_RESPONSE_LIMITS_ROUND2,
  rules: JOINT_RESPONSE_RULES,
  maxSamples: 32,
});

/** Phase 13 round 3 selection rule. A candidate replaces the baseline only
 * when its paired edge over the baseline, over the SAME joint samples, clears
 * `z` paired standard errors by at least `minEdgeBigBlinds` big blinds. The
 * baseline is the population's own play; a modeled edge that the samples do
 * not support is not acted on (round 2 ranked on half an absolute standard
 * error and acted on whichever wager the noise favored).
 *
 * It acts only with nothing to call. Facing a wager, the price of every
 * candidate rests on hero's equity against the wagerer's sampled range, and
 * the public-range prior barely narrows a range for its own aggression (one
 * wager adds 0.7 to its weighting exponent, with a uniform escape after three
 * rejections). On the development seeds every family that answers a wager
 * with a raise, a jam or a call the baseline folds was priced at a large
 * edge and realized a loss (NLH bomb flop fold to raise: predicted +79 chips,
 * realized -183). That prior is shared with the live Phase 7 tournament
 * owner, so it is not changed here; the joint owner keeps the baseline there. */
export const JOINT_SELECTION_RULE = Object.freeze({
  rule: 'paired_edge_over_baseline_lower_bound',
  z: 2,
  minEdgeBigBlinds: 0.1,
  actsWhen: 'nothing_to_call',
});

/** Phase 13 round 3: responses measured on the horse population
 * (JointResponseCalibration.ts), one bounded legal raise and hero's answer on
 * the flop, turn and river, and a turn to river continuation. Preflop keeps
 * one calibrated response then showdown, a continuing raise counted as a
 * call. A full-game solution is not implied. */
export const JOINT_ACTION_PACK = Object.freeze({
  version: 'joint-action-response-round3-v1',
  source: 'calibrated_population_response_bounded_raise_tree',
  calibratedConfidence: null,
  responses: JOINT_RESPONSE_CALIBRATION.version,
  responseBranches: 'opponent_specific_fold_call_short_all_in_one_bounded_raise_hero_answer',
  futureRaises: 'one_bounded_raise_then_calls',
  continuation: 'turn_to_river_one_round',
  raiseStreets: JOINT_RESPONSE_LIMITS.raiseStreets,
  earlierStreets: 'preflop_one_calibrated_response_then_showdown',
  raiseSize: 'pot_sized_under_structure_cap_fixed_increment_or_stack_via_action_builder',
  raiseProbability: 'calibrated_population_raise_share_top_of_continuing_range',
  responderOrder: 'runout_strength_percentile_within_own_sampled_range_high_or_low',
  heroRaiseAnswer: 'raise_weighted_heads_up_equity_over_joint_samples_vs_pot_odds',
  riverRound: 'first_live_player_at_strength_threshold_bets_pot_sized_others_answer_once',
  branchWeighting: 'deterministic_calibrated_responses_by_strength_percentile',
  selection: JOINT_SELECTION_RULE,
  limits: JOINT_RESPONSE_LIMITS,
  rules: JOINT_RESPONSE_RULES,
  maxSamples: 32,
});

export type JointResponseModel = 'round1' | 'round2' | 'round3';
type RoundOneCount = Pick<
  JointResponseCount,
  'responded' | 'called' | 'folded' | 'allIn' | 'meanCallProbability'
>;
type TreeRow = NonNullable<ReturnType<typeof evaluateJointResponseTree>>['candidates'][number];
type PricedRow = Omit<TreeRow, 'responseCounts' | 'responseTree'> & {
  responseCounts: Record<string, RoundOneCount | JointResponseCount>;
  responseTree: TreeRow['responseTree'] | null;
};
export type JointActionRow = Omit<PricedRow, 'sampleNets'> & {
  /** Mean of (this row minus the baseline row) over the same joint samples;
   * 0 for the baseline row, null when the baseline was not priced. */
  pairedEdge: number | null;
  pairedStandardError: number | null;
};
export interface JointActionResult {
  version: string;
  responseModel: 'one_response_then_showdown' | 'bounded_raise_tree';
  playersBehind: string[];
  coveringPlayers: string[];
  /** The candidate that is the baseline decision, null when none is. */
  baselineCandidateId: string | null;
  candidates: JointActionRow[];
}

/** The candidate row that is the baseline decision itself. */
function isBaselineRow(row: { action: string; amount: number | null }, baseline: HorseDecision) {
  return (
    row.action === baseline.action &&
    (!['bet', 'raise'].includes(row.action) || row.amount === (baseline.amount ?? null))
  );
}

/** Each row's paired difference from the baseline row over the same samples,
 * and the per-sample nets dropped from the returned rows. */
function pairWithBaseline(
  rows: PricedRow[],
  baseline: HorseDecision
): { baselineCandidateId: string | null; candidates: JointActionRow[] } {
  const base = rows.find((r) => isBaselineRow(r, baseline)) ?? null;
  const candidates = rows.map(({ sampleNets, ...row }) => {
    if (!base) return { ...row, pairedEdge: null, pairedStandardError: null };
    const d = sampleNets.map((net, i) => net - base.sampleNets[i]);
    const n = d.length;
    const mean = d.reduce((a, b) => a + b, 0) / n;
    const variance = n > 1 ? d.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1) : 0;
    return { ...row, pairedEdge: mean, pairedStandardError: Math.sqrt(variance / n) };
  });
  return { baselineCandidateId: base?.id ?? null, candidates };
}

/**
 * Joint action ranking. The default is the round-3 response pack; pass
 * `{ responseModel: 'round2' }` or `{ responseModel: 'round1' }` for a
 * retained comparison identity. Every row carries its paired edge over the
 * baseline row on the same samples.
 * Returns null when the work deadline interrupts any branch: a partially
 * ranked action set is never returned. A candidate needing more terminal
 * branches than the declared limit throws joint_response_branch_unavailable.
 */
export function evaluateJointActions(
  hero: SeatPlayer,
  state: HorseGameStateV2,
  baseline: HorseDecision,
  evidence: JointRangeSamples,
  withinBudget: () => boolean,
  options: {
    responseModel?: JointResponseModel;
    /** P13.1: the caller's legal form, applied to the candidates of either
     * model before any is priced. */
    candidateForm?: (candidates: JointActionCandidate[]) => JointActionCandidate[];
  } = {}
): JointActionResult | null {
  const model = options.responseModel ?? 'round3';
  if (model !== 'round1' && model !== 'round2' && model !== 'round3')
    throw new Error('joint_action_unknown_model');
  const pack = model === 'round2' ? JOINT_ACTION_PACK_ROUND2 : JOINT_ACTION_PACK;
  if (model !== 'round1' && (pack.limits.raiseStreets as readonly string[]).includes(state.stage)) {
    const tree = evaluateJointResponseTree(
      hero,
      state,
      baseline,
      evidence,
      withinBudget,
      pack,
      options.candidateForm
    );
    if (!tree) return null;
    return {
      version: pack.version,
      responseModel: 'bounded_raise_tree',
      playersBehind: tree.playersBehind,
      coveringPlayers: coveringPlayers(hero, state),
      ...pairWithBaseline(tree.candidates, baseline),
    };
  }
  const result = evaluateRoundOne(
    hero,
    state,
    baseline,
    evidence,
    withinBudget,
    model === 'round3' ? 'calibrated' : 'heuristic',
    options.candidateForm
  );
  if (!result) return null;
  const { candidates, ...rest } = result;
  return {
    ...rest,
    ...pairWithBaseline(candidates, baseline),
    version: model === 'round1' ? JOINT_ACTION_PACK_ROUND1.version : pack.version,
  };
}

function coveringPlayers(hero: SeatPlayer, state: HorseGameStateV2) {
  return state.players
    .filter(
      (p) =>
        p.user_id !== hero.user_id &&
        !p.is_folded &&
        p.stack + p.totalInvested >= hero.stack + hero.totalInvested
    )
    .map((p) => p.user_id);
}

/** Round 1: one response, then showdown. A jam raises to `hero.bet +
 * investment`: the builder sets a fixed-limit jam's investment to the street
 * ceiling the controller clamps it to. `heuristic` is the retained round-1
 * response formula; `calibrated` (the current pack, preflop) is the measured
 * population response, its continuing raise counted as a call. */
function evaluateRoundOne(
  hero: SeatPlayer,
  state: HorseGameStateV2,
  baseline: HorseDecision,
  evidence: JointRangeSamples,
  withinBudget: () => boolean,
  responder: 'heuristic' | 'calibrated',
  candidateForm?: (candidates: JointActionCandidate[]) => JointActionCandidate[]
): {
  responseModel: 'one_response_then_showdown';
  playersBehind: string[];
  coveringPlayers: string[];
  candidates: PricedRow[];
} | null {
  const { dealt, behind, candidates } = prepareJointActionInput(
    hero,
    state,
    baseline,
    evidence,
    JOINT_ACTION_PACK_ROUND1.maxSamples,
    candidateForm
  );
  const rows: PricedRow[] = [];
  const streetWagers = (state.actionHistory ?? []).filter(
    (a) => a.stage === state.stage && isJointWager(a)
  ).length;
  const percentiles = new Map<string, number[]>();
  const percentileOf = (id: string, index: number) => {
    let p = percentiles.get(id);
    if (!p)
      percentiles.set(
        id,
        (p = jointStrengthPercentiles(
          evidence.samples,
          index,
          (k) => responseDraw(k, id),
          horseVariantRulesFor(state.gameVariant).splitLow8OrBetter
        ))
      );
    return p;
  };
  for (const candidate of candidates) {
    const returns: number[] = [],
      vectors: number[][] = [];
    const responseCounts: Record<
      string,
      {
        responded: number;
        called: number;
        folded: number;
        allIn: number;
        meanCallProbability: number;
      }
    > = Object.fromEntries(
      evidence.opponentIds.map((id) => [
        id,
        { responded: 0, called: 0, folded: 0, allIn: 0, meanCallProbability: 0 },
      ])
    );
    let sumRake = 0,
      sumBbj = 0,
      allFold = 0,
      sidePotCount = 0,
      maxConservationError = 0;
    const boardReturns: number[][] = [];
    for (let index = 0; index < evidence.samples.length; index++) {
      if (!withinBudget()) return null;
      const sample = evidence.samples[index];
      const seats = state.players.map((p) => ({ ...p, cards: [] }));
      const mine = seats.find((p) => p.user_id === hero.user_id)!;
      const commit = (p: SeatPlayer, amount: number) => {
        const unit = state.chipUnit!;
        const paid = Math.min(p.stack, Math.max(0, Math.round(amount / unit) * unit));
        p.stack = Math.round((p.stack - paid) / unit) * unit;
        p.bet = Math.round((p.bet + paid) / unit) * unit;
        p.totalInvested = Math.round((p.totalInvested + paid) / unit) * unit;
        if (p.stack === 0) p.is_all_in = true;
      };
      if (candidate.kind === 'fold') mine.is_folded = true;
      else commit(mine, candidate.investment);
      const wager = ['bet', 'raise', 'jam'].includes(candidate.kind);
      const target = wager
        ? candidate.kind === 'jam'
          ? hero.bet + candidate.investment
          : candidate.amount!
        : state.currentBet;
      const responseOrder = [
        ...seats.filter((p) => p.seat > hero.seat).sort((a, b) => a.seat - b.seat),
        ...seats.filter((p) => p.seat < hero.seat).sort((a, b) => a.seat - b.seat),
      ];
      for (const opponent of responseOrder) {
        if (opponent.user_id === hero.user_id || opponent.is_folded) continue;
        const entry = responseCounts[opponent.user_id];
        if (opponent.is_all_in) {
          if (entry) entry.allIn++;
          continue;
        }
        if (!(wager || behind.has(opponent.user_id))) continue;
        const price = Math.min(opponent.stack, Math.max(0, target - opponent.bet));
        if (price <= 0) continue;
        const otherIndex = evidence.opponentIds.indexOf(opponent.user_id);
        const range = evidence.ranges.find((r) => r.userId === opponent.user_id)!;
        // A short caller cannot buy a share of deeper side pots. Price this
        // response against its own eligibility before adding the call.
        const pot = calculateContestablePot(seats, opponent.user_id, price);
        const activeOpponents = seats.filter(
          (p) => !p.is_folded && p.user_id !== opponent.user_id
        ).length;
        let probability: number, continues: boolean;
        if (responder === 'calibrated') {
          probability = jointResponseFrequencies({
            variant: state.gameVariant,
            street: state.stage,
            price,
            pot,
            active: activeOpponents,
            streetWagers: streetWagers + Number(wager),
            ownRaises: range.raises,
            bomb: Boolean(state.bombPot),
            allInForCall: opponent.stack <= price + 1e-9,
          }).continueFrequency;
          continues = percentileOf(opponent.user_id, otherIndex)[index] > 1 - probability;
        } else {
          probability = jointCallProbability({
            strengths: sample.boards.map((b) => b.opponentDecisionStrength[otherIndex]),
            range,
            price,
            pot,
            activeOpponents,
            coversHero: opponent.stack + opponent.totalInvested >= hero.stack + hero.totalInvested,
          });
          continues = responseDraw(index, opponent.user_id) < probability;
        }
        entry.responded++;
        entry.meanCallProbability += probability;
        if (continues) {
          commit(opponent, price);
          entry.called++;
          if (opponent.is_all_in) entry.allIn++;
        } else {
          opponent.is_folded = true;
          entry.folded++;
        }
      }
      if (wager && seats.filter((p) => !p.is_folded).length === 1) allFold++;
      const prepared = prepareJointPots(seats, state.chipUnit!);
      sidePotCount = Math.max(sidePotCount, prepared.pots.length);
      const settled = settleJointScores({
        prepared,
        heroId: hero.user_id,
        opponentIds: evidence.opponentIds,
        sample,
        splitLow: horseVariantRulesFor(state.gameVariant).splitLow8OrBetter,
        dealerSeat: state.dealerSeat!,
      });
      const fees = applyJointDeductions({
        settlement: settled,
        rakeConfig: state.rakeConfig!,
        bbjConfig: state.bbjConfig!,
        asset: state.asset!,
        gameMode: state.gameMode as 'cash' | 'tournament',
        bigBlind: state.bigBlind,
        dealtPlayers: dealt.length,
        sawFlop: state.stage !== 'preflop' || seats.filter((p) => !p.is_folded).length > 1,
      });
      sumRake += fees.rake;
      sumBbj += fees.bbjFee;
      const vector = prepared.seats.map((p) => p.stack + fees.netTotals[p.user_id]);
      const before = state.players.reduce((a, p) => a + p.stack + p.totalInvested, 0);
      const error = Math.abs(vector.reduce((a, b) => a + b, 0) + fees.rake + fees.bbjFee - before);
      maxConservationError = Math.max(maxConservationError, error);
      if (error > 1e-6) throw new Error('joint_action_conservation');
      returns.push(
        vector[prepared.seats.findIndex((p) => p.user_id === hero.user_id)] - hero.stack
      );
      vectors.push(vector);
      boardReturns.push(settled.boardTotals.map((b) => b[hero.user_id]));
    }
    const n = returns.length,
      mean = returns.reduce((a, b) => a + b, 0) / n;
    const variance = returns.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1);
    const means = boardReturns[0].map((_, b) => boardReturns.reduce((a, row) => a + row[b], 0) / n);
    rows.push({
      id: candidate.id,
      action: candidate.action,
      amount: candidate.amount,
      investment: candidate.investment,
      expectedNetChips: mean,
      standardError: Math.sqrt(variance / n),
      variance,
      minimumNetChips: Math.min(...returns),
      maximumNetChips: Math.max(...returns),
      boardMeans: means,
      covariance: means.map((mean, a) =>
        means.map(
          (other, b) =>
            boardReturns.reduce((sum, row) => sum + (row[a] - mean) * (row[b] - other), 0) / (n - 1)
        )
      ),
      allFoldProbability: allFold / n,
      expectedRake: sumRake / n,
      expectedBbj: sumBbj / n,
      sidePotCount,
      maxConservationError,
      resultingStackVectors: new Set(vectors.map((v) => v.map((n) => n.toFixed(2)).join(':'))).size,
      responseCounts: Object.fromEntries(
        Object.entries(responseCounts).map(([id, v]) => [
          id,
          { ...v, meanCallProbability: v.responded ? v.meanCallProbability / v.responded : null },
        ])
      ),
      responseTree: null,
      samples: n,
      rollout: JOINT_ACTION_PACK_ROUND1.source,
      sampleNets: returns,
    });
  }
  return {
    responseModel: 'one_response_then_showdown',
    playersBehind: [...behind],
    coveringPlayers: coveringPlayers(hero, state),
    candidates: rows,
  };
}
