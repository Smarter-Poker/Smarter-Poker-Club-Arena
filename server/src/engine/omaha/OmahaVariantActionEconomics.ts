import type { HandConfig, RakeConfig, SeatPlayer } from '../../types.js';
import type { HorseEquityOutcomeSample } from '../HorseEval.js';
import { prepareJointPots, settleJointScores } from '../multiway/JointPotDistribution.js';
import { applyJointDeductions } from '../multiway/JointDeductions.js';
import {
  isOmahaPolicyVariant,
  OMAHA_VARIANT_PACKS,
  type OmahaPolicyVariant,
} from './OmahaVariantPolicyPack.js';

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * P11-A - THE EXPLICIT NET-ACTION RESULT FOR THE PLO5 / PLO6 / PLO8 RIVER
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * The plan's P11-A gap: the live Omaha wrapper chooses from structural entry
 * bars, pot-share confidence and texture thresholds. It prices a call as
 * `callCost / netPot` against a sampled pot SHARE, and a share cannot express
 * a side pot hero is not eligible for, the uncalled-bet refund, the BBJ fee
 * (the call-price path never reads it), whole-unit allocation, or a PLO8
 * quarter or sixth as chips. This module answers the different question - how
 * many chips each legal river action actually returns - by settling the SAME
 * terminal showdowns the policy's sampler already scored through the
 * platform's own settlement owners:
 *  - `prepareJointPots` builds refunds and individual pot eligibility,
 *  - `settleJointScores` scores high and low (`splitLow` from the PACK, so
 *    PLO8 splits and PLO5/PLO6 do not),
 *  - `applyJointDeductions` charges rake and the BBJ fee.
 * None of that arithmetic is copied here. Nothing here performs I/O, reads a
 * private card, touches controller state or moves a chip.
 *
 * What it is NOT.
 *  - Not a legality source. The wager sizes priced are handed in by the live
 *    policy in the owner's legal form and are REFUSED here unless each lies
 *    inside the controller's own `minRaiseTo`/`maxRaiseTo` and hero's stack.
 *  - Not a calibrated strategy. The terminal samples carry the live sampler's
 *    uncalibrated public-line prior, and a wager is BRACKETED by two declared
 *    opponent response assumptions rather than a response model.
 *  - Not a decision input. The live policy prices a node only after it has
 *    fixed its proposal, on a budget of its own; nothing reads the result.
 *
 * Every refusal has its own name. An unavailable result is never an empty one.
 */

export const OMAHA_VARIANT_ACTION_ECONOMICS_VERSION = 'omaha-variant-action-economics-v1';

/** The pass's own budget, measured from its own start, after the policy has
 * finished. It never shares the policy's `liveBudgetMs`. */
export const OMAHA_VARIANT_NET_ACTION_BUDGET_MS = 1;

/** Fewer terminal showdowns than this is not a net economic result. */
export const OMAHA_VARIANT_MIN_TERMINAL_SAMPLES = 4;

/** At most two wager sizes are priced: the controller's minimum and the
 * largest the pot-limit, stack and controller bounds allow. */
export const OMAHA_VARIANT_MAX_PRICED_WAGERS = 2;

/**
 * The declared opponent response priced for one candidate.
 *
 * `terminal_showdown` - no further wagering: the current contesting roster
 * reaches showdown with the chips this candidate puts in.
 * `all_contesting_opponents_call` / `all_contesting_opponents_fold` - the two
 * bracketing assumptions for a wager. The real value lies between them, and
 * this module does not claim to know where.
 */
export type OmahaVariantEconomicResponse =
  | 'terminal_showdown'
  | 'all_contesting_opponents_call'
  | 'all_contesting_opponents_fold';

export interface OmahaVariantActionValue {
  /** `raise` denotes a bet or raise to `amount`. */
  action: 'fold' | 'call' | 'raise';
  response: OmahaVariantEconomicResponse;
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

export interface OmahaVariantActionEconomics {
  version: typeof OMAHA_VARIANT_ACTION_ECONOMICS_VERSION;
  variant: OmahaPolicyVariant;
  street: 'river';
  /** Terminal scoring actually applied, taken from the pack and never from
   * the caller: PLO8 splits, PLO5 and PLO6 do not. */
  scoring: 'high_only' | 'high_low_split';
  /** The controller's wager bounds and the legal-form sizes priced inside
   * them; null when no bound was read (no wager offered). */
  wagerBounds: { minRaiseTo: number; maxRaiseTo: number; priced: number[] } | null;
  chipUnit: 0.01 | 1;
  /** Terminal showdowns the caller offered. */
  offeredSamples: number;
  /** Size of the contesting roster priced, in the samples' own index order. */
  contestingOpponents: number;
  values: OmahaVariantActionValue[];
  /** The listed value with the greatest `netChips`, null when none was priced. */
  best: {
    action: 'fold' | 'call' | 'raise';
    response: OmahaVariantEconomicResponse;
    amount: number | null;
  } | null;
  /** Null exactly when `values` is non-empty. Named, never silent. */
  unavailable: string | null;
  budgetExhausted: boolean;
  analysisMs: number;
}

export interface OmahaVariantActionEconomicsInput {
  variant: string;
  stage: string;
  hero: SeatPlayer;
  /** The dealt census with private cards already stripped. */
  players: SeatPlayer[];
  /** The contesting roster, in the same index order as the samples' opponent
   * arrays. A mismatch against the contesting seats is refused, not guessed. */
  opponentIds: string[];
  samples: HorseEquityOutcomeSample[];
  currentBet: number;
  legalActions: string[];
  /** The controller's absolute bounds. These own legality. */
  minRaiseTo: number | null;
  maxRaiseTo: number | null;
  /** The wager-to sizes to price, already in the owner's legal form. */
  wagerSizes: number[];
  chipUnit: 0.01 | 1;
  asset: 'chips' | 'diamonds';
  gameMode: 'cash' | 'tournament';
  bigBlind: number;
  dealerSeat: number;
  rakeConfig: RakeConfig;
  bbjConfig: HandConfig['bbjConfig'] | null;
  /** False stops further work. A line short of the minimum sample count is
   * reported unavailable rather than averaged over whatever finished. */
  withinBudget?: () => boolean;
  now?: () => number;
}

const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
const round = (n: number) => Math.round(n * 1e6) / 1e6;
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * Price every legal candidate at a PLO5/PLO6/PLO8 river node in net chips.
 *
 * Never throws. A malformed input, a size outside the controller's bounds, a
 * settlement the platform's owners refuse, or an exhausted budget each return
 * a named `unavailable` with no values.
 */
export function omahaVariantActionEconomics(
  input: OmahaVariantActionEconomicsInput
): OmahaVariantActionEconomics {
  const now = input.now ?? (() => performance.now());
  const start = now();
  const withinBudget = input.withinBudget ?? (() => true);
  const variant = isOmahaPolicyVariant(input.variant) ? input.variant : null;
  const pack = variant ? OMAHA_VARIANT_PACKS[variant] : null;
  const result: OmahaVariantActionEconomics = {
    version: OMAHA_VARIANT_ACTION_ECONOMICS_VERSION,
    variant: variant ?? 'plo5',
    street: 'river',
    scoring: pack?.splitPot ? 'high_low_split' : 'high_only',
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
  // A partial comparison is not a comparison: pricing only the lines that fit
  // would leave `fold` alone at zero and read as a recommendation.
  if (!withinBudget()) {
    result.budgetExhausted = true;
    return refuse('work_budget_unavailable');
  }
  if (!variant || !pack) return refuse('variant_outside_net_action_slice');
  if (input.stage !== 'river') return refuse('street_outside_net_action_slice');
  if (input.chipUnit !== 0.01 && input.chipUnit !== 1) return refuse('chip_unit_unavailable');
  const hero = input.hero;
  const samples = Array.isArray(input.samples) ? input.samples : [];
  if (samples.length < OMAHA_VARIANT_MIN_TERMINAL_SAMPLES)
    return refuse('terminal_samples_unavailable');
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
    !finite(hero.stack) ||
    hero.stack < 0 ||
    !finite(hero.bet) ||
    hero.bet < 0 ||
    !Array.isArray(input.legalActions) ||
    !Array.isArray(input.wagerSizes) ||
    (input.gameMode !== 'cash' && input.gameMode !== 'tournament') ||
    (input.asset !== 'chips' && input.asset !== 'diamonds')
  )
    return refuse('canonical_input_unavailable');
  // The roster the samples were scored against must be exactly the seats
  // still contesting the pot (not folded; away seats only when all in).
  const contesting = input.players
    .filter((p) => p.user_id !== hero.user_id && !p.is_folded && (!p.is_sitting_out || p.is_all_in))
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
        (!pack.splitPot && (sample.heroLow !== null || sample.opponentLow.some((n) => n !== null)))
    )
  )
    return refuse('terminal_samples_rejected');

  const callCost = Math.min(hero.stack, Math.max(0, input.currentBet - hero.bet));
  const wagerAction = input.currentBet > 0 ? 'raise' : 'bet';
  const wagerOffered = input.legalActions.includes(wagerAction);
  // CONTROLLER BOUNDS. Every size priced must be one the controller accepts
  // as it stands: inside its own minimum and maximum, above the current bet,
  // and within hero's stack. A size outside them is a disagreement about
  // legality, and the controller wins it.
  const sizes = [...new Set(input.wagerSizes.map((n) => (finite(n) ? round(n) : NaN)))].sort(
    (a, b) => a - b
  );
  if (!wagerOffered && sizes.length) return refuse('wager_bounds_unavailable');
  if (wagerOffered) {
    if (
      !finite(input.minRaiseTo) ||
      !finite(input.maxRaiseTo) ||
      input.minRaiseTo <= input.currentBet ||
      input.maxRaiseTo < input.minRaiseTo ||
      sizes.length > OMAHA_VARIANT_MAX_PRICED_WAGERS ||
      sizes.some(
        (size) =>
          !finite(size) ||
          size < (input.minRaiseTo as number) - 0.005 ||
          size > (input.maxRaiseTo as number) + 0.005 ||
          size <= input.currentBet ||
          size - hero.bet > hero.stack + 0.005
      )
    )
      return refuse('wager_bounds_unavailable');
    result.wagerBounds = {
      minRaiseTo: round(input.minRaiseTo),
      maxRaiseTo: round(input.maxRaiseTo),
      priced: sizes,
    };
  }

  const heroIndex = input.players.findIndex((p) => p.user_id === hero.user_id);
  const unit = input.chipUnit;
  // Whole units, then back to an amount the way `prepareJointPots` does it.
  const whole = (n: number) => (unit === 1 ? Math.round(n) : Math.round(n * 100) / 100);
  const commit = (p: SeatPlayer, add: number): SeatPlayer => ({
    ...p,
    cards: [],
    stack: whole(p.stack - add),
    bet: whole(p.bet + add),
    totalInvested: whole(p.totalInvested + add),
  });

  /** Hypothetical seats after hero commits `committed` and, when the line
   * assumes a call, every contesting opponent who can still act matches
   * `level`. A short opponent goes all in for less and hero's excess comes
   * back through `prepareJointPots`, exactly as at settlement. */
  const seatsFor = (committed: number, level: number | null): SeatPlayer[] =>
    input.players.map((p, index) => {
      if (index === heroIndex) return commit(p, committed);
      if (level === null || p.is_folded || p.is_all_in || !input.opponentIds.includes(p.user_id))
        return { ...p, cards: [] };
      return commit(p, Math.min(p.stack, Math.max(0, level - p.bet)));
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

  const out = (
    action: 'call' | 'raise',
    response: OmahaVariantEconomicResponse,
    committed: number,
    amount: number,
    nets: number[],
    rake: number,
    bbjFee: number,
    refund: number
  ): OmahaVariantActionValue => ({
    action,
    response,
    amount: round(amount),
    committed: round(committed),
    netChips: round(nets.reduce((a, b) => a + b, 0) / nets.length),
    worstNetChips: round(Math.min(...nets)),
    bestNetChips: round(Math.max(...nets)),
    rake: round(rake / nets.length),
    bbjFee: round(bbjFee / nets.length),
    refund: round(refund),
    samples: nets.length,
  });

  /** One line over the offered terminal showdowns, or a named refusal. */
  const price = (
    action: 'call' | 'raise',
    response: OmahaVariantEconomicResponse,
    committed: number,
    level: number,
    amount: number
  ): OmahaVariantActionValue | string => {
    if (!withinBudget()) {
      result.budgetExhausted = true;
      return 'work_budget_unavailable';
    }
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
            splitLow: pack.splitPot,
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
    if (nets.length < OMAHA_VARIANT_MIN_TERMINAL_SAMPLES) return 'work_budget_unavailable';
    return out(action, response, committed, amount, nets, rake, bbjFee, refund);
  };

  /** Hero wagers and every contesting opponent folds. Only hero remains
   * eligible, so the same owners score a single contender and hero's
   * uncalled wager returns as a refund rather than as an award. */
  const priceUncontested = (committed: number, level: number): OmahaVariantActionValue | string => {
    if (!withinBudget()) {
      result.budgetExhausted = true;
      return 'work_budget_unavailable';
    }
    const seats = input.players.map((p, index) =>
      index === heroIndex ? commit(p, committed) : { ...p, cards: [], is_folded: true }
    );
    let prepared: ReturnType<typeof prepareJointPots>;
    try {
      prepared = prepareJointPots(seats, unit);
    } catch {
      return 'hypothetical_pots_unavailable';
    }
    const refund = prepared.refunds[hero.user_id] ?? 0;
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
      // Every showdown sample ends the same way when nobody calls, so the one
      // settlement stands for all of them.
      return {
        ...out(
          'raise',
          'all_contesting_opponents_fold',
          committed,
          level,
          [net],
          deducted.rake,
          deducted.bbjFee,
          refund
        ),
        samples: samples.length,
      };
    } catch {
      return 'terminal_settlement_unavailable';
    }
  };

  const values: OmahaVariantActionValue[] = [];
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
  for (const size of result.wagerBounds?.priced ?? []) {
    const committed = round(size - hero.bet);
    const called = price('raise', 'all_contesting_opponents_call', committed, size, size);
    if (typeof called === 'string') return refuse(called);
    values.push(called);
    const folded = priceUncontested(committed, size);
    if (typeof folded === 'string') return refuse(folded);
    values.push(folded);
  }
  if (!values.length) return refuse('no_legal_candidate_priced');
  const top = values.reduce((a, b) => (b.netChips > a.netChips ? b : a));
  result.values = values;
  result.best = { action: top.action, response: top.response, amount: top.amount };
  result.unavailable = null;
  result.analysisMs = Math.max(0, now() - start);
  return result;
}

const RESPONSES = new Set<string>([
  'terminal_showdown',
  'all_contesting_opponents_call',
  'all_contesting_opponents_fold',
]);
const ECONOMICS_KEYS =
  'analysisMs,best,budgetExhausted,chipUnit,contestingOpponents,offeredSamples,scoring,street,unavailable,values,variant,version,wagerBounds';
const BOUND_KEYS = 'maxRaiseTo,minRaiseTo,priced';
const VALUE_KEYS =
  'action,amount,bbjFee,bestNetChips,committed,netChips,rake,refund,response,samples,worstNetChips';

/**
 * The receipt's own consistency, checked against THIS running module rather
 * than trusted because something upstream produced it: the version string,
 * the exact key sets, the unavailable/values exclusive-or, the `best` argmax,
 * the fold identity, and that every priced wager is one of the declared sizes
 * inside the declared controller bounds.
 */
export function omahaVariantActionEconomicsIsValid(value: unknown): boolean {
  if (!object(value)) return false;
  if (Object.keys(value).sort().join(',') !== ECONOMICS_KEYS) return false;
  if (
    value.version !== OMAHA_VARIANT_ACTION_ECONOMICS_VERSION ||
    !isOmahaPolicyVariant(value.variant) ||
    value.street !== 'river' ||
    value.scoring !==
      (OMAHA_VARIANT_PACKS[value.variant].splitPot ? 'high_low_split' : 'high_only') ||
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
  const bounds = value.wagerBounds;
  if (bounds !== null) {
    if (!object(bounds) || Object.keys(bounds).sort().join(',') !== BOUND_KEYS) return false;
    const priced = bounds.priced;
    if (
      !finite(bounds.minRaiseTo) ||
      (bounds.minRaiseTo as number) <= 0 ||
      !finite(bounds.maxRaiseTo) ||
      (bounds.maxRaiseTo as number) < (bounds.minRaiseTo as number) ||
      !Array.isArray(priced) ||
      priced.length > OMAHA_VARIANT_MAX_PRICED_WAGERS ||
      priced.some(
        (size, i) =>
          !finite(size) ||
          size < (bounds.minRaiseTo as number) - 0.005 ||
          size > (bounds.maxRaiseTo as number) + 0.005 ||
          (i > 0 && size <= (priced[i - 1] as number))
      )
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
      (row.samples as number) < OMAHA_VARIANT_MIN_TERMINAL_SAMPLES ||
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
    // A wager is priced only at a size this receipt declares.
    if (
      row.action === 'raise' &&
      (bounds === null ||
        row.response === 'terminal_showdown' ||
        !(bounds.priced as number[]).some(
          (size) => Math.abs((row.amount as number) - size) <= 0.005
        ))
    )
      return false;
    if (row.action === 'call' && row.response !== 'terminal_showdown') return false;
    const key = `${row.action}:${row.response}:${row.amount}`;
    if (seen.has(key)) return false;
    seen.add(key);
  }
  const rows = value.values as OmahaVariantActionValue[];
  const top = rows.reduce((a, b) => (b.netChips > a.netChips ? b : a));
  return (
    object(value.best) &&
    Object.keys(value.best).sort().join(',') === 'action,amount,response' &&
    (value.best as { action: string }).action === top.action &&
    (value.best as { response: string }).response === top.response &&
    (value.best as { amount: number | null }).amount === top.amount
  );
}
