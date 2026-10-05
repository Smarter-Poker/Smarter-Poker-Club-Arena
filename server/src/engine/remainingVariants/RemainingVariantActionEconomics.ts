import type { ActionRecord, ActionType, HandConfig, RakeConfig, SeatPlayer } from '../../types.js';
import type { HorseEquityOutcomeSample } from '../HorseEval.js';
import { fixedLimitStreetBounds } from '../BettingStructure.js';
import { prepareJointPots, settleJointScores } from '../multiway/JointPotDistribution.js';
import { applyJointDeductions } from '../multiway/JointDeductions.js';
import { REMAINING_VARIANT_PACKS } from './RemainingVariantPolicyPack.js';

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * P12.1 - THE EXPLICIT NET-ACTION INTERFACE (FLH / FLO8 RIVER)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * P12-B's smallest calculation slice: ONE explicit per-action economic result
 * for the fixed-limit river call/completion node, with game-specific terminal
 * scoring and CANONICAL wager bounds.
 *
 * Why it exists. The live wrapper prices a call as `callCost / netPot` against
 * a sampled pot SHARE. A pot share is not a net chip result: it cannot see
 * individual pot eligibility, the uncalled-bet refund, the BBJ fee, whole-unit
 * rounding, or an FLO8 quarter. This module answers the different question -
 * how many chips does each legal action actually return - by running the SAME
 * terminal showdowns the policy already sampled through the platform's own
 * settlement owners.
 *
 * What it is NOT.
 *  - Not a legality source. `minRaiseTo` from the baseline controller is the
 *    authority; a raise-to derived here is REFUSED unless it matches that
 *    bound exactly. No estimate in this file can legalize a forbidden raise.
 *  - Not a calibrated strategy. The terminal samples carry the live sampler's
 *    uncalibrated public-line prior, and the wager branch is BRACKETED by two
 *    declared opponent response assumptions rather than a response model.
 *  - Not a settlement reimplementation. `prepareJointPots` builds the refunds
 *    and pot eligibility, `settleJointScores` scores high and low, and
 *    `applyJointDeductions` charges rake and the BBJ fee. None of that
 *    arithmetic is copied here, and nothing in this module performs I/O,
 *    reads a private card, touches controller state or moves a chip.
 *
 * Every refusal has its own name. An unavailable result is never an empty one.
 */

export const REMAINING_VARIANT_ACTION_ECONOMICS_VERSION = 'remaining-variant-action-economics-v1';

/** The fixed-limit variants this slice prices. Short Deck and Pineapple are
 * no-limit and outside it; they are refused by name, never priced anyway. */
export type RemainingVariantEconomicVariant = 'flh' | 'flo8';

/**
 * The declared opponent response priced for one candidate.
 *
 * `terminal_showdown` - no further wagering: the current contesting roster
 * reaches showdown with the chips this candidate puts in.
 * `all_contesting_opponents_call` / `all_contesting_opponents_fold` - the two
 * bracketing assumptions for a wager. The real value lies between them, and
 * this module does not claim to know where.
 */
export type RemainingVariantEconomicResponse =
  | 'terminal_showdown'
  | 'all_contesting_opponents_call'
  | 'all_contesting_opponents_fold';

export interface RemainingVariantActionValue {
  /** `raise` denotes the street's single canonical wager, bet or raise. */
  action: 'fold' | 'call' | 'raise';
  response: RemainingVariantEconomicResponse;
  /** Absolute wager-to level for a wager, the exact call cost for a call,
   * null for fold. */
  amount: number | null;
  /** Chips hero commits on top of `hero.bet` to take this line. */
  committed: number;
  /** Mean change in hero's STACK against taking no further part: awards after
   * refunds, rake and the BBJ fee, less the chips committed. Chips already
   * invested are sunk and no line recovers them, so fold is exactly zero. */
  netChips: number;
  worstNetChips: number;
  bestNetChips: number;
  /** Mean rake and BBJ fee charged on the settled pot for this line. */
  rake: number;
  bbjFee: number;
  /** Mean uncalled-bet refund returned to hero before fees. */
  refund: number;
  /** Terminal samples actually consumed for this line. */
  samples: number;
}

export interface RemainingVariantActionEconomics {
  version: typeof REMAINING_VARIANT_ACTION_ECONOMICS_VERSION;
  variant: RemainingVariantEconomicVariant;
  street: 'river';
  /** Terminal scoring actually applied, taken from the pack and never from
   * the caller: FLO8 splits, FLH does not. */
  scoring: 'high_only' | 'high_low_split';
  /** The canonical fixed-limit bounds this node was priced on, null when no
   * bound was read. `completion` marks a short level completed to the full
   * street bet (WSOP 2026 rule 133, through `fixedLimitStreetBounds`). */
  wagerBounds: {
    betSize: number;
    raiseSize: number;
    raiseTo: number;
    wagers: number;
    completion: boolean;
    capped: boolean;
  } | null;
  chipUnit: 0.01 | 1;
  /** Terminal showdowns the caller offered. */
  offeredSamples: number;
  /** Size of the contesting roster priced, in the samples' own index order. */
  contestingOpponents: number;
  values: RemainingVariantActionValue[];
  /** The listed value with the greatest `netChips`, null when none was priced. */
  best: { action: 'fold' | 'call' | 'raise'; response: RemainingVariantEconomicResponse } | null;
  /** Null exactly when `values` is non-empty. Named, never silent. */
  unavailable: string | null;
  budgetExhausted: boolean;
  analysisMs: number;
}

export interface RemainingVariantActionEconomicsInput {
  variant: string;
  stage: string;
  hero: SeatPlayer;
  /** The dealt census with private cards already stripped. */
  players: SeatPlayer[];
  /** The contesting roster, in the same index order as the samples' opponent
   * arrays. A mismatch against the non-folded seats is refused, not guessed:
   * scoring positional arrays against another roster scores the wrong seats. */
  opponentIds: string[];
  samples: HorseEquityOutcomeSample[];
  currentBet: number;
  /** The street's canonical fixed bet, from the controller. */
  betSize: number;
  actionHistory: ActionRecord[];
  legalActions: ActionType[];
  wagersCapped: boolean;
  /** The controller's absolute bounds. These own legality. */
  minRaiseTo: number | null;
  maxRaiseTo: number | null;
  chipUnit: 0.01 | 1;
  asset: 'chips' | 'diamonds';
  gameMode: 'cash' | 'tournament';
  bigBlind: number;
  dealerSeat: number;
  rakeConfig: RakeConfig;
  bbjConfig: HandConfig['bbjConfig'] | null;
  /** False stops further work. A line short of `MIN_TERMINAL_SAMPLES` is
   * reported unavailable rather than averaged over whatever finished. */
  withinBudget?: () => boolean;
  now?: () => number;
}

/** Fewer terminal showdowns than the live sampler's own floor is not a net
 * economic result. Below this a line is refused by name. */
export const MIN_TERMINAL_SAMPLES = 4;

const ECONOMIC_VARIANTS = new Set<string>(['flh', 'flo8']);
const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
const round = (n: number) => Math.round(n * 1e6) / 1e6;

export function isRemainingVariantEconomicVariant(
  value: unknown
): value is RemainingVariantEconomicVariant {
  return typeof value === 'string' && ECONOMIC_VARIANTS.has(value);
}

/**
 * Price every legal candidate at an FLH/FLO8 river node in net chips.
 *
 * Never throws. A malformed input, an unreconcilable bound, a settlement the
 * platform's owners refuse, or an exhausted budget each return a named
 * `unavailable` with no values.
 */
export function remainingVariantActionEconomics(
  input: RemainingVariantActionEconomicsInput
): RemainingVariantActionEconomics {
  const now = input.now ?? (() => performance.now());
  const start = now();
  const withinBudget = input.withinBudget ?? (() => true);
  const variant = isRemainingVariantEconomicVariant(input.variant) ? input.variant : null;
  const pack = variant ? REMAINING_VARIANT_PACKS[variant] : null;
  const result: RemainingVariantActionEconomics = {
    version: REMAINING_VARIANT_ACTION_ECONOMICS_VERSION,
    variant: variant ?? 'flh',
    street: 'river',
    scoring: pack?.splitLow ? 'high_low_split' : 'high_only',
    wagerBounds: null,
    chipUnit: input.chipUnit === 1 ? 1 : 0.01,
    offeredSamples: Array.isArray(input.samples) ? input.samples.length : 0,
    contestingOpponents: Array.isArray(input.opponentIds) ? input.opponentIds.length : 0,
    values: [],
    best: null,
    unavailable: 'not_evaluated',
    budgetExhausted: false,
    analysisMs: 0,
  };
  const refuse = (reason: string) => {
    result.values = [];
    result.best = null;
    result.unavailable = reason;
    result.analysisMs = Math.max(0, now() - start);
    return result;
  };
  // Refuse before INSPECTING anything when the caller's budget is already
  // gone. A partial comparison is not a comparison: pricing only the lines
  // that fit would leave `fold` alone at zero and read as a recommendation.
  if (!withinBudget()) {
    result.budgetExhausted = true;
    return refuse('work_budget_unavailable');
  }
  if (!variant || !pack) return refuse('variant_outside_net_action_slice');
  if (input.stage !== 'river') return refuse('street_outside_net_action_slice');
  if (input.chipUnit !== 0.01 && input.chipUnit !== 1) return refuse('chip_unit_unavailable');
  const hero = input.hero;
  const samples = Array.isArray(input.samples) ? input.samples : [];
  // Named before the canonical-input sweep, so a node with no retained
  // showdowns reads as what it is rather than as a malformed roster.
  if (samples.length < MIN_TERMINAL_SAMPLES) return refuse('terminal_samples_unavailable');
  if (
    !hero?.user_id ||
    !Array.isArray(input.players) ||
    input.players.length < 2 ||
    input.players.length > 10 ||
    !input.players.some((p) => p.user_id === hero.user_id) ||
    !Array.isArray(input.opponentIds) ||
    !input.opponentIds.length ||
    new Set(input.opponentIds).size !== input.opponentIds.length ||
    input.opponentIds.includes(hero.user_id) ||
    !Number.isInteger(input.dealerSeat) ||
    input.dealerSeat < 1 ||
    input.dealerSeat > 10 ||
    !finite(input.bigBlind) ||
    input.bigBlind <= 0 ||
    !finite(input.currentBet) ||
    input.currentBet < 0 ||
    !finite(input.betSize) ||
    input.betSize <= 0 ||
    !finite(hero.stack) ||
    hero.stack < 0 ||
    !finite(hero.bet) ||
    hero.bet < 0 ||
    !Array.isArray(input.legalActions) ||
    !Array.isArray(input.actionHistory) ||
    (input.gameMode !== 'cash' && input.gameMode !== 'tournament') ||
    (input.asset !== 'chips' && input.asset !== 'diamonds')
  )
    return refuse('canonical_input_unavailable');
  const contesting = input.players
    .filter((p) => p.user_id !== hero.user_id && !p.is_folded)
    .map((p) => p.user_id);
  if (
    contesting.length !== input.opponentIds.length ||
    contesting.some((id) => !input.opponentIds.includes(id))
  )
    return refuse('contesting_roster_mismatch');
  if (
    samples.some(
      (sample) =>
        !sample ||
        !Number.isSafeInteger(sample.heroHigh) ||
        sample.heroHigh < 0 ||
        !Array.isArray(sample.opponentHigh) ||
        sample.opponentHigh.length !== input.opponentIds.length ||
        sample.opponentHigh.some((n) => !Number.isSafeInteger(n) || n < 0) ||
        !Array.isArray(sample.opponentLow) ||
        sample.opponentLow.length !== input.opponentIds.length ||
        (sample.heroLow !== null &&
          (!Number.isSafeInteger(sample.heroLow) || sample.heroLow < 0)) ||
        sample.opponentLow.some((n) => n !== null && (!Number.isSafeInteger(n) || n < 0)) ||
        // Only a split game may carry a qualifying low.
        (!pack.splitLow && (sample.heroLow !== null || sample.opponentLow.some((n) => n !== null)))
    )
  )
    return refuse('terminal_samples_rejected');

  const callCost = Math.min(hero.stack, Math.max(0, input.currentBet - hero.bet));
  // CANONICAL BOUNDS. The wager-to is derived from this street's actual raise
  // levels and then checked against the controller's own `minRaiseTo`. A
  // fixed-limit street offers exactly one wager size, so an inexact match is a
  // disagreement about legality and the controller wins it.
  const bounds = fixedLimitStreetBounds(
    input.actionHistory,
    'river',
    input.betSize,
    input.currentBet
  );
  const wagerAction: ActionType = input.currentBet > 0 ? 'raise' : 'bet';
  const raiseTo = round(input.currentBet + bounds.raiseSize);
  const wagerOffered = input.legalActions.includes(wagerAction) && !input.wagersCapped;
  const boundsAgree =
    wagerOffered &&
    finite(input.minRaiseTo) &&
    finite(input.maxRaiseTo) &&
    Math.abs((input.minRaiseTo as number) - raiseTo) <= 0.005 &&
    Math.abs((input.maxRaiseTo as number) - raiseTo) <= 0.005 &&
    raiseTo > input.currentBet &&
    raiseTo - hero.bet <= hero.stack + 0.005;
  result.wagerBounds = {
    betSize: round(input.betSize),
    raiseSize: bounds.raiseSize,
    raiseTo,
    wagers: bounds.wagers,
    completion: bounds.raiseSize + 0.005 < input.betSize,
    capped: input.wagersCapped || !input.legalActions.includes(wagerAction),
  };
  if (wagerOffered && !boundsAgree) return refuse('wager_bounds_unavailable');

  const heroIndex = input.players.findIndex((p) => p.user_id === hero.user_id);
  const unit = input.chipUnit;
  // Whole units, then back to an amount the same way `prepareJointPots`
  // does it, so 230 cents is 2.3 exactly and no drift reaches its validator.
  const whole = (n: number) => (unit === 1 ? Math.round(n) : Math.round(n * 100) / 100);

  /** Hypothetical seats after hero commits `committed` and, when the line
   * assumes a call, every contesting opponent who can still act matches
   * `level`. A short opponent goes all in for less and hero's excess comes
   * back through `prepareJointPots`, exactly as at settlement. */
  const seatsFor = (committed: number, level: number | null): SeatPlayer[] =>
    input.players.map((p, index) => {
      if (index === heroIndex)
        return {
          ...p,
          cards: [],
          stack: whole(p.stack - committed),
          bet: whole(p.bet + committed),
          totalInvested: whole(p.totalInvested + committed),
        };
      if (level === null || p.is_folded || p.is_all_in || !input.opponentIds.includes(p.user_id))
        return { ...p, cards: [] };
      const add = Math.min(p.stack, Math.max(0, level - p.bet));
      return {
        ...p,
        cards: [],
        stack: whole(p.stack - add),
        bet: whole(p.bet + add),
        totalInvested: whole(p.totalInvested + add),
      };
    });

  const deduct = (settlement: ReturnType<typeof settleJointScores>) =>
    applyJointDeductions({
      settlement,
      rakeConfig: input.rakeConfig,
      bbjConfig: input.bbjConfig,
      asset: input.asset,
      gameMode: input.gameMode,
      bigBlind: input.bigBlind,
      dealtPlayers: input.players.length,
      // A river node has already seen the flop, so `noFlopNoDrop` cannot
      // apply here. This is a fact about the node, not a strategy choice.
      sawFlop: true,
    });

  /** One line, averaged over the offered terminal showdowns. Returns a named
   * reason string instead of a value when an owner refuses it. */
  const price = (
    action: 'call' | 'raise',
    response: RemainingVariantEconomicResponse,
    committed: number,
    level: number | null,
    amount: number | null
  ): RemainingVariantActionValue | string => {
    let prepared: ReturnType<typeof prepareJointPots>;
    try {
      prepared = prepareJointPots(seatsFor(committed, level), unit);
    } catch {
      return 'hypothetical_pots_unavailable';
    }
    const refund = prepared.refunds[hero.user_id] ?? 0;
    const nets: number[] = [];
    let rake = 0,
      bbjFee = 0;
    for (const sample of samples) {
      if (!withinBudget()) {
        result.budgetExhausted = true;
        break;
      }
      try {
        const deducted = deduct(
          settleJointScores({
            prepared,
            heroId: hero.user_id,
            opponentIds: input.opponentIds,
            sample: { boards: [sample] },
            splitLow: pack.splitLow,
            dealerSeat: input.dealerSeat,
          })
        );
        rake += deducted.rake;
        bbjFee += deducted.bbjFee;
        nets.push((deducted.netTotals[hero.user_id] ?? 0) + refund - committed);
      } catch {
        return 'terminal_settlement_unavailable';
      }
    }
    if (nets.length < MIN_TERMINAL_SAMPLES) return 'work_budget_unavailable';
    const mean = nets.reduce((a, b) => a + b, 0) / nets.length;
    return {
      action,
      response,
      amount: amount === null ? null : round(amount),
      committed: round(committed),
      netChips: round(mean),
      worstNetChips: round(Math.min(...nets)),
      bestNetChips: round(Math.max(...nets)),
      rake: round(rake / nets.length),
      bbjFee: round(bbjFee / nets.length),
      refund: round(refund),
      samples: nets.length,
    };
  };

  /** Hero wagers and every contesting opponent folds. Only hero remains
   * eligible, so the same settlement owners score a single contender and
   * hero's uncalled wager returns as a refund rather than as an award. */
  const priceUncontested = (
    committed: number,
    level: number
  ): RemainingVariantActionValue | string => {
    const seats = input.players.map((p, index) =>
      index === heroIndex
        ? {
            ...p,
            cards: [],
            stack: whole(p.stack - committed),
            bet: whole(p.bet + committed),
            totalInvested: whole(p.totalInvested + committed),
          }
        : { ...p, cards: [], is_folded: true }
    );
    let prepared: ReturnType<typeof prepareJointPots>;
    try {
      prepared = prepareJointPots(seats, unit);
    } catch {
      return 'hypothetical_pots_unavailable';
    }
    const refund = prepared.refunds[hero.user_id] ?? 0;
    if (!withinBudget()) {
      result.budgetExhausted = true;
      return 'work_budget_unavailable';
    }
    try {
      const deducted = deduct(
        settleJointScores({
          prepared,
          heroId: hero.user_id,
          opponentIds: [],
          sample: {
            boards: [
              {
                heroHigh: 1,
                heroLow: null,
                opponentHigh: [],
                opponentLow: [],
                opponentDecisionStrength: [],
              },
            ],
          },
          splitLow: false,
          dealerSeat: input.dealerSeat,
        })
      );
      const net = (deducted.netTotals[hero.user_id] ?? 0) + refund - committed;
      return {
        action: 'raise',
        response: 'all_contesting_opponents_fold',
        amount: round(level),
        committed: round(committed),
        netChips: round(net),
        worstNetChips: round(net),
        bestNetChips: round(net),
        rake: round(deducted.rake),
        bbjFee: round(deducted.bbjFee),
        refund: round(refund),
        samples: samples.length,
      };
    } catch {
      return 'terminal_settlement_unavailable';
    }
  };

  const values: RemainingVariantActionValue[] = [];
  if (input.legalActions.includes('fold') && callCost > 0)
    values.push({
      action: 'fold',
      response: 'terminal_showdown',
      amount: null,
      committed: 0,
      netChips: 0,
      worstNetChips: 0,
      bestNetChips: 0,
      rake: 0,
      bbjFee: 0,
      refund: 0,
      samples: samples.length,
    });
  if (callCost > 0 && input.legalActions.includes('call')) {
    const priced = price('call', 'terminal_showdown', callCost, input.currentBet, callCost);
    if (typeof priced === 'string') return refuse(priced);
    values.push(priced);
  }
  if (boundsAgree) {
    const committed = round(raiseTo - hero.bet);
    const called = price('raise', 'all_contesting_opponents_call', committed, raiseTo, raiseTo);
    if (typeof called === 'string') return refuse(called);
    values.push(called);
    const folded = priceUncontested(committed, raiseTo);
    if (typeof folded === 'string') return refuse(folded);
    values.push(folded);
  }
  if (!values.length) return refuse('no_legal_candidate_priced');
  const top = values.reduce((a, b) => (b.netChips > a.netChips ? b : a));
  result.values = values;
  result.best = { action: top.action, response: top.response };
  result.unavailable = null;
  result.analysisMs = Math.max(0, now() - start);
  return result;
}

const RESPONSES = new Set<string>([
  'terminal_showdown',
  'all_contesting_opponents_call',
  'all_contesting_opponents_fold',
]);
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const ECONOMICS_KEYS =
  'analysisMs,best,budgetExhausted,chipUnit,contestingOpponents,offeredSamples,scoring,street,unavailable,values,variant,version,wagerBounds';
const BOUND_KEYS = 'betSize,capped,completion,raiseSize,raiseTo,wagers';
const VALUE_KEYS =
  'action,amount,bbjFee,bestNetChips,committed,netChips,rake,refund,response,samples,worstNetChips';

/**
 * The receipt's own consistency, checked against THIS running module rather
 * than trusted because something upstream produced it.
 *
 * This is the comparison P10.1 shipped twice without: a receipt carried into
 * the live decision path that nothing verifies. It pins the version string,
 * the exact key sets, the unavailable/values exclusive-or, the `best` argmax,
 * the fold identity, and the agreement between every priced wager and the
 * canonical bound the receipt declares.
 */
export function remainingVariantActionEconomicsIsValid(value: unknown): boolean {
  if (!object(value)) return false;
  if (Object.keys(value).sort().join(',') !== ECONOMICS_KEYS) return false;
  if (
    value.version !== REMAINING_VARIANT_ACTION_ECONOMICS_VERSION ||
    !isRemainingVariantEconomicVariant(value.variant) ||
    value.street !== 'river' ||
    value.scoring !==
      (REMAINING_VARIANT_PACKS[value.variant].splitLow ? 'high_low_split' : 'high_only') ||
    (value.chipUnit !== 0.01 && value.chipUnit !== 1) ||
    !Number.isSafeInteger(value.offeredSamples) ||
    (value.offeredSamples as number) < 0 ||
    !Number.isSafeInteger(value.contestingOpponents) ||
    (value.contestingOpponents as number) < 0 ||
    (value.contestingOpponents as number) > 9 ||
    typeof value.budgetExhausted !== 'boolean' ||
    !finite(value.analysisMs) ||
    (value.analysisMs as number) < 0 ||
    !Array.isArray(value.values) ||
    (value.unavailable !== null && typeof value.unavailable !== 'string') ||
    (typeof value.unavailable === 'string' && !/^[a-z][a-z0-9_]{0,63}$/.test(value.unavailable))
  )
    return false;
  // A named refusal carries no value, and a result names no refusal.
  if ((value.unavailable === null) !== value.values.length > 0) return false;
  const wager = value.wagerBounds;
  if (wager !== null) {
    if (!object(wager) || Object.keys(wager).sort().join(',') !== BOUND_KEYS) return false;
    if (
      !finite(wager.betSize) ||
      (wager.betSize as number) <= 0 ||
      !finite(wager.raiseSize) ||
      (wager.raiseSize as number) <= 0 ||
      (wager.raiseSize as number) > (wager.betSize as number) + 0.005 ||
      !finite(wager.raiseTo) ||
      (wager.raiseTo as number) <= 0 ||
      !Number.isSafeInteger(wager.wagers) ||
      (wager.wagers as number) < 0 ||
      (wager.wagers as number) > 4 ||
      typeof wager.capped !== 'boolean' ||
      wager.completion !== (wager.raiseSize as number) + 0.005 < (wager.betSize as number)
    )
      return false;
  }
  if (!value.values.length) return value.best === null;
  const seen = new Set<string>();
  for (const row of value.values as unknown[]) {
    if (
      !object(row) ||
      Object.keys(row).sort().join(',') !== VALUE_KEYS ||
      !['fold', 'call', 'raise'].includes(row.action as string) ||
      !RESPONSES.has(row.response as string) ||
      !finite(row.committed) ||
      (row.committed as number) < 0 ||
      !finite(row.netChips) ||
      !finite(row.worstNetChips) ||
      !finite(row.bestNetChips) ||
      (row.worstNetChips as number) > (row.netChips as number) + 1e-6 ||
      (row.bestNetChips as number) < (row.netChips as number) - 1e-6 ||
      !finite(row.rake) ||
      (row.rake as number) < 0 ||
      !finite(row.bbjFee) ||
      (row.bbjFee as number) < 0 ||
      !finite(row.refund) ||
      (row.refund as number) < 0 ||
      !Number.isSafeInteger(row.samples) ||
      (row.samples as number) < MIN_TERMINAL_SAMPLES ||
      (row.amount !== null && (!finite(row.amount) || (row.amount as number) <= 0))
    )
      return false;
    // Folding forfeits a sunk investment and nothing else.
    if (
      row.action === 'fold' &&
      (row.amount !== null ||
        row.committed !== 0 ||
        row.netChips !== 0 ||
        row.rake !== 0 ||
        row.bbjFee !== 0 ||
        row.refund !== 0 ||
        row.response !== 'terminal_showdown')
    )
      return false;
    // A wager is priced only on the canonical bound this receipt declares.
    if (
      row.action === 'raise' &&
      (wager === null ||
        !finite(row.amount) ||
        Math.abs((row.amount as number) - (wager.raiseTo as number)) > 0.005)
    )
      return false;
    if (row.action === 'call' && row.response !== 'terminal_showdown') return false;
    const key = `${row.action}:${row.response}`;
    if (seen.has(key)) return false;
    seen.add(key);
  }
  const rows = value.values as RemainingVariantActionValue[];
  const top = rows.reduce((a, b) => (b.netChips > a.netChips ? b : a));
  return (
    object(value.best) &&
    Object.keys(value.best).sort().join(',') === 'action,response' &&
    (value.best as { action: string }).action === top.action &&
    (value.best as { response: string }).response === top.response
  );
}
