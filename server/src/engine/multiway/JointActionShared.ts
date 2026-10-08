import type { HorseDecision, SeatPlayer } from '../../types.js';
import type { HorseGameStateV2 } from '../HorseLogic.js';
import { buildTournamentActionCandidates } from '../HorseTournamentUtility.js';
import { horseVariantRulesFor } from '../VariantRules.js';
import { validateDealtSeatCensus } from './DealtSeatCensus.js';
import { jointPreflopFirstSeat } from './JointResponseOrder.js';
import type { JointRangeSamples, JointOpponentRange } from './JointRangeSampler.js';
import { jointStateKey } from './JointRangeSampler.js';
import { prepareJointPots, settleJointScores } from './JointPotDistribution.js';
import { applyJointDeductions } from './JointDeductions.js';
import type { TournamentUtilityShowdownSample } from '../HorseTournamentUtility.js';

/** Shared by the retained round-1 comparison model and the round-2 response
 * tree. Every function here is the round-1 implementation, moved unchanged. */
export type JointActionCandidate = ReturnType<typeof buildTournamentActionCandidates>[number];
export const clamp = (n: number, low = 0, high = 1) => Math.max(low, Math.min(high, n));

/** Actual dealt-seat ring, including sparse seats and a dead button. Folded
 * seats consume position/card occupancy but do not owe another action. */
export function jointPlayersBehind(hero: SeatPlayer, state: HorseGameStateV2): string[] {
  const ids = validateDealtSeatCensus(state.players, hero.seat, state.dealtSeatIds);
  const dealer = state.dealerSeat;
  if (!Number.isInteger(dealer) || dealer! < 1 || dealer! > 10)
    throw new Error('joint_action_missing_button');
  const clockwise = [...ids.filter((s) => s > dealer!), ...ids.filter((s) => s <= dealer!)];
  let first = 0;
  // P13.1: the engine's own preflop order, from the blinds it posted.
  if (state.stage === 'preflop' && !state.bombPot)
    first = clockwise.indexOf(jointPreflopFirstSeat(state, ids));
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

/** A bet, a raise or a full all-in, as the controller records a street's
 * wagers (an all-in that only calls carries no isFullRaise). */
export const isJointWager = (a: { action: string; isFullRaise?: boolean }) =>
  a.action === 'bet' ||
  a.action === 'raise' ||
  (a.action === 'all_in' && a.isFullRaise !== undefined);

/** Deterministic per-sample response draw. Local to the analysis; the
 * baseline strategy's random stream is never read or advanced. */
export function jointResponseDraw(index: number, id: string) {
  let value = (index + 1) ^ 0x7f4a7c15;
  for (const c of id) value = Math.imul(value ^ c.charCodeAt(0), 16777619);
  value ^= value >>> 16;
  value = Math.imul(value, 0x85ebca6b);
  value ^= value >>> 13;
  return (value >>> 0) / 0x100000000;
}

/** Canonical state, contender and candidate checks shared by both models. */
export function prepareJointActionInput(
  hero: SeatPlayer,
  state: HorseGameStateV2,
  baseline: HorseDecision,
  evidence: JointRangeSamples,
  maxSamples: number,
  /** P13.1: maps the built candidates to the exact form the caller executes
   * (HorseLogic.legalize), before any of them is priced by either model. */
  candidateForm?: (candidates: JointActionCandidate[]) => JointActionCandidate[]
): {
  dealt: number[];
  behind: Set<string>;
  candidates: JointActionCandidate[];
} {
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
    evidence.samples.length > maxSamples ||
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
  const built = buildTournamentActionCandidates({
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
  const candidates = candidateForm ? candidateForm(built) : built;
  if (!candidates.length || candidates.length > 12)
    throw new Error('joint_action_no_legal_candidates');
  return { dealt, behind, candidates };
}

/** One terminal branch through the shared pot, score and deduction owners.
 * Conservation is enforced for every terminal branch. */
export function settleJointTerminal(input: {
  hero: SeatPlayer;
  state: HorseGameStateV2;
  seats: SeatPlayer[];
  opponentIds: string[];
  sample: TournamentUtilityShowdownSample;
  dealtPlayers: number;
  sawFlop: boolean;
}) {
  const { hero, state, seats } = input;
  const prepared = prepareJointPots(seats, state.chipUnit!);
  const settled = settleJointScores({
    prepared,
    heroId: hero.user_id,
    opponentIds: input.opponentIds,
    sample: input.sample,
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
    dealtPlayers: input.dealtPlayers,
    sawFlop: input.sawFlop,
  });
  const vector = prepared.seats.map((p) => p.stack + fees.netTotals[p.user_id]);
  const before = state.players.reduce((a, p) => a + p.stack + p.totalInvested, 0);
  const error = Math.abs(vector.reduce((a, b) => a + b, 0) + fees.rake + fees.bbjFee - before);
  if (error > 1e-6) throw new Error('joint_action_conservation');
  return {
    prepared,
    settled,
    fees,
    vector,
    error,
    net: vector[prepared.seats.findIndex((p) => p.user_id === hero.user_id)] - hero.stack,
    boardReturns: settled.boardTotals.map((b) => b[hero.user_id]),
  };
}
