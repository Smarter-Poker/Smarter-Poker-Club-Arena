import type { HorseDecision, SeatPlayer } from '../../types.js';
import type { HorseGameStateV2 } from '../HorseLogic.js';
import { buildTournamentActionCandidates } from '../HorseTournamentUtility.js';
import { horseVariantRulesFor } from '../VariantRules.js';
import { validateDealtSeatCensus } from './DealtSeatCensus.js';
import type { JointRangeSamples, JointOpponentRange } from './JointRangeSampler.js';
import { jointStateKey } from './JointRangeSampler.js';
import { prepareJointPots, settleJointScores } from './JointPotDistribution.js';
import { applyJointDeductions } from './JointDeductions.js';
import { calculateContestablePot } from '../PokerEngine.js';

export const JOINT_ACTION_PACK = Object.freeze({
  version: 'joint-action-response-round1-v2',
  source: 'explicit_one_response_then_showdown_heuristic',
  calibratedConfidence: null,
  responseBranches: 'opponent_specific_fold_call_short_all_in',
  futureRaises: 'not_modeled',
  maxSamples: 32,
});
const clamp = (n: number, low = 0, high = 1) => Math.max(low, Math.min(high, n));

/** Actual dealt-seat ring, including sparse seats and a dead button. Folded
 * seats consume position/card occupancy but do not owe another action. */
export function jointPlayersBehind(hero: SeatPlayer, state: HorseGameStateV2): string[] {
  const ids = validateDealtSeatCensus(state.players, hero.seat, state.dealtSeatIds);
  const dealer = state.dealerSeat;
  if (!Number.isInteger(dealer) || dealer! < 1 || dealer! > 10)
    throw new Error('joint_action_missing_button');
  const clockwise = [...ids.filter((s) => s > dealer!), ...ids.filter((s) => s <= dealer!)];
  let first = 0;
  if (state.stage === 'preflop' && !state.bombPot) {
    first =
      ids.length === 2 ? clockwise.indexOf(dealer!) : (state.straddleActive ? 3 : 2) % ids.length;
    if (first < 0) throw new Error('joint_action_heads_up_button_not_dealt');
  }
  const order = [...clockwise.slice(first), ...clockwise.slice(0, first)];
  const index = order.indexOf(hero.seat);
  const later = new Set(order.slice(index + 1));
  const remaining = [...order.slice(index + 1), ...order.slice(0, index)];
  return remaining.flatMap((seat) => {
    const p = state.players.find((p) => p.seat === seat)!;
    // A raise reopens responses around the ring, including a player who
    // checked or called earlier. Their public unpaid wager remains owed.
    return !p.is_folded &&
      !p.is_sitting_out &&
      !p.is_all_in &&
      (later.has(seat) || p.bet < state.currentBet)
      ? [p.user_id]
      : [];
  });
}

/** Present-board strengths and the public line alone set response odds. No
 * showdown ranks/runout information enters this opponent decision. */
export function jointCallProbability(input: {
  strengths: number[];
  range: JointOpponentRange;
  price: number;
  pot: number;
  activeOpponents: number;
  coversHero: boolean;
}) {
  if (!input.strengths.length || input.strengths.some((s) => !Number.isFinite(s) || s < 0 || s > 1))
    throw new Error('joint_action_invalid_strength');
  if (input.price <= 0) return 1;
  const mean = input.strengths.reduce((a, b) => a + b, 0) / input.strengths.length;
  // A strong single board can justify continuing, but never masquerades as
  // a scoop. The settlement distribution separately carries its actual risk.
  const signal = mean * 0.75 + Math.max(...input.strengths) * 0.25;
  const potPrice = input.price / Math.max(input.price, input.pot + input.price);
  return clamp(
    0.12 +
      signal * 0.88 +
      Math.min(0.12, input.range.raises * 0.04) -
      potPrice * 0.62 -
      Math.max(0, input.activeOpponents - 1) * 0.025 +
      Number(input.coversHero) * 0.035,
    0.02,
    0.98
  );
}

function responseDraw(index: number, id: string) {
  let value = (index + 1) ^ 0x7f4a7c15;
  for (const c of id) value = Math.imul(value ^ c.charCodeAt(0), 16777619);
  value ^= value >>> 16;
  value = Math.imul(value, 0x85ebca6b);
  value ^= value >>> 13;
  return (value >>> 0) / 0x100000000;
}

export function evaluateJointActions(
  hero: SeatPlayer,
  state: HorseGameStateV2,
  baseline: HorseDecision,
  evidence: JointRangeSamples,
  withinBudget: () => boolean
) {
  if (evidence.stateKey !== jointStateKey(hero, state))
    throw new Error('joint_action_stale_evidence');
  if (
    state.stateSchemaVersion !== 1 ||
    !state.legalActions ||
    !state.rakeConfig ||
    state.bbjConfig === undefined ||
    ![0.01, 1].includes(state.chipUnit ?? 0) ||
    !['chips', 'diamonds'].includes(state.asset ?? '') ||
    !['cash', 'tournament'].includes(state.gameMode ?? '') ||
    evidence.samples.length < 4 ||
    evidence.samples.length > JOINT_ACTION_PACK.maxSamples ||
    hero.is_folded ||
    hero.is_all_in ||
    hero.is_sitting_out ||
    !state.players.some(
      (p) =>
        p.user_id === hero.user_id &&
        p.seat === hero.seat &&
        p.stack === hero.stack &&
        p.bet === hero.bet &&
        p.totalInvested === hero.totalInvested
    )
  )
    throw new Error('joint_action_canonical_state_unavailable');
  const dealt = validateDealtSeatCensus(state.players, hero.seat, state.dealtSeatIds);
  const behind = new Set(jointPlayersBehind(hero, state));
  const expectedOpponents = evidence.ranges.filter((p) => p.live).map((p) => p.userId);
  if (
    JSON.stringify(evidence.opponentIds) !== JSON.stringify(expectedOpponents) ||
    evidence.opponentIds.some(
      (id) => !state.players.some((p) => p.user_id === id && !p.is_folded)
    ) ||
    state.players.some(
      (p) =>
        !p.is_folded &&
        dealt.includes(p.seat) &&
        p.user_id !== hero.user_id &&
        !evidence.opponentIds.includes(p.user_id)
    )
  )
    throw new Error('joint_action_incomplete_contenders');
  const candidates = buildTournamentActionCandidates({
    hero,
    toCall: Math.min(hero.stack, Math.max(0, state.currentBet - hero.bet)),
    legalActions: state.legalActions,
    minRaiseTo: state.minRaiseTo ?? null,
    maxRaiseTo: state.maxRaiseTo ?? null,
    pot: state.pot,
    currentBet: state.currentBet,
    bettingStructure: state.bettingStructure!,
    baseline,
    settlement: { chipUnit: state.chipUnit! },
  });
  if (!candidates.length || candidates.length > 12)
    throw new Error('joint_action_no_legal_candidates');
  const rows = [];
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
        rakeConfig: state.rakeConfig,
        bbjConfig: state.bbjConfig,
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
      samples: n,
      rollout: JOINT_ACTION_PACK.source,
    });
  }
  return {
    version: JOINT_ACTION_PACK.version,
    playersBehind: [...behind],
    coveringPlayers: state.players
      .filter(
        (p) =>
          p.user_id !== hero.user_id &&
          !p.is_folded &&
          p.stack + p.totalInvested >= hero.stack + hero.totalInvested
      )
      .map((p) => p.user_id),
    candidates: rows,
  };
}
