/** Candidate Omaha tournament preflop action-risk pricing, selectively recovered
 * from PR8014. Uses public stacks/payouts and the existing ICM estimator.
 * The risk/fold-equity mappings and historical variant slopes are hypotheses,
 * not exact opponent strategy or independent qualification. This candidate
 * defaults off until a current-source whole-tournament comparison passes.
 * No cash, bounty, satellite, hi-lo or postflop activation is implied.
 */

import { createIcmEquityEstimator, type IcmEquityEstimator } from './IcmModel.js';

/** Equity per unit of preflop strength, by Omaha hole count (candidate calibration). */
export const OMAHA_EQUITY_SLOPE = Object.freeze({ 4: 0.303, 5: 0.22, 6: 0.171 } as const);
export type OmahaPressureHoleCount = keyof typeof OMAHA_EQUITY_SLOPE;

/** Real M at or below which the premium is fully gone, and at or above which it is whole. */
export const PRESSURE_M_FLOOR = 1;
export const PRESSURE_M_FULL = 7;
/** Remaining stack at or below this many pot-limit bets means the action commits. */
export const POT_LIMIT_COMMIT_BETS = 1;
/** Share of the next street's pot-limit bet a non-committing action expects to put in. */
export const NEXT_STREET_BET_SHARE = 0.5;
/** Hard bounds, in equity and in strength. */
export const MAX_EQUITY_PREMIUM = 0.12;
export const MAX_STRENGTH_SHIFT = 0.2;
/** Fold equity is the same currency as the premium, so it carries the same cap. */
export const MAX_FOLD_EQUITY_BONUS = MAX_STRENGTH_SHIFT;
/**
 * A Monte Carlo field (more than ten live players) prices a difference only
 * when it clears this many standard errors; below that the "premium" is the
 * estimator's noise, and the layer prices zero rather than noise.
 */
export const MC_RESOLUTION_SE = 3;
/** Share of the opponent's own premium credited to hero's raises as fold equity. */
export const FOLD_EQUITY_CREDIT = 0.5;

export interface OmahaPressureOpponent {
  userId: string;
  /** Chips behind, not including this hand's bet. */
  stack: number;
  /** Chips in front this street. */
  bet: number;
  folded: boolean;
  allIn: boolean;
  sittingOut: boolean;
  /** Still to act after hero on this street. */
  actsAfterHero: boolean;
}

export interface OmahaPressureInput {
  holeCount: number;
  isHiLo: boolean;
  isPotLimit: boolean;
  heroUserId: string;
  /** Chips behind. */
  heroStack: number;
  heroBet: number;
  /** Full pot including every bet in front. */
  pot: number;
  /** The part of the pot hero can win (PokerEngine.calculateContestablePot). */
  contestablePot: number;
  currentBet: number;
  toCall: number;
  bigBlind: number;
  /** Pot-limit raise-to ceiling for this decision (BettingStructure.potLimitRaiseTo). */
  potRaiseTo: number;
  /** Nobody has raised (limps and blinds only). */
  unopened: boolean;
  /** Seat of the last raiser's user, or null. */
  lastRaiserUserId: string | null;
  opponents: OmahaPressureOpponent[];
  /** Field stacks from the tournament snapshot (cached totals, local identities included). */
  fieldStacks: number[];
  /** Cached totals keyed by the local identities they belong to. */
  fieldStackByUser: Record<string, number>;
  /** Unsettled payouts for the remaining places, place 1 first. */
  payoutPct: number[];
  playersLeft: number;
  /** Real M (stack over orbit cost), projected to the next level when it is imminent. */
  realM: number;
}

export interface OmahaPressureShifts {
  /** Strength shifts, added to the bars of the same name. */
  open: number;
  threeBet: number;
  fourBet: number;
  call: number;
  /** V25 unopened commit (the raise is the stack). */
  commitOpen: number;
  /** V25 facing call-off (the chips go in against a live raiser). */
  commitCall: number;
  /** Equity-unit survival premium for the bluff budget (replaces riskAdd there). */
  bluffRisk: number;
}

export interface OmahaPressureReceipt {
  schemaVersion: 1;
  shifts: OmahaPressureShifts;
  opponentUserId: string;
  heroCovers: boolean;
  /** Chips at risk by family, after the covering cap. */
  risk: { call: number; raise: number; commit: number };
  /** Equity premiums (ICM required minus chip-EV required), before depth and slope. */
  premium: { call: number; raise: number; commit: number; opponentCommit: number };
  urgency: number;
  opponentUrgency: number;
  slope: number;
  icmMethod: IcmEquityEstimator['method'];
}

const clamp = (value: number, low: number, high: number): number =>
  Math.max(low, Math.min(high, value));
const finite = (value: number): number => (Number.isFinite(value) ? value : 0);

/** The variants this layer prices; null for everything it leaves alone. */
export function omahaPressureSlope(
  holeCount: number,
  isHiLo: boolean,
  isPotLimit: boolean
): number | null {
  if (isHiLo || !isPotLimit) return null;
  return holeCount === 4 || holeCount === 5 || holeCount === 6
    ? OMAHA_EQUITY_SLOPE[holeCount]
    : null;
}

/** Linear fade of the survival premium with real M. */
export function pressureUrgency(realM: number): number {
  return clamp((finite(realM) - PRESSURE_M_FLOOR) / (PRESSURE_M_FULL - PRESSURE_M_FLOOR), 0, 1);
}

/**
 * Chips a decision puts at risk in pot limit.
 *
 * `invest` goes in now. If what is left behind is no more than one pot-limit
 * bet into the pot that results, the action is a commitment and risks the
 * whole effective stack; otherwise it risks the investment plus the expected
 * share of the next street's pot-sized bet. Never more than `effective`.
 */
export function potLimitRisk(
  invest: number,
  heroStack: number,
  potAfter: number,
  effective: number
): number {
  const put = clamp(invest, 0, heroStack);
  const behind = heroStack - put;
  const committed = behind <= POT_LIMIT_COMMIT_BETS * Math.max(0, potAfter);
  const risk = committed ? effective : put + NEXT_STREET_BET_SHARE * Math.max(0, potAfter);
  return clamp(risk, 0, effective);
}

/** Chip-EV equity hero needs to risk R against an opponent who matches R - toCall into pot P. */
export function chipRequiredEquity(risk: number, pot: number, toCall: number): number {
  const matched = Math.max(0, risk - toCall);
  const denominator = pot + matched + risk;
  return denominator > 0 ? clamp(risk / denominator, 0, 1) : 1;
}

/** ICM required equity from the three outcome equities; 1 when winning cannot gain. */
export function icmRequiredEquity(fold: number, win: number, lose: number): number {
  const denominator = win - lose;
  if (!(denominator > 1e-12)) return 1;
  return clamp((fold - lose) / denominator, 0, 1);
}

interface IcmField {
  vector: number[];
  index: Map<string, number>;
}

/**
 * Field vector with every local identity's cached total replaced by its live
 * chips behind (the pot is priced separately). Null when hero's own cached
 * entry cannot be found: an identity guess is how the legacy model priced
 * the wrong stack, and this layer refuses rather than guess.
 */
export function buildIcmField(
  fieldStacks: readonly number[],
  fieldStackByUser: Readonly<Record<string, number>>,
  heroUserId: string,
  local: ReadonlyArray<{ userId: string; stack: number }>
): IcmField | null {
  if (
    !Array.isArray(fieldStacks) ||
    fieldStacks.length < 2 ||
    fieldStacks.some((stack) => !Number.isFinite(stack) || stack <= 0) ||
    !local.length ||
    !local.some((p) => p.userId === heroUserId) ||
    new Set(local.map((p) => p.userId)).size !== local.length ||
    local.some((p) => !p.userId || !Number.isFinite(p.stack) || p.stack < 0)
  )
    return null;
  const remaining = [...fieldStacks];
  for (const player of local) {
    const observed = fieldStackByUser[player.userId];
    const at =
      Number.isFinite(observed) && observed > 0
        ? remaining.findIndex((stack) => Math.abs(stack - observed) <= 0.005)
        : -1;
    if (at < 0) return null;
    remaining.splice(at, 1);
  }
  const vector = remaining.slice();
  const index = new Map<string, number>();
  for (const player of local) {
    index.set(player.userId, vector.length);
    vector.push(Math.max(0, finite(player.stack)));
  }
  return { vector, index };
}

/** Payout equity (and its Monte Carlo standard error) of `who`; a bust is paid the last-place prize. */
function equityOf(
  estimator: IcmEquityEstimator,
  vector: number[],
  who: number,
  bustPrize: number
): { equity: number; se: number } {
  if (!(vector[who] > 0)) return { equity: bustPrize, se: 0 };
  const estimate = estimator.estimate(vector);
  return { equity: estimate.equity, se: estimate.standardError ?? 0 };
}

interface Proposition {
  /** Chips the decider risks from behind. */
  risk: number;
  /** What the decider must call first. */
  toCall: number;
  /** Pot the decider can win. */
  contestable: number;
  /** Full pot. */
  pot: number;
  decider: number;
  other: number;
}

/** ICM required minus chip-EV required equity for one two-way proposition. */
function propositionPremium(
  estimator: IcmEquityEstimator,
  base: number[],
  p: Proposition,
  bustPrize: number
): number {
  if (!(p.risk > 0)) return 0;
  const s = base[p.decider];
  const o = base[p.other];
  const matched = Math.min(o, Math.max(0, p.risk - p.toCall));
  const spill = Math.max(0, p.pot - p.contestable);
  const fold = base.slice();
  fold[p.other] = o + p.pot;
  const win = base.slice();
  win[p.decider] = s + p.contestable + matched;
  win[p.other] = o - matched + spill;
  const lose = base.slice();
  lose[p.decider] = Math.max(0, s - p.risk);
  lose[p.other] = o + p.pot + p.risk;
  const f = equityOf(estimator, fold, p.decider, bustPrize);
  const w = equityOf(estimator, win, p.decider, bustPrize);
  const l = equityOf(estimator, lose, p.decider, bustPrize);
  // Exact recursion has zero standard error and always resolves.
  const noise = Math.sqrt(f.se ** 2 + w.se ** 2 + l.se ** 2);
  if (w.equity - l.equity <= MC_RESOLUTION_SE * noise) return 0;
  const required = icmRequiredEquity(f.equity, w.equity, l.equity);
  return clamp(
    required - chipRequiredEquity(p.risk, p.contestable, p.toCall),
    0,
    MAX_EQUITY_PREMIUM
  );
}

/**
 * The candidate receipt for one preflop decision, or null when the layer does not
 * apply (wrong variant, missing identity or payout data, no live opponent).
 */
export function omahaTournamentPressure(input: OmahaPressureInput): OmahaPressureReceipt | null {
  const slope = omahaPressureSlope(input.holeCount, input.isHiLo, input.isPotLimit);
  if (slope === null) return null;
  // Unknown chip geometry must not become zero-valued, apparently priced risk.
  if (
    [
      input.heroStack,
      input.heroBet,
      input.pot,
      input.contestablePot,
      input.currentBet,
      input.toCall,
      input.bigBlind,
      input.potRaiseTo,
      input.realM,
    ].some((value) => !Number.isFinite(value) || value < 0) ||
    input.contestablePot > input.pot ||
    input.opponents.some(
      (o) => !Number.isFinite(o.stack) || o.stack < 0 || !Number.isFinite(o.bet) || o.bet < 0
    )
  )
    return null;
  if (
    !Number.isInteger(input.playersLeft) ||
    input.playersLeft < 2 ||
    input.fieldStacks.length !== input.playersLeft ||
    !Array.isArray(input.payoutPct) ||
    input.payoutPct.length > input.playersLeft ||
    input.payoutPct.some((v, i, all) => !Number.isFinite(v) || v < 0 || (i > 0 && v > all[i - 1]))
  )
    return null;
  const payouts = [...input.payoutPct];
  if (!payouts.some((value) => value > 0)) return null;
  const heroStack = Math.max(0, finite(input.heroStack));
  if (!(heroStack > 0) || !(input.bigBlind > 0)) return null;

  const live = input.opponents.filter(
    (o) => o.userId !== input.heroUserId && !o.folded && (!o.sittingOut || o.allIn)
  );
  if (live.length === 0) return null;
  const respond = live.filter((o) => !o.allIn && !o.sittingOut && o.stack > 0);
  // Facing a raise, the raiser is the opponent (all-in or not). Unopened, the
  // biggest stack still able to call - the one that can do the most damage
  // and the one least pressured to fold.
  const raiser =
    !input.unopened && input.lastRaiserUserId
      ? live.find((o) => o.userId === input.lastRaiserUserId)
      : undefined;
  const pool = respond.filter((o) => o.actsAfterHero).length
    ? respond.filter((o) => o.actsAfterHero)
    : respond;
  const opponent =
    raiser ??
    pool.reduce<OmahaPressureOpponent | undefined>(
      (best, o) =>
        !best ||
        o.stack + o.bet > best.stack + best.bet ||
        (o.stack + o.bet === best.stack + best.bet && o.userId < best.userId)
          ? o
          : best,
      undefined
    );
  if (!opponent) return null;

  const local = [
    { userId: input.heroUserId, stack: heroStack },
    ...input.opponents
      .filter((o) => o.userId !== input.heroUserId)
      .map((o) => ({ userId: o.userId, stack: Math.max(0, finite(o.stack)) })),
  ];
  const field = buildIcmField(input.fieldStacks, input.fieldStackByUser, input.heroUserId, local);
  if (!field) return null;
  const heroIdx = field.index.get(input.heroUserId);
  const oppIdx = field.index.get(opponent.userId);
  if (heroIdx === undefined || oppIdx === undefined) return null;
  const mutable = [heroIdx, oppIdx];
  const heroIcm = createIcmEquityEstimator(field.vector, payouts, heroIdx, mutable);
  const oppIcm = createIcmEquityEstimator(field.vector, payouts, oppIdx, mutable);
  const bustPrize = payouts[Math.max(0, Math.floor(input.playersLeft) - 1)] ?? 0;

  const pot = Math.max(0, finite(input.pot));
  const contestable = clamp(finite(input.contestablePot), 0, pot);
  const toCall = Math.max(0, finite(input.toCall));
  const o = Math.max(0, finite(opponent.stack));
  const effective = Math.min(heroStack, toCall + o);
  const call = Math.min(toCall, heroStack);
  const callRisk = potLimitRisk(call, heroStack, pot + call, effective);
  const raiseTo = Math.max(finite(input.potRaiseTo), finite(input.currentBet));
  const raiseInvest = Math.max(0, raiseTo - Math.max(0, finite(input.heroBet)));
  // Called, the raise builds the raiser's investment plus the caller's match.
  const raiseRisk = potLimitRisk(
    raiseInvest,
    heroStack,
    pot + raiseInvest + Math.max(0, raiseInvest - toCall),
    effective
  );
  const commitRisk = effective;

  const hero = (risk: number): number =>
    propositionPremium(
      heroIcm,
      field.vector,
      { risk, toCall, contestable, pot, decider: heroIdx, other: oppIdx },
      bustPrize
    );
  const commitPremium = hero(commitRisk);
  // The premium of a small risk is a ratio of two small equity differences.
  // Exact Malmuth-Harville resolves it; a Monte Carlo field does not, so
  // there the premium is read once, on the commitment, and scaled by the
  // share of it each action risks (a candidate first-order approximation, not an exact
  // identity for nonlinear payout equity).
  const exact = heroIcm.method === 'exact_mh';
  const scaled = (risk: number): number =>
    exact ? hero(risk) : commitRisk > 0 ? (commitPremium * risk) / commitRisk : 0;
  // Hero's proposed commitment is already in the opponent-facing pot. Remove
  // it from the behind-stack vector before pricing that response, otherwise
  // every outcome invents the same commitment amount as extra field chips.
  const opponentBase = field.vector.slice();
  opponentBase[heroIdx] -= commitRisk;
  const premium = {
    call: scaled(callRisk),
    raise: scaled(raiseRisk),
    commit: commitPremium,
    // The opponent facing hero's commitment: they must put in what hero put
    // in beyond their own bet, into the pot hero's raise built.
    opponentCommit: propositionPremium(
      oppIcm,
      opponentBase,
      {
        risk: Math.min(o, Math.max(0, commitRisk - toCall)),
        toCall: Math.min(o, Math.max(0, commitRisk - toCall)),
        contestable: pot + commitRisk,
        pot: pot + commitRisk,
        decider: oppIdx,
        other: heroIdx,
      },
      bustPrize
    ),
  };

  const urgency = pressureUrgency(input.realM);
  // The opponent's own depth fades the opponent's pressure the same way: one
  // orbit costs heroStack / realM, so their M is their chips over that.
  const opponentUrgency =
    input.realM > 0
      ? pressureUrgency(((o + Math.max(0, finite(opponent.bet))) * input.realM) / heroStack)
      : 0;
  const toStrength = (equity: number): number =>
    clamp((equity * urgency) / slope, 0, MAX_STRENGTH_SHIFT);
  const foldEquity = clamp(
    (FOLD_EQUITY_CREDIT * premium.opponentCommit * opponentUrgency) / slope,
    0,
    MAX_FOLD_EQUITY_BONUS
  );
  const raise = toStrength(premium.raise) - foldEquity;
  const shifts: OmahaPressureShifts = {
    open: raise,
    threeBet: raise,
    fourBet: raise,
    call: toStrength(premium.call),
    commitOpen: toStrength(premium.commit) - foldEquity,
    commitCall: toStrength(premium.commit),
    bluffRisk: clamp(premium.raise * urgency, 0, 0.15),
  };
  const round = (value: number): number => Math.round(value * 1e5) / 1e5;
  for (const key of Object.keys(shifts) as Array<keyof OmahaPressureShifts>) {
    shifts[key] = round(shifts[key]);
  }
  return {
    schemaVersion: 1,
    shifts,
    opponentUserId: opponent.userId,
    heroCovers: heroStack > toCall + o,
    risk: { call: callRisk, raise: raiseRisk, commit: commitRisk },
    premium,
    urgency,
    opponentUrgency,
    slope,
    icmMethod: heroIcm.method,
  };
}
