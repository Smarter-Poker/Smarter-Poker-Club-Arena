import type { HorseDecision, SeatPlayer } from '../../types.js';
import type { HorseGameStateV2 } from '../HorseLogic.js';
import type { TournamentUtilityShowdownSample } from '../HorseTournamentUtility.js';
import { calculateContestablePot } from '../PokerEngine.js';
import { horseVariantRulesFor } from '../VariantRules.js';
import type { JointOpponentRange, JointRangeSamples } from './JointRangeSampler.js';
import {
  clamp,
  jointCallProbability,
  jointResponseDraw,
  prepareJointActionInput,
  settleJointTerminal,
} from './JointActionShared.js';
import {
  applyJointAction,
  clampJointAllIn,
  cloneJointStreet,
  jointBettingState,
  jointOneWager,
  nextJointStreet,
  openJointStreet,
  performJointAction,
  type JointStreet,
} from './JointStreetBetting.js';

/**
 * Phase 13 P13-A work limits. They are part of the versioned model, not a
 * runtime adjustment: a responder beyond the raise-branch limit answers with
 * fold, call or a short all-in call only (counted per candidate as
 * raiseLimitedResponders), and a candidate that would need more terminal
 * branches than the limit makes the whole ranking unavailable.
 */
export const JOINT_RESPONSE_LIMITS = Object.freeze({
  raiseStreets: Object.freeze(['turn', 'river'] as const),
  raisesPerTree: 1,
  /** Measured October 6 (shared container, nine-seat NLH river, every
   * responder raise-eligible): every raise branch adds one full settlement
   * per sample; two slots cost 2.7 times round 1, one slot 1.8 times. One
   * slot keeps the tree within two settlements per sample. It goes to the
   * first responder, clockwise from hero, with a positive raise probability
   * and a legal bounded raise. */
  maxRaiseBranchOpponents: 1,
  /** 16 live samples x (1 no-raise path + 1 raise branch). */
  maxTerminalBranchesPerCandidate: 32,
  riverRounds: 1,
});

/** Declared, uncalibrated decision thresholds of the bounded tree. */
export const JOINT_RESPONSE_RULES = Object.freeze({
  maxRaiseShare: 0.6,
  riverBetStrength: 0.31,
  riverCallBase: 0.1,
  riverCallPriceSlope: 0.6,
});

/** The share of an opponent's continuing responses that raise. Present-board
 * strength, the price and the public line only; never a showdown rank. */
export function jointRaiseShare(input: {
  strengths: number[];
  range: JointOpponentRange;
  price: number;
  pot: number;
}) {
  if (!input.strengths.length || input.strengths.some((s) => !Number.isFinite(s) || s < 0 || s > 1))
    throw new Error('joint_action_invalid_strength');
  const mean = input.strengths.reduce((a, b) => a + b, 0) / input.strengths.length;
  const signal = mean * 0.75 + Math.max(...input.strengths) * 0.25;
  const potPrice = input.price / Math.max(input.price, input.pot + input.price);
  return clamp(
    (signal - 0.5) * 1.5 + Math.min(0.1, input.range.raises * 0.03) - potPrice * 0.25,
    0,
    JOINT_RESPONSE_RULES.maxRaiseShare
  );
}

/** A player's strength on the completed river board AS IT THEN EXISTS: its
 * own made-hand category and low qualification there. Used only for the
 * modeled river round, never for a turn decision. */
export function jointRiverStrength(highs: number[], lows: (number | null)[], splitLow: boolean) {
  const reads = highs.map((high, b) =>
    clamp((Math.floor(high / 0x100000) / 8) * 0.85 + (splitLow && lows[b] !== null ? 0.15 : 0))
  );
  const mean = reads.reduce((a, b) => a + b, 0) / reads.length;
  return clamp(mean * 0.75 + Math.max(...reads) * 0.25);
}

/** Hero's heads-up showdown share against one opponent in one sample. */
function headsUpShare(sample: TournamentUtilityShowdownSample, other: number, splitLow: boolean) {
  let total = 0;
  for (const b of sample.boards) {
    const hi = b.heroHigh,
      oh = b.opponentHigh[other];
    const high = hi > oh ? 1 : hi === oh ? 0.5 : 0;
    const hl = splitLow ? b.heroLow : null,
      ol = splitLow ? b.opponentLow[other] : null;
    if (hl === null && ol === null) total += high;
    else {
      const low = ol === null ? 1 : hl === null ? 0 : hl < ol ? 1 : hl === ol ? 0.5 : 0;
      total += high * 0.5 + low * 0.5;
    }
  }
  return total / sample.boards.length;
}

interface Terminal {
  weight: number;
  net: number;
  vector: number[];
  boardReturns: number[];
  rake: number;
  bbj: number;
  heroSole: boolean;
  sidePots: number;
  error: number;
}
interface RaisePoint {
  index: number;
  weight: number;
  raiserId: string;
  order: number;
  seats: SeatPlayer[];
  street: JointStreet;
  wager: NonNullable<ReturnType<typeof jointOneWager>>;
}
export interface JointResponseCount {
  responded: number;
  called: number;
  folded: number;
  allIn: number;
  meanCallProbability: number | null;
  /** Probability-weighted raise frequency (per sample). */
  raiseProbability: number;
  meanRaiseShare: number | null;
  /** Probability mass of branches in which this seat faced the one raise. */
  facedRaise: number;
  calledRaise: number;
}

const cloneSeats = (seats: SeatPlayer[]) => seats.map((p) => ({ ...p }));

/** Fold, check (nothing owed) and call (something owed) are always accepted
 * by the controller for a seat whose turn it is: only a wager needs the
 * structure clamp and the reopening test of performJointAction. */
function passive(street: JointStreet, player: SeatPlayer, action: 'fold' | 'check' | 'call') {
  const owes = street.currentBet - player.bet > 0.005;
  if ((action === 'check' && owes) || (action === 'call' && !owes))
    throw new Error('joint_response_illegal_simulated_action');
  applyJointAction(street, player, action);
}

/**
 * Round-2 bounded joint response tree for a turn or river decision.
 *
 * For every candidate and every joint sample, opponents respond clockwise
 * from hero. Each responder facing a price folds, calls (possibly all in) or
 * makes the ONE bounded legal raise the authoritative menu allows. The raise
 * branch is enumerated with its exact probability weight; fold versus call on
 * the no-raise path keeps round 1's deterministic local draw. After the raise,
 * every seat still owing chips answers once in clockwise order from the
 * raiser (fold or call, all in when the call covers the stack); nobody raises
 * again. Hero answers by a declared rule: call when its heads-up equity
 * against the raiser, weighted by that raiser's raise probability across the
 * same joint samples, covers the pot odds. On the turn, each terminal branch
 * continues into one river round dealt from the SAME physical sample.
 * Every terminal branch settles through prepareJointPots, settleJointScores
 * and applyJointDeductions and must conserve chips.
 */
export function evaluateJointResponseTree(
  hero: SeatPlayer,
  state: HorseGameStateV2,
  baseline: HorseDecision,
  evidence: JointRangeSamples,
  withinBudget: () => boolean,
  pack: { version: string; source: string; maxSamples: number }
) {
  const { dealt, behind, candidates } = prepareJointActionInput(
    hero,
    state,
    baseline,
    evidence,
    pack.maxSamples
  );
  if (!JOINT_RESPONSE_LIMITS.raiseStreets.includes(state.stage as 'turn' | 'river'))
    throw new Error('joint_response_street_not_modeled');
  const splitLow = horseVariantRulesFor(state.gameVariant).splitLow8OrBetter;
  const n = evidence.samples.length;
  const limit = JOINT_RESPONSE_LIMITS.maxTerminalBranchesPerCandidate;
  const rangeOf = new Map(evidence.ranges.map((r) => [r.userId, r]));
  const indexOf = new Map(evidence.opponentIds.map((id, i) => [id, i]));
  const rows = [];
  for (const candidate of candidates) {
    const counts: Record<string, JointResponseCount> = Object.fromEntries(
      evidence.opponentIds.map((id) => [
        id,
        {
          responded: 0,
          called: 0,
          folded: 0,
          allIn: 0,
          meanCallProbability: 0,
          raiseProbability: 0,
          meanRaiseShare: 0,
          facedRaise: 0,
          calledRaise: 0,
        },
      ])
    );
    const terminals: Terminal[][] = evidence.samples.map(() => []);
    const points: RaisePoint[] = [];
    const raiseTo = new Map<string, Set<number>>();
    const raiseFull = new Map<string, boolean>();
    let terminalCount = 0,
      raiseLimitedResponders = 0,
      heroCallsRaise = 0,
      heroFoldsToRaise = 0,
      riverRounds = 0,
      riverBets = 0,
      heroFacedRiverBet = 0;
    const wager = ['bet', 'raise', 'jam'].includes(candidate.kind);

    const strengthsOf = (sample: TournamentUtilityShowdownSample, id: string) =>
      sample.boards.map((b) => b.opponentDecisionStrength[indexOf.get(id)!]);
    const coversHero = (p: SeatPlayer) =>
      p.stack + p.totalInvested >= hero.stack + hero.totalInvested;
    const active = (seats: SeatPlayer[], id: string) =>
      seats.filter((p) => !p.is_folded && p.user_id !== id).length;

    const riverRound = (
      seats: SeatPlayer[],
      turn: JointStreet,
      sample: TournamentUtilityShowdownSample,
      weight: number
    ) => {
      if (state.stage !== 'turn') return;
      const mine = seats.find((p) => p.user_id === hero.user_id)!;
      if (mine.is_folded) return;
      const live = seats.filter((p) => !p.is_folded);
      if (live.length < 2 || live.filter((p) => !p.is_all_in).length < 2) return;
      riverRounds += weight;
      const river = nextJointStreet(turn, 'river', seats);
      const dealer = state.dealerSeat!;
      const ring = [
        ...seats.filter((p) => p.seat > dealer).sort((a, b) => a.seat - b.seat),
        ...seats.filter((p) => p.seat <= dealer).sort((a, b) => a.seat - b.seat),
      ];
      const strength = (p: SeatPlayer) => {
        if (p.user_id === hero.user_id)
          return jointRiverStrength(
            sample.boards.map((b) => b.heroHigh),
            sample.boards.map((b) => b.heroLow),
            splitLow
          );
        const i = indexOf.get(p.user_id)!;
        return jointRiverStrength(
          sample.boards.map((b) => b.opponentHigh[i]),
          sample.boards.map((b) => b.opponentLow[i]),
          splitLow
        );
      };
      let bettor = -1;
      for (let k = 0; k < ring.length && bettor < 0; k++) {
        const p = ring[k];
        if (p.is_folded || p.is_all_in) continue;
        if (strength(p) < JOINT_RESPONSE_RULES.riverBetStrength) {
          passive(river, p, 'check');
          continue;
        }
        const bet = jointOneWager(river, p);
        if (!bet) {
          passive(river, p, 'check');
          continue;
        }
        performJointAction(river, p, bet.action, bet.amount);
        bettor = k;
      }
      if (bettor < 0) return;
      riverBets += weight;
      const answer = [...ring.slice(bettor + 1), ...ring.slice(0, bettor)];
      for (const p of answer) {
        if (p.is_folded || p.is_all_in) continue;
        const owe = Math.min(p.stack, river.currentBet - p.bet);
        if (owe <= 0) continue;
        if (p.user_id === hero.user_id) heroFacedRiverBet += weight;
        const pot = calculateContestablePot(seats, p.user_id, owe);
        const price = owe / Math.max(owe, pot + owe);
        const call =
          strength(p) >=
          JOINT_RESPONSE_RULES.riverCallBase + JOINT_RESPONSE_RULES.riverCallPriceSlope * price;
        passive(river, p, call ? 'call' : 'fold');
      }
    };

    const settle = (
      index: number,
      seats: SeatPlayer[],
      street: JointStreet,
      weight: number
    ): boolean => {
      if (!withinBudget()) return false;
      if (++terminalCount > limit) throw new Error('joint_response_branch_unavailable');
      const sample = evidence.samples[index];
      riverRound(seats, street, sample, weight);
      const t = settleJointTerminal({
        hero,
        state,
        seats,
        opponentIds: evidence.opponentIds,
        sample,
        dealtPlayers: dealt.length,
        sawFlop: true,
      });
      const live = seats.filter((p) => !p.is_folded);
      terminals[index].push({
        weight,
        net: t.net,
        vector: t.vector,
        boardReturns: t.boardReturns,
        rake: t.fees.rake,
        bbj: t.fees.bbjFee,
        heroSole: live.length === 1 && live[0].user_id === hero.user_id,
        sidePots: t.prepared.pots.length,
        error: t.error,
      });
      return true;
    };

    // Pass A: the no-raise path of every sample, recording each raise point.
    for (let index = 0; index < n; index++) {
      if (!withinBudget()) return null;
      const sample = evidence.samples[index];
      const seats = state.players.map((p) => ({ ...p, cards: [] }));
      const street = openJointStreet(state);
      const mine = seats.find((p) => p.user_id === hero.user_id)!;
      if (candidate.kind === 'jam') {
        const clamped = clampJointAllIn(street, mine, jointBettingState(street, mine));
        applyJointAction(street, mine, clamped.action, clamped.amount);
      } else applyJointAction(street, mine, candidate.action, candidate.amount ?? undefined);
      const order = [
        ...seats.filter((p) => p.seat > hero.seat).sort((a, b) => a.seat - b.seat),
        ...seats.filter((p) => p.seat < hero.seat).sort((a, b) => a.seat - b.seat),
      ];
      let prefix = 1,
        raiseBranches = 0;
      for (let k = 0; k < order.length; k++) {
        const opponent = order[k];
        if (opponent.is_folded) continue;
        const entry = counts[opponent.user_id];
        if (opponent.is_all_in) {
          if (entry) entry.allIn++;
          continue;
        }
        if (!(wager || behind.has(opponent.user_id))) continue;
        const price = Math.min(opponent.stack, Math.max(0, street.currentBet - opponent.bet));
        if (price <= 0) continue;
        const range = rangeOf.get(opponent.user_id)!;
        const strengths = strengthsOf(sample, opponent.user_id);
        const pot = calculateContestablePot(seats, opponent.user_id, price);
        const probability = jointCallProbability({
          strengths,
          range,
          price,
          pot,
          activeOpponents: active(seats, opponent.user_id),
          coversHero: coversHero(opponent),
        });
        // Raise slots go, in response order, to the first responders with a
        // positive raise probability AND a legal bounded raise. The menu and
        // builder are consulted only for those (they are the costly part).
        let raise = 0;
        let option: ReturnType<typeof jointOneWager> = null;
        const share = jointRaiseShare({ strengths, range, price, pot });
        entry.meanRaiseShare! += share;
        // A folded hero's result cannot depend on a later raise.
        if (share > 0 && probability > 0 && !mine.is_folded) {
          if (raiseBranches < JOINT_RESPONSE_LIMITS.maxRaiseBranchOpponents) {
            option = jointOneWager(street, opponent);
            if (option) {
              raiseBranches++;
              raise = probability * share;
            }
          } else raiseLimitedResponders++;
        }
        if (raise > 0)
          points.push({
            index,
            weight: prefix * raise,
            raiserId: opponent.user_id,
            order: k,
            seats: cloneSeats(seats),
            street: cloneJointStreet(street),
            wager: option!,
          });
        entry.responded++;
        entry.meanCallProbability! += probability;
        entry.raiseProbability += prefix * raise;
        prefix *= 1 - raise;
        const callGivenNoRaise = raise < 1 ? (probability - raise) / (1 - raise) : 0;
        if (jointResponseDraw(index, opponent.user_id) < callGivenNoRaise) {
          passive(street, opponent, 'call');
          entry.called++;
          if (opponent.is_all_in) entry.allIn++;
        } else {
          passive(street, opponent, 'fold');
          entry.folded++;
        }
      }
      if (!settle(index, seats, street, prefix)) return null;
    }

    // Hero's answer to each raiser: one decision shared by every sample,
    // from that raiser's raise-weighted heads-up equity over the same joint
    // samples. A single sample's own runout never decides its own branch.
    const equity = new Map<string, number>();
    for (const id of new Set(points.map((p) => p.raiserId))) {
      let mass = 0,
        share = 0;
      for (const p of points)
        if (p.raiserId === id) {
          mass += p.weight;
          share += p.weight * headsUpShare(evidence.samples[p.index], indexOf.get(id)!, splitLow);
        }
      equity.set(id, share / mass);
    }

    // Pass B: every raise branch, with its exact probability weight.
    for (const point of points) {
      if (!withinBudget()) return null;
      const sample = evidence.samples[point.index];
      const seats = cloneSeats(point.seats);
      const street = cloneJointStreet(point.street);
      const mine = seats.find((p) => p.user_id === hero.user_id)!;
      const raiser = seats.find((p) => p.user_id === point.raiserId)!;
      performJointAction(street, raiser, point.wager.action, point.wager.amount);
      const targets = raiseTo.get(point.raiserId) ?? new Set<number>();
      targets.add(street.currentBet);
      raiseTo.set(point.raiserId, targets);
      raiseFull.set(point.raiserId, street.history.at(-1)!.isFullRaise === true);
      const order = [
        ...seats.filter((p) => p.seat > hero.seat).sort((a, b) => a.seat - b.seat),
        ...seats.filter((p) => p.seat < hero.seat).sort((a, b) => a.seat - b.seat),
      ];
      const k = order.findIndex((p) => p.user_id === point.raiserId);
      for (const p of [...order.slice(k + 1), mine, ...order.slice(0, k)]) {
        if (p.is_folded || p.is_all_in) continue;
        const owe = Math.min(p.stack, Math.max(0, street.currentBet - p.bet));
        if (owe <= 0) continue;
        const pot = calculateContestablePot(seats, p.user_id, owe);
        if (p.user_id === hero.user_id) {
          const call = equity.get(point.raiserId)! >= owe / Math.max(owe, pot + owe);
          if (call) heroCallsRaise += point.weight;
          else heroFoldsToRaise += point.weight;
          passive(street, p, call ? 'call' : 'fold');
          continue;
        }
        const entry = counts[p.user_id];
        const probability = jointCallProbability({
          strengths: strengthsOf(sample, p.user_id),
          range: rangeOf.get(p.user_id)!,
          price: owe,
          pot,
          activeOpponents: active(seats, p.user_id),
          coversHero: coversHero(p),
        });
        entry.facedRaise += point.weight;
        if (jointResponseDraw(point.index, p.user_id + '|raise') < probability) {
          passive(street, p, 'call');
          entry.calledRaise += point.weight;
        } else passive(street, p, 'fold');
      }
      if (!settle(point.index, seats, street, point.weight)) return null;
    }

    // Weighted accounting. Within one sample the branch weights sum to one.
    const sampleMeans = terminals.map((list) => {
      const mass = list.reduce((a, t) => a + t.weight, 0);
      if (Math.abs(mass - 1) > 1e-9) throw new Error('joint_response_branch_mass');
      return list.reduce((a, t) => a + t.weight * t.net, 0);
    });
    const all = terminals.flat();
    const mean = sampleMeans.reduce((a, b) => a + b, 0) / n;
    const spread = sampleMeans.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1);
    const variance = all.reduce((a, t) => a + t.weight * (t.net - mean) ** 2, 0) / (n - 1);
    const boards = all[0].boardReturns.length;
    const means = Array.from(
      { length: boards },
      (_, b) => all.reduce((a, t) => a + t.weight * t.boardReturns[b], 0) / n
    );
    const reachable = all.filter((t) => t.weight > 0);
    rows.push({
      id: candidate.id,
      action: candidate.action,
      amount: candidate.amount,
      investment: candidate.investment,
      expectedNetChips: mean,
      standardError: Math.sqrt(spread / n),
      variance,
      minimumNetChips: Math.min(...reachable.map((t) => t.net)),
      maximumNetChips: Math.max(...reachable.map((t) => t.net)),
      boardMeans: means,
      covariance: means.map((ma, a) =>
        means.map(
          (mb, b) =>
            all.reduce(
              (sum, t) => sum + t.weight * (t.boardReturns[a] - ma) * (t.boardReturns[b] - mb),
              0
            ) /
            (n - 1)
        )
      ),
      allFoldProbability: wager ? all.reduce((a, t) => a + (t.heroSole ? t.weight : 0), 0) / n : 0,
      expectedRake: all.reduce((a, t) => a + t.weight * t.rake, 0) / n,
      expectedBbj: all.reduce((a, t) => a + t.weight * t.bbj, 0) / n,
      sidePotCount: Math.max(...all.map((t) => t.sidePots)),
      maxConservationError: Math.max(...all.map((t) => t.error)),
      resultingStackVectors: new Set(
        reachable.map((t) => t.vector.map((v) => v.toFixed(2)).join(':'))
      ).size,
      responseCounts: Object.fromEntries(
        Object.entries(counts).map(([id, v]) => [
          id,
          {
            ...v,
            meanCallProbability: v.responded ? v.meanCallProbability! / v.responded : null,
            meanRaiseShare: v.responded ? v.meanRaiseShare! / v.responded : null,
            raiseProbability: v.raiseProbability / n,
            facedRaise: v.facedRaise / n,
            calledRaise: v.calledRaise / n,
          },
        ])
      ),
      responseTree: {
        street: state.stage as 'turn' | 'river',
        terminalBranches: terminalCount,
        raiseBranches: points.length,
        raiseProbability: points.reduce((a, p) => a + p.weight, 0) / n,
        heroCallsRaiseProbability: heroCallsRaise / n,
        heroFoldsToRaiseProbability: heroFoldsToRaise / n,
        heroRaiseEquity: Object.fromEntries(equity),
        raiseTo: Object.fromEntries(
          [...raiseTo].map(([id, set]) => [id, [...set].sort((a, b) => a - b)])
        ),
        raiseIsFull: Object.fromEntries(raiseFull),
        raiseLimitedResponders,
        riverRoundProbability: state.stage === 'turn' ? riverRounds / n : null,
        riverBetProbability: state.stage === 'turn' ? riverBets / n : null,
        heroFacedRiverBetProbability: state.stage === 'turn' ? heroFacedRiverBet / n : null,
      },
      samples: n,
      rollout: pack.source,
    });
  }
  return { playersBehind: [...behind], candidates: rows };
}
