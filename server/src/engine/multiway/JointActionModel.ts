import type { HorseDecision, SeatPlayer } from '../../types.js';
import type { HorseGameStateV2 } from '../HorseLogic.js';
import { horseVariantRulesFor } from '../VariantRules.js';
import type { JointRangeSamples } from './JointRangeSampler.js';
import { prepareJointPots, settleJointScores } from './JointPotDistribution.js';
import { applyJointDeductions } from './JointDeductions.js';
import { calculateContestablePot } from '../PokerEngine.js';
import {
  jointCallProbability,
  jointResponseDraw as responseDraw,
  prepareJointActionInput,
  type JointActionCandidate,
} from './JointActionShared.js';
import {
  evaluateJointResponseTree,
  JOINT_RESPONSE_LIMITS,
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

/** Phase 13 P13-A: one bounded legal raise, hero's answer and a turn to river
 * continuation, on the turn and river. Preflop and flop decisions keep the
 * one-response model (declared below); a full-game solution is not implied. */
export const JOINT_ACTION_PACK = Object.freeze({
  version: 'joint-action-response-round2-v1',
  source: 'bounded_one_raise_response_tree_heuristic',
  calibratedConfidence: null,
  responseBranches: 'opponent_specific_fold_call_short_all_in_one_bounded_raise_hero_answer',
  futureRaises: 'one_bounded_raise_then_calls',
  continuation: 'turn_to_river_one_round',
  raiseStreets: JOINT_RESPONSE_LIMITS.raiseStreets,
  earlierStreets: 'one_response_then_showdown',
  raiseSize: 'pot_sized_under_structure_cap_fixed_increment_or_stack_via_action_builder',
  raiseProbability: 'present_board_strength_price_public_line_uncalibrated',
  heroRaiseAnswer: 'raise_weighted_heads_up_equity_over_joint_samples_vs_pot_odds',
  riverRound: 'first_live_player_at_strength_threshold_bets_pot_sized_others_answer_once',
  branchWeighting: 'exact_raise_branch_weights_deterministic_fold_call_draws',
  limits: JOINT_RESPONSE_LIMITS,
  rules: JOINT_RESPONSE_RULES,
  maxSamples: 32,
});

export type JointResponseModel = 'round1' | 'round2';
type RoundOneCount = Pick<
  JointResponseCount,
  'responded' | 'called' | 'folded' | 'allIn' | 'meanCallProbability'
>;
type TreeRow = NonNullable<ReturnType<typeof evaluateJointResponseTree>>['candidates'][number];
export type JointActionRow = Omit<TreeRow, 'responseCounts' | 'responseTree'> & {
  responseCounts: Record<string, RoundOneCount | JointResponseCount>;
  responseTree: TreeRow['responseTree'] | null;
};
export interface JointActionResult {
  version: string;
  responseModel: 'one_response_then_showdown' | 'bounded_raise_tree';
  playersBehind: string[];
  coveringPlayers: string[];
  candidates: JointActionRow[];
}

/**
 * Joint action ranking. The default is the round-2 response pack; pass
 * `{ responseModel: 'round1' }` for the retained comparison identity.
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
  const model = options.responseModel ?? 'round2';
  if (model !== 'round1' && model !== 'round2') throw new Error('joint_action_unknown_model');
  if (model === 'round2' && JOINT_RESPONSE_LIMITS.raiseStreets.includes(state.stage as 'turn')) {
    const tree = evaluateJointResponseTree(
      hero,
      state,
      baseline,
      evidence,
      withinBudget,
      JOINT_ACTION_PACK,
      options.candidateForm
    );
    if (!tree) return null;
    return {
      version: JOINT_ACTION_PACK.version,
      responseModel: 'bounded_raise_tree',
      playersBehind: tree.playersBehind,
      coveringPlayers: coveringPlayers(hero, state),
      candidates: tree.candidates,
    };
  }
  const result = evaluateRoundOne(
    hero,
    state,
    baseline,
    evidence,
    withinBudget,
    options.candidateForm
  );
  if (!result) return null;
  return {
    ...result,
    version: model === 'round1' ? JOINT_ACTION_PACK_ROUND1.version : JOINT_ACTION_PACK.version,
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

/** Round 1, unchanged: one response, then showdown. */
function evaluateRoundOne(
  hero: SeatPlayer,
  state: HorseGameStateV2,
  baseline: HorseDecision,
  evidence: JointRangeSamples,
  withinBudget: () => boolean,
  candidateForm?: (candidates: JointActionCandidate[]) => JointActionCandidate[]
): Omit<JointActionResult, 'version'> | null {
  const { dealt, behind, candidates } = prepareJointActionInput(
    hero,
    state,
    baseline,
    evidence,
    JOINT_ACTION_PACK_ROUND1.maxSamples,
    candidateForm
  );
  const rows: JointActionRow[] = [];
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
          ? hero.bet + hero.stack
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
        const probability = jointCallProbability({
          strengths: sample.boards.map((b) => b.opponentDecisionStrength[otherIndex]),
          range,
          price,
          // A short caller cannot buy a share of deeper side pots. Price
          // this response against its own eligibility before adding the call.
          pot: calculateContestablePot(seats, opponent.user_id, price),
          activeOpponents: seats.filter((p) => !p.is_folded && p.user_id !== opponent.user_id)
            .length,
          coversHero: opponent.stack + opponent.totalInvested >= hero.stack + hero.totalInvested,
        });
        entry.responded++;
        entry.meanCallProbability += probability;
        if (responseDraw(index, opponent.user_id) < probability) {
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
    });
  }
  return {
    responseModel: 'one_response_then_showdown',
    playersBehind: [...behind],
    coveringPlayers: coveringPlayers(hero, state),
    candidates: rows,
  };
}
