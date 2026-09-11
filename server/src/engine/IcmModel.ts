/**
 * Tournament payout equity.
 *
 * Phase 7 evaluates resulting stack vectors rather than applying one global
 * bubble multiplier. Final tables of up to ten live players use exact
 * Malmuth-Harville recursion. Larger fields use direct deterministic Monte
 * Carlo of the same Plackett-Luce finishing-order distribution: independent
 * exponential clocks with stack-sized rates. No player or paid place is
 * bucketed, merged, or discarded.
 *
 * All functions are pure. No database, clock, network, or action-clock I/O.
 */

const EXACT_MAX_PLAYERS = 10;
const MC_MAX_TRIALS = 1_200;
const MC_MIN_TRIALS = 96;
const MC_TARGET_CLOCK_DRAWS = 240_000;
/** Two-sided Hoeffding confidence outside the reported Monte Carlo radius. */
const MC_ERROR_ALPHA = 0.001;

export type IcmMethod = 'exact_mh' | 'plackett_luce_mc';

export interface IcmEstimate {
  /** Expected prize in the same unit as the supplied payout curve. */
  equity: number;
  /** 99.9% confidence half-width in payout units; zero for exact recursion. */
  errorBound: number;
  method: IcmMethod;
  modeledPlayers: number;
  trials?: number;
  standardError?: number;
}

/**
 * One action-wide ICM workspace. Large-field random clocks are generated once
 * and reused across every candidate stack vector. `mutableIndices` names the
 * table-local stacks that may change; every other stack is checked immutable.
 */
export interface IcmEquityEstimator {
  estimate(stacks: number[]): IcmEstimate;
  method: IcmMethod;
  trials: number;
  randomClockDraws: number;
}

const cleanStacks = (stacks: number[]): number[] =>
  stacks.map((stack) => (Number.isFinite(stack) && stack > 0 ? stack : 0));

const cleanPayouts = (payouts: number[]): number[] =>
  payouts.map((payout) => (Number.isFinite(payout) && payout > 0 ? payout : 0));

const payoutMass = (payouts: number[]): number =>
  payouts.reduce((sum, payout) => sum + (Number.isFinite(payout) && payout > 0 ? payout : 0), 0);

/**
 * True for equal-seat curves, including a final sub-seat cash remainder.
 * Classification is retained for legacy strategy reads; the ICM calculator
 * itself always prices every place value and never flattens the remainder.
 */
export function isFlatPayoutCurve(payouts: number[]): boolean {
  const positive = payouts.filter((payout) => Number.isFinite(payout) && payout > 0);
  if (positive.length < 2) return false;
  const first = positive[0];
  const core =
    positive.length >= 3 && positive.at(-1)! < first * 0.5 ? positive.slice(0, -1) : positive;
  return core.length >= 2 && core.every((payout) => Math.abs(payout - first) <= first * 0.05);
}

/**
 * Exact Malmuth-Harville equity for one player.
 *
 * A bit-mask dynamic program visits at most 2^10 states. Zero-stack entries
 * are compacted first, so ten live finalists remain exact even when the input
 * vector retains already-busted identities.
 */
export function exactIcmEquity(stacks: number[], payouts: number[], heroIdx: number): number {
  const original = cleanStacks(stacks);
  const prizes = cleanPayouts(payouts);
  if (
    original.length === 0 ||
    heroIdx < 0 ||
    heroIdx >= original.length ||
    original[heroIdx] <= 0 ||
    payoutMass(prizes) <= 0
  ) {
    return 0;
  }

  const live = original
    .map((stack, index) => ({ stack, index }))
    .filter((entry) => entry.stack > 0);
  if (live.length > EXACT_MAX_PLAYERS) return 0;
  const clean = live.map((entry) => entry.stack);
  const compactHero = live.findIndex((entry) => entry.index === heroIdx);
  if (compactHero < 0) return 0;

  const n = clean.length;
  const fullMask = (1 << n) - 1;
  const paidDepth = Math.min(n, prizes.length);
  const memo = new Map<number, number>();

  const recurse = (mask: number): number => {
    const cached = memo.get(mask);
    if (cached !== undefined) return cached;
    if ((mask & (1 << compactHero)) === 0) return 0;

    let remaining = 0;
    let total = 0;
    for (let index = 0; index < n; index++) {
      if ((mask & (1 << index)) === 0) continue;
      remaining++;
      total += clean[index];
    }
    const place = n - remaining;
    if (place >= paidDepth || total <= 0) return 0;

    let equity = 0;
    for (let winner = 0; winner < n; winner++) {
      if ((mask & (1 << winner)) === 0 || clean[winner] <= 0) continue;
      const probability = clean[winner] / total;
      equity +=
        winner === compactHero
          ? probability * prizes[place]
          : probability * recurse(mask & ~(1 << winner));
    }
    memo.set(mask, equity);
    return equity;
  };

  return recurse(fullMask);
}

/** Exact all-player vector for golden/differential checks and final tables. */
export function exactIcmVector(stacks: number[], payouts: number[]): number[] {
  return stacks.map((_, heroIdx) => exactIcmEquity(stacks, payouts, heroIdx));
}

function mcTrials(players: number): number {
  return Math.max(
    MC_MIN_TRIALS,
    Math.min(MC_MAX_TRIALS, Math.floor(MC_TARGET_CLOCK_DRAWS / Math.max(1, players)))
  );
}

/** First index whose clock is not strictly less than `target`. */
function lowerBound(sorted: Float64Array, target: number): number {
  let low = 0;
  let high = sorted.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (sorted[mid] < target) low = mid + 1;
    else high = mid;
  }
  return low;
}

/**
 * Build a direct Plackett-Luce estimator with common random numbers.
 *
 * Independent exponential clocks are still the exact MH ranking model. For
 * an action, remote stacks never change, so their clocks are sorted once per
 * trial. Each candidate then needs one binary search plus at most the local
 * table size, rather than another full-field pass with another Math.log for
 * every resulting vector.
 */
export function createIcmEquityEstimator(
  stacks: number[],
  payouts: number[],
  heroIdx: number,
  mutableIndices: number[] = stacks.map((_, index) => index),
  maximumTrials: number = MC_MAX_TRIALS
): IcmEquityEstimator {
  const reference = cleanStacks(stacks);
  const prizes = cleanPayouts(payouts);
  const live = reference.filter((stack) => stack > 0).length;
  const mutable = [...new Set([...mutableIndices, heroIdx])]
    .filter((index) => Number.isSafeInteger(index) && index >= 0 && index < reference.length)
    .sort((left, right) => left - right);
  const mutableSet = new Set(mutable);
  if (live <= EXACT_MAX_PLAYERS) {
    return {
      method: 'exact_mh',
      trials: 0,
      randomClockDraws: 0,
      estimate(vector: number[]): IcmEstimate {
        if (vector.length !== reference.length) {
          throw new Error('ICM candidate vector length changed inside one action');
        }
        const clean = cleanStacks(vector);
        for (let index = 0; index < reference.length; index++) {
          if (!mutableSet.has(index) && Math.abs(clean[index] - reference[index]) > 0.005) {
            throw new Error('ICM remote stack changed inside one action');
          }
        }
        const modeledPlayers = clean.filter((stack) => stack > 0).length;
        return {
          equity: exactIcmEquity(clean, prizes, heroIdx),
          errorBound: 0,
          method: 'exact_mh',
          modeledPlayers,
        };
      },
    };
  }

  const mutableSlot = new Map(mutable.map((index, slot) => [index, slot]));
  const immutable = reference
    .map((stack, index) => ({ stack, index }))
    .filter((entry) => !mutableSet.has(entry.index));
  const fixed = reference
    .map((stack, index) => ({ stack, index }))
    .filter((entry) => entry.stack > 0 && !mutableSet.has(entry.index));
  const trials = Math.min(
    mcTrials(live),
    Math.max(
      MC_MIN_TRIALS,
      Math.min(
        MC_MAX_TRIALS,
        Number.isFinite(maximumTrials) ? Math.floor(maximumTrials) : MC_MAX_TRIALS
      )
    )
  );
  const mutableDraws = mutable.map(() => new Float64Array(trials));
  const remoteClocks: Float64Array[] = new Array(trials);

  let seed =
    0x9e3779b9 ^
    ((heroIdx + 1) * 0x85ebca6b) ^
    (reference.length * 0xc2b2ae35) ^
    (prizes.length << 16);
  const rand = (): number => {
    seed ^= seed << 13;
    seed >>>= 0;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    seed >>>= 0;
    return Math.max(Number.EPSILON, seed / 0x1_0000_0000);
  };

  for (let trial = 0; trial < trials; trial++) {
    // Native Float64Array sorting is numeric and avoids constructing, sorting,
    // then copying a boxed-number Array for every trial. At 200-1,000 live
    // players this is the dominant Phase 7 action-clock cost. The RNG draw
    // order and every clock value remain identical; only the container used
    // for the same ascending sort changes.
    const clocks = new Float64Array(fixed.length);
    let clockIndex = 0;
    for (let index = 0; index < reference.length; index++) {
      const stack = reference[index];
      if (stack <= 0 && !mutableSet.has(index)) continue;
      const exponential = -Math.log(rand());
      const slot = mutableSlot.get(index);
      if (slot !== undefined) mutableDraws[slot][trial] = exponential;
      else clocks[clockIndex++] = exponential / stack;
    }
    if (clockIndex !== clocks.length) {
      throw new Error('ICM fixed-clock workspace did not match its live remote field');
    }
    clocks.sort();
    remoteClocks[trial] = clocks;
  }

  const heroSlot = mutableSlot.get(heroIdx);
  if (heroSlot === undefined) throw new Error('ICM estimator requires a mutable hero index');
  const maximum = prizes.reduce((largest, payout) => Math.max(largest, payout), 0);
  const errorBound = maximum * Math.sqrt(Math.log(2 / MC_ERROR_ALPHA) / (2 * trials));

  return {
    method: 'plackett_luce_mc',
    trials,
    randomClockDraws: trials * (fixed.length + mutable.length),
    estimate(vector: number[]): IcmEstimate {
      if (vector.length !== reference.length) {
        throw new Error('ICM candidate vector length changed inside one action');
      }
      const clean = cleanStacks(vector);
      for (const entry of immutable) {
        if (Math.abs(clean[entry.index] - entry.stack) > 0.005) {
          throw new Error('ICM remote stack changed inside one action');
        }
      }
      const heroStack = clean[heroIdx] ?? 0;
      const modeledPlayers = clean.filter((stack) => stack > 0).length;
      if (heroStack <= 0 || payoutMass(prizes) <= 0) {
        return {
          equity: 0,
          errorBound: 0,
          method: 'plackett_luce_mc',
          modeledPlayers,
          trials,
          standardError: 0,
        };
      }

      let mean = 0;
      let m2 = 0;
      for (let trial = 0; trial < trials; trial++) {
        const heroClock = mutableDraws[heroSlot][trial] / heroStack;
        let playersAhead = lowerBound(remoteClocks[trial], heroClock);
        for (let slot = 0; slot < mutable.length; slot++) {
          const index = mutable[slot];
          if (index === heroIdx || clean[index] <= 0) continue;
          if (mutableDraws[slot][trial] / clean[index] < heroClock) playersAhead++;
        }
        const value = prizes[playersAhead] ?? 0;
        const sample = trial + 1;
        const delta = value - mean;
        mean += delta / sample;
        m2 += delta * (value - mean);
      }

      const variance = trials > 1 ? m2 / (trials - 1) : 0;
      return {
        equity: mean,
        errorBound,
        method: 'plackett_luce_mc',
        modeledPlayers,
        trials,
        standardError: Math.sqrt(Math.max(0, variance) / trials),
      };
    },
  };
}

/** Direct Monte Carlo of a hero's place in a stack-weighted MH ranking. */
function plackettLuceEstimate(stacks: number[], payouts: number[], heroIdx: number): IcmEstimate {
  const clean = cleanStacks(stacks);
  const live = clean.map((stack, index) => ({ stack, index })).filter((entry) => entry.stack > 0);
  const hero = live.find((entry) => entry.index === heroIdx);
  if (!hero || payoutMass(payouts) <= 0) {
    return {
      equity: 0,
      errorBound: 0,
      method: 'plackett_luce_mc',
      modeledPlayers: live.length,
      trials: 0,
      standardError: 0,
    };
  }
  return createIcmEquityEstimator(clean, payouts, heroIdx).estimate(clean);
}

/** Backward-compatible probability-only satellite helper. */
export function flatPayoutSurvival(stacks: number[], seats: number, heroIdx: number): number {
  const clean = cleanStacks(stacks);
  const live = clean.filter((stack) => stack > 0).length;
  if (heroIdx < 0 || heroIdx >= clean.length || clean[heroIdx] <= 0 || seats <= 0) return 0;
  if (live <= seats) return 1;
  const prizes = Array.from({ length: Math.max(0, Math.floor(seats)) }, () => 1);
  return live <= EXACT_MAX_PLAYERS
    ? exactIcmEquity(clean, prizes, heroIdx)
    : plackettLuceEstimate(clean, prizes, heroIdx).equity;
}

/** Equity plus the method/error receipt consumed by the Phase 7 ledger. */
export function icmEquityEstimate(
  stacks: number[],
  payouts: number[],
  heroIdx: number
): IcmEstimate {
  const clean = cleanStacks(stacks);
  const live = clean.filter((stack) => stack > 0).length;
  if (
    clean.length === 0 ||
    heroIdx < 0 ||
    heroIdx >= clean.length ||
    clean[heroIdx] <= 0 ||
    payoutMass(payouts) <= 0
  ) {
    return { equity: 0, errorBound: 0, method: 'exact_mh', modeledPlayers: live };
  }

  if (live <= EXACT_MAX_PLAYERS) {
    return {
      equity: exactIcmEquity(clean, payouts, heroIdx),
      errorBound: 0,
      method: 'exact_mh',
      modeledPlayers: live,
    };
  }
  return plackettLuceEstimate(clean, payouts, heroIdx);
}

/** Prize equity only, retained for all existing callers. */
export function icmEquity(stacks: number[], payouts: number[], heroIdx: number): number {
  return icmEquityEstimate(stacks, payouts, heroIdx).equity;
}

/**
 * Bubble factor retained for legacy layers. Phase 7's final action arbiter no
 * longer uses this single global multiplier; it evaluates each action's stack
 * vectors directly.
 */
export function bubbleFactor(
  stacks: number[],
  payouts: number[],
  heroIdx: number,
  riskChips: number
): number {
  if (riskChips <= 0) return 1;
  const hero = stacks[heroIdx] ?? 0;
  if (hero <= 0) return 1;

  let opponentIdx = -1;
  for (let index = 0; index < stacks.length; index++) {
    if (index === heroIdx) continue;
    if (opponentIdx === -1 || stacks[index] > stacks[opponentIdx]) opponentIdx = index;
  }
  if (opponentIdx === -1) return 1;
  const risk = Math.min(riskChips, hero, stacks[opponentIdx]);
  if (risk <= 0) return 1;

  const now = icmEquity(stacks, payouts, heroIdx);
  const up = stacks.slice();
  up[heroIdx] = hero + risk;
  up[opponentIdx] = stacks[opponentIdx] - risk;
  const down = stacks.slice();
  down[heroIdx] = hero - risk;
  down[opponentIdx] = stacks[opponentIdx] + risk;
  const gain = icmEquity(up, payouts, heroIdx) - now;
  const loss = now - icmEquity(down, payouts, heroIdx);
  if (gain <= 1e-12) return 5;
  return Math.max(1, Math.min(5, loss / gain));
}

export function premiumFromBubbleFactor(factor: number): number {
  return Math.max(0, Math.min(0.14, (factor - 1) * 0.04));
}
