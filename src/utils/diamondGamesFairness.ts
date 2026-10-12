/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  DIAMOND PLINKO + DIAMOND CRASH FAIRNESS - recompute a round in the browser
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Both games share the wheel's commit-and-reveal (src/utils/wheelFairness.ts):
 * sha256(server_seed) is published before the bet, the seed is revealed after,
 * and HMAC-SHA256(key = server_seed, message = client_seed || ':' || nonce) is
 * the round. What differs is how the bytes are read:
 *
 *   PLINKO: bit i of the HMAC (i = 0..15, Postgres get_bit order: bit 0 is the
 *   least significant bit of byte 0) is row i, 1 = right. The slot is the
 *   number of rights. path_bits packs the same sixteen bits little-endian.
 *
 *   CRASH: the first six bytes as a 48-bit integer r, u = (r + 1) / 2^48, and
 *   the guaranteed minimum the round seals as a share of its own stake,
 *   L = minimum_payout_chips / bet_chips. The crash point is
 *   X = max(floor, L + (0.8 - L) / u), in cents floor(100 * X), so for any
 *   target x above the floor, P(X >= x) = (0.8 - L) / (x - L).
 *   CONTRACT 4 (Dan, 2026-09-21, R3): that floor is 110 (1.10x) and cash out
 *   opens at 1.11x, where it was 100 before. For any x above 1.10,
 *   max(raw, 110) >= x iff raw >= x, so every cash-out target still returns
 *   exactly 0.80B; the ship can never explode until after 1.10x. A receipt
 *   says which floor it was sealed under through payout_version.
 *   CONTRACT 5 (Dan, 2026-10-12, migration 20261012140447): "THE GAME SHOULD
 *   NEVER CRASH BEFORE 1.25X", "CRASH CAN BE A 5% HOUSE EDGE GAME", "THE
 *   'AVERAGE CRASH' IS BETWEEN 2.4 -3.0X" and "IT CAN PAY OUT UP TO 120%". The
 *   floor is 125 (1.25x), cash out opens at 1.26x, the cap is 20x, and
 *   X = max(1.25, L + (R - L) / u) where the return R is chosen PER ROUND from
 *   its own L so the 20x-capped average crash, 1.25 + (R - L) ln((20 - L) /
 *   (1.25 - L)), is 2.9x: R = L + 1.65 / ln(...), clamped to 0.95..1.20, in
 *   millionths rounded down (fn_crash_return_ppm_v5, mirrored exactly by
 *   crashReturnPpmV5 below in BigInt fixed point). Every cash-out target then
 *   returns R B: 1.006430 on a standard round, 1.137983 on a Super award with
 *   the add-on. Earlier contracts return 0.80 (800,000 millionths).
 *
 * THE MINIMUM COMES OUT OF THE ODDS (migration 20260919034436, and the reason
 * the header above used to be wrong). Every live round funds a minimum and pays
 * for it by crashing sooner. Under contract 4 that minimum is HALF the stake on
 * an ordinary award, and on a Super award with the Double Diamonds add-on the
 * two thirds the player actually paid, so rounds end sooner than they did under
 * the tenth: 1 in 2 of them never reach 1.11x at all, against 1 in 4.3 under
 * the tenth and 1 in 4.8 with no minimum at all. Only rounds sealed
 * before that migration have L = 0, where this reduces to
 * floor(80 * 2^48 / (r + 1)) and P(X >= x) = 0.8 / x. A check that assumes no
 * minimum disagrees with four of six award rounds, so the bet and the minimum
 * are required inputs here, never defaulted, and the contract the round was
 * sealed under decides both floors.
 *
 * Byte for byte the mapping of supabase/migrations/20260908010241, the minimum
 * of 20260919034436 (fn_crash_point_cents(roll, bet, minimum)) and the 1.10x
 * floor of 20260921203512. The unit tests pin this file to vectors computed by
 * production Postgres.
 */

import { hmacSha256Hex, rollFromHmacHex, sha256Hex } from './wheelFairness';
import { diamondBonusFloor, diamondBonusMinimum } from './diamondBonusPayout';
import { MAX_DIAMOND_SPIN, MIN_DIAMOND_SPIN } from './bonusGameBudget';

const TWO_48 = 281474976710656n;

/** The contract every crash round sealed since 2026-10-12 carries (migration
 * 20261012140447). Rounds sealed under 4 and earlier keep their own rules. */
export const CRASH_PAYOUT_VERSION = 5;
/** The contract that first floored the point (1.10x) and stated its floors on every receipt. */
export const CRASH_FLOORED_VERSION = 4;
/** The lowest crash point a round of this contract can seal: 1.00x before
 * contract 4, 1.10x under it, 1.25x from contract 5. Mirrors the GREATEST in
 * fn_crash_point_cents (contract 4) and fn_crash_point_cents_v5. */
export function crashPointFloorCents(payoutVersion?: number): number {
  const v = payoutVersion ?? 0;
  return v >= 5 ? 125 : v >= CRASH_FLOORED_VERSION ? 110 : 100;
}
/** The first multiplier a round of this contract may cash out at: 1.01x before
 * contract 4, 1.11x under it, 1.26x from contract 5. Mirrors fn_crash_decide and
 * fn_crash_cashout. */
export function crashCashoutFloorCents(payoutVersion?: number): number {
  const v = payoutVersion ?? 0;
  return v >= 5 ? 126 : v >= CRASH_FLOORED_VERSION ? 111 : 101;
}
/** The cap of every flight sealed under contract 5: 20.00x (Dan, 2026-10-12). */
export const CRASH_CAP_CENTS = 2000;
/** The average crash contract 5 is built to (Dan: "BETWEEN 2.4 -3.0X"): 2.9x. */
export const CRASH_TARGET_AVERAGE = 2.9;
/** The return every contract before 5 plays: 0.80, in millionths. */
export const CRASH_V4_RETURN_PPM = 800000;
/** Ruling 2's floor and ruling 4's ceiling on a contract-5 return, in millionths. */
export const CRASH_RETURN_PPM_MIN = 950000;
export const CRASH_RETURN_PPM_MAX = 1200000;

/** Fixed point for the logarithm: fifty decimal places, ten more than Postgres's forty. */
const LN_ONE = 10n ** 50n;
/** atanh(z) * LN_ONE for a fixed-point 0 <= z < 1/3, by its odd power series. */
function atanhFixed(z: bigint): bigint {
  const z2 = (z * z) / LN_ONE;
  let term = z;
  let sum = 0n;
  for (let n = 1n; term !== 0n; n += 2n) {
    sum += term / n;
    term = (term * z2) / LN_ONE;
  }
  return sum;
}
const LN2_FIXED = 2n * atanhFixed(LN_ONE / 3n);
/** ln(num / den) * LN_ONE for num > den > 0: halve into [1, 2), then 2 atanh((y - 1)/(y + 1)). */
function lnFixed(num: bigint, den: bigint): bigint {
  if (den <= 0n || num <= den) throw new Error('Invalid Crash Outcome');
  let k = 0n;
  let d = den;
  while (num >= 2n * d) {
    d *= 2n;
    k += 1n;
  }
  return k * LN2_FIXED + 2n * atanhFixed(((num - d) * LN_ONE) / (num + d));
}

/**
 * A contract-5 round's return R in millionths, from its own sealed stake and
 * minimum (Dan, 2026-10-12): floor(10^6 (L + 1.65 / ln((20 - L) / (1.25 - L)))),
 * clamped to 950,000..1,200,000. Byte for byte fn_crash_return_ppm_v5: in chip
 * cents B and M, (20 - L) / (1.25 - L) = (80B - 4M) / (5B - 4M). Both sides
 * carry far more digits than the floor needs (forty there, fifty here), so they
 * agree on every stake a round can be played at; the unit test checks every
 * one against Postgres.
 */
export function crashReturnPpmV5(betChips: number, minimumPayoutChips: number): number {
  const b = BigInt(Math.round(betChips * 100));
  const m = BigInt(Math.round(minimumPayoutChips * 100));
  if (b <= 0n || m < 0n || m * 5n >= b * 4n) throw new Error('Invalid Crash Outcome');
  // R depends on L = M / B alone, so one reduced fraction is one computation.
  const g = gcd(m, b);
  const key = `${m / g}/${b / g}`;
  const known = RETURN_BY_SHARE.get(key);
  if (known !== undefined) return known;
  const ln = lnFixed(80n * b - 4n * m, 5n * b - 4n * m);
  const share = (1000000n * m * LN_ONE) / b;
  const lift = (1650000n * LN_ONE * LN_ONE) / ln;
  const ppm = Number((share + lift) / LN_ONE);
  const ret = Math.min(CRASH_RETURN_PPM_MAX, Math.max(CRASH_RETURN_PPM_MIN, ppm));
  RETURN_BY_SHARE.set(key, ret);
  return ret;
}
const RETURN_BY_SHARE = new Map<string, number>();
function gcd(a: bigint, b: bigint): bigint {
  while (b !== 0n) [a, b] = [b, a % b];
  return a === 0n ? 1n : a;
}

/** The return a round of this contract plays at every cash-out target, in millionths of its stake. */
export function crashReturnPpm(
  betChips: number,
  minimumPayoutChips: number,
  payoutVersion?: number
): number {
  return (payoutVersion ?? 0) >= 5
    ? crashReturnPpmV5(betChips, minimumPayoutChips)
    : CRASH_V4_RETURN_PPM;
}

export interface PlinkoPath {
  /** One entry per row, 0 = left, 1 = right, row 0 first. */
  bits: number[];
  /** The sixteen bits packed little-endian, as the server stores path_bits. */
  pathBits: number;
  /** Number of rights: the landing slot, 0..16. */
  slot: number;
}

/** Read the ball's path from the HMAC the way Postgres get_bit does. */
export function plinkoPathFromHmacHex(hmacHex: string, rows = 16): PlinkoPath {
  const bits: number[] = [];
  let pathBits = 0;
  let slot = 0;
  for (let i = 0; i < rows; i++) {
    const byte = parseInt(hmacHex.slice((i >> 3) * 2, (i >> 3) * 2 + 2), 16);
    const bit = (byte >> (i & 7)) & 1;
    bits.push(bit);
    if (bit) {
      pathBits |= 1 << i;
      slot += 1;
    }
  }
  return { bits, pathBits, slot };
}

/** Unpack a stored path_bits integer into per-row bits. */
export function plinkoBitsFromPathBits(pathBits: number, rows = 16): number[] {
  const bits: number[] = [];
  for (let i = 0; i < rows; i++) bits.push((pathBits >> i) & 1);
  return bits;
}

/**
 * The sealed crash point in cents: floor(100 * (L + (R - L) * 2^48 / (roll + 1))),
 * floored at the contract's own floor (1.00x, 1.10x under contract 4, 1.25x from
 * contract 5), for a stake, the minimum sealed with it and the contract's return
 * R in millionths (800,000 through contract 4; crashReturnPpmV5 from contract 5).
 * Exact BigInt arithmetic: the same integer division as fn_crash_point_cents
 * (contract 4) and fn_crash_point_cents_v5 (contract 5, Postgres div on integer
 * chip cents). The bet and the minimum are required: a round that funds a
 * minimum does not recompute without it, and a defaulted zero is how a
 * third-party check came to disagree with four of six award rounds (fairness
 * audit 2026-09-22).
 */
export function crashPointCentsFromRoll(
  roll: number | bigint,
  betChips: number,
  minimumPayoutChips: number,
  pointFloorCents = 100,
  returnPpm = CRASH_V4_RETURN_PPM
): number {
  if (!Number.isFinite(betChips) || !Number.isFinite(minimumPayoutChips))
    throw new Error('A Crash Round Is Checked With Its Bet And Its Minimum');
  const r = BigInt(roll);
  if (r < 0n || r >= TWO_48) throw new Error('Invalid Crash Outcome');
  if (!Number.isSafeInteger(returnPpm) || returnPpm < 1 || returnPpm > CRASH_RETURN_PPM_MAX)
    throw new Error('Invalid Crash Outcome');
  const ret = BigInt(returnPpm);
  const betCents = BigInt(Math.round(betChips * 100));
  const minimumCents = BigInt(Math.round(minimumPayoutChips * 100));
  // The minimum is always under 0.80 of the stake (fn_diamond_bonus_floor clamps a
  // cent below it), so it is under the contract's return on every contract.
  if (betCents <= 0n || minimumCents < 0n || minimumCents * 5n >= betCents * 4n)
    throw new Error('Invalid Crash Outcome');
  // L + (R B - L) / P preserves the same expectation R B with a guaranteed L.
  // With L = 0 and R = 0.80 this is floor(80 * 2^48 / (r + 1)), the launch game.
  const cents =
    (100n *
      (1000000n * minimumCents * (r + 1n) + (ret * betCents - 1000000n * minimumCents) * TWO_48)) /
    (1000000n * betCents * (r + 1n));
  if (!Number.isInteger(pointFloorCents) || pointFloorCents < 100)
    throw new Error('Invalid Crash Outcome');
  return cents < BigInt(pointFloorCents) ? pointFloorCents : Number(cents);
}

/** The sealed crash point of a round under its own contract: floor and return both read from the version. */
export function crashPointCentsForContract(
  roll: number | bigint,
  betChips: number,
  minimumPayoutChips: number,
  payoutVersion?: number
): number {
  return crashPointCentsFromRoll(
    roll,
    betChips,
    minimumPayoutChips,
    crashPointFloorCents(payoutVersion),
    crashReturnPpm(betChips, minimumPayoutChips, payoutVersion)
  );
}

/**
 * How many of the 2^48 rolls seal a point of at least `targetCents` (above the
 * contract's floor): floor(100 (R B - 10^6 M) 2^48 / (10^6 (t B - 100 M))), at
 * most every roll. The one count the odds, the return and the average all rest
 * on, in the same integers as fn_crash_point_cents(_v5).
 */
export function crashRollsReaching(
  targetCents: number,
  betChips: number,
  minimumPayoutChips: number,
  returnPpm: number
): bigint {
  const b = BigInt(Math.round(betChips * 100));
  const m = BigInt(Math.round(minimumPayoutChips * 100));
  const t = BigInt(targetCents);
  const rolls =
    (100n * (BigInt(returnPpm) * b - 1000000n * m) * TWO_48) / (1000000n * (t * b - 100n * m));
  return rolls > TWO_48 ? TWO_48 : rolls;
}

/** The curve: floor(e^(k t) * 100) cents, clamped at the cap. t in milliseconds. */
export function crashMultiplierCents(growthK: number, elapsedMs: number, capCents: number): number {
  const t = Math.max(0, elapsedMs) / 1000;
  const raw = Math.floor(Math.exp(Math.min(growthK * t, 12)) * 100);
  return Math.min(capCents, raw);
}

/** Seconds until the curve reaches a multiplier (cents) at growth k. */
export function crashSecondsToReach(growthK: number, cents: number): number {
  return Math.log(Math.max(100, cents) / 100) / growthK;
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE CRASH ODDS A PLAYER READS ARE THE ODDS THE SERVER PLAYS (2026-09-22)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The chance a round never reaches `targetCents`, given the stake, the minimum
 * the server seals into it and the crash floor of its own contract. With
 * X = max(F, L + (0.8 - L) / u) that is 1 - (0.8 - L) / (x - L) above F and
 * zero at or below it, and the instant crash - the round dies before the first
 * hundredth a cash-out can bind, and pays only its minimum - is this at that
 * hundredth: 101 before contract 4, 111 from it.
 *
 * The minimum is paid for out of the odds, so the larger it is the sooner
 * rounds end: 1 in 4.8 at L = 0 (the no-minimum game the lobby was still
 * describing as "1 In 5"), 1 in 4.3 at a tenth of the stake, 1 in 2 at the half
 * contract 4 guarantees, 1 in 1.4 at the two thirds a Super award with the
 * add-on paid. Under contract 5 the return R is 0.95 and the floor 1.25x, so
 * the formula is 1 - (R - L) / (x - L): 1 in 2.5 at the half, 1 in 1.9 at the
 * two thirds. One function, used by every page that prints a figure; the unit
 * test counts the rolls crashPointCentsFromRoll actually seals below the target
 * and agrees with it to the 48-bit grain.
 */
export function crashMissChance(
  targetCents: number,
  betChips: number,
  minimumPayoutChips: number,
  pointFloorCents = 100,
  returnPpm = CRASH_V4_RETURN_PPM
): number {
  if (
    !Number.isFinite(targetCents) ||
    !Number.isFinite(betChips) ||
    !Number.isFinite(minimumPayoutChips) ||
    betChips <= 0 ||
    minimumPayoutChips < 0 ||
    minimumPayoutChips * 5 >= betChips * 4 ||
    !Number.isInteger(pointFloorCents) ||
    pointFloorCents < 100 ||
    !Number.isSafeInteger(returnPpm) ||
    returnPpm < 1 ||
    returnPpm > CRASH_RETURN_PPM_MAX
  )
    throw new Error('Invalid Crash Outcome');
  // Nothing below the contract's own crash floor can be missed: max(raw, F) >= x
  // is certain for every x at or under F, and above it max(raw, F) >= x iff
  // raw >= x, which leaves the identity untouched.
  if (targetCents <= pointFloorCents) return 0;
  const share = minimumPayoutChips / betChips;
  return 1 - (returnPpm / 1e6 - share) / (targetCents / 100 - share);
}

/** The round dies before a cash-out can bind: it never reaches the first
 * hundredth this contract lets a player book (1.01x, 1.11x under contract 4,
 * 1.26x from contract 5), and pays only its minimum. */
export const crashInstantChance = (
  betChips: number,
  minimumPayoutChips: number,
  payoutVersion?: number
): number =>
  crashMissChance(
    crashCashoutFloorCents(payoutVersion),
    betChips,
    minimumPayoutChips,
    crashPointFloorCents(payoutVersion),
    crashReturnPpm(betChips, minimumPayoutChips, payoutVersion)
  );

/**
 * THE AVERAGE CRASH (Dan, 2026-10-12: "MAKE SURE THAT PLAYERS ARE AWARE THAT
 * THE 'AVERAGE CRASH' IS BETWEEN 2.4 -3.0X"). The exact mean of where a round
 * of these terms ends, min(point, cap), from the round's own stake, sealed
 * minimum, contract and cap - never a typed figure. The point is sealed in
 * whole hundredths, so the mean is the floor plus, for every hundredth t above
 * it up to the cap, the share of rolls that reach t:
 *   E = F + sum over t of crashRollsReaching(t) / 2^48, in hundredths.
 * Contract 5 chooses R so the continuous version of that, 1.25 + (R - L)
 * ln((20 - L)/(1.25 - L)), is 2.9; the exact figure is a few thousandths under
 * it (2.8968 on a standard round, 2.8961 on a Super award with the add-on) and
 * prints as 2.9x. A floor clamped at the 1.20 return reads its own, lower mean.
 */
export function crashAverageMultiplier(
  betChips: number,
  minimumPayoutChips: number,
  payoutVersion: number | undefined,
  capCents: number
): number {
  if (
    !Number.isFinite(betChips) ||
    !Number.isFinite(minimumPayoutChips) ||
    !Number.isSafeInteger(capCents) ||
    betChips <= 0 ||
    minimumPayoutChips < 0 ||
    minimumPayoutChips * 5 >= betChips * 4
  )
    throw new Error('Invalid Crash Outcome');
  const floor = crashPointFloorCents(payoutVersion);
  if (capCents <= floor) return capCents / 100;
  const ret = crashReturnPpm(betChips, minimumPayoutChips, payoutVersion);
  // The count depends on M / B, the return, the floor and the cap alone, and a
  // page asks for the same terms on every render: one walk per set of terms.
  const b = Math.round(betChips * 100);
  const m = Math.round(minimumPayoutChips * 100);
  const g = Number(gcd(BigInt(m), BigInt(b)));
  const key = `${m / g}/${b / g}:${ret}:${floor}:${capCents}`;
  const known = AVERAGE_BY_TERMS.get(key);
  if (known !== undefined) return known;
  let reached = BigInt(floor) * TWO_48;
  for (let t = floor + 1; t <= capCents; t++)
    reached += crashRollsReaching(t, betChips, minimumPayoutChips, ret);
  // Hundredths of a hundredth are far below one decimal; Number keeps fifteen digits.
  const average = Number((reached * 1000000n) / TWO_48) / 100000000;
  AVERAGE_BY_TERMS.set(key, average);
  return average;
}
const AVERAGE_BY_TERMS = new Map<string, number>();

/**
 * The same mean in floating point, for pages that price every stake at once (the
 * lobby walks about five thousand). Each roll count is replaced by its exact
 * share, min(1, (R - L)/(t - L)), which differs from the sealed count by under
 * one roll in 2^48, so across the 1,875 hundredths to 20x this agrees with
 * crashAverageMultiplier to better than 1e-11 (pinned in the unit test).
 */
export function crashAverageFromShare(
  share: number,
  returnPpm: number,
  floorCents: number,
  capCents: number
): number {
  if (capCents <= floorCents) return capCents / 100;
  const ret = returnPpm / 1e6;
  let mean = floorCents / 100;
  for (let t = floorCents + 1; t <= capCents; t++)
    mean += Math.min(1, (ret - share) / (t / 100 - share)) / 100;
  return mean;
}

/** "Average Crash 2.9x": the average a player reads, to one decimal. */
export function crashAverageLabel(averageMultiplier: number): string {
  if (!Number.isFinite(averageMultiplier) || averageMultiplier < 1)
    throw new Error('Invalid Crash Outcome');
  return `Average Crash ${averageMultiplier.toFixed(1)}x`;
}

/** "Up To 20x": the most this round can fly to, from its own cap. */
export function crashCapLabel(capCents: number): string {
  if (!Number.isSafeInteger(capCents) || capCents < 100) throw new Error('Invalid Crash Outcome');
  return `Up To ${multiplierLabel(capCents)}`;
}

/** After a booked win, where the sealed point says the flight was going (Dan: "HOW FAR 'IT WOULD OF GONE'"). */
export function crashWouldHaveLabel(crashCents: number, capCents: number): string {
  if (!Number.isSafeInteger(crashCents) || !Number.isSafeInteger(capCents))
    throw new Error('Invalid Crash Outcome');
  return crashCents >= capCents
    ? `It Would Have Reached ${multiplierLabel(capCents)}`
    : `It Would Have Crashed At ${(crashCents / 100).toFixed(2)}x`;
}

/** A chance as the player reads it: "1 In 4.3", to one decimal, "1 In 2" when it is whole. */
export function oneInLabel(chance: number): string {
  if (!Number.isFinite(chance) || chance <= 0 || chance > 1) throw new Error('Invalid Chance');
  return `1 In ${oneInFigure(chance)}`;
}

/** The same, over a set of chances: "1 In 4.2 To 4.3", or one figure when both ends read alike. */
export function oneInRangeLabel(chances: { most: number; least: number }): string {
  const often = oneInFigure(chances.most);
  const rarely = oneInFigure(chances.least);
  return often === rarely ? `1 In ${often}` : `1 In ${often} To ${rarely}`;
}

function oneInFigure(chance: number): string {
  if (!Number.isFinite(chance) || chance <= 0 || chance > 1) throw new Error('Invalid Chance');
  const rounded = Math.round(10 / chance) / 10;
  return rounded.toLocaleString('en-US', {
    minimumFractionDigits: Number.isInteger(rounded) ? 0 : 1,
    maximumFractionDigits: 1,
  });
}

/**
 * Every stake a wheel award of this kind can play Crash at, and what each one's
 * instant crash costs. fn_diamond_game_admit takes an award's base (the wheel
 * entry times its boost) or that base plus the entry once more for Double Down,
 * and fn_crash_start seals the floor on whichever was played, rounded up to the
 * chip cent - so a small odd stake keeps a little more than its share and dies
 * before the cash-out opens a little more often. The ends of that range are what
 * the lobby prints, never a single figure that is true for one entry and wrong
 * for the next.
 *
 * CONTRACTS 4 AND 5. The floor is fn_diamond_bonus_floor: half the stake
 * ordinarily, and for a Super award the greater of that half and what the
 * player PAID - the spin entry, plus the entry again when the Double Diamonds
 * add-on was taken. That is two thirds of a doubled Super stake, so under
 * contract 5 a Super award with the add-on ends before 1.26x about one round
 * in two, and the lobby says so. `payoutVersion` is here so a page reading an
 * older award still prices it by the rule it was sealed with.
 */
export function awardInstantCrashChances(
  boost: 1 | 2,
  diamondsPerChip: number,
  payoutVersion: number = CRASH_PAYOUT_VERSION
): { most: number; least: number } {
  if (!Number.isFinite(diamondsPerChip) || diamondsPerChip <= 0)
    throw new Error('Invalid Crash Outcome');
  let most = 0;
  let least = 1;
  for (let entry = MIN_DIAMOND_SPIN; entry <= MAX_DIAMOND_SPIN; entry++) {
    for (const stake of [entry * boost, entry * boost + entry]) {
      const betChips = Math.round((stake * 100) / diamondsPerChip) / 100;
      // What the player paid for this stake, exactly as fn_diamond_game_paid_diamonds
      // computes it: the spin entry, plus whatever the add-on put on top of the base.
      const paid = entry + (stake - entry * boost);
      const floor =
        payoutVersion >= CRASH_FLOORED_VERSION
          ? diamondBonusFloor(betChips, boost, paid, diamondsPerChip)
          : diamondBonusMinimum(betChips, boost);
      const chance = crashInstantChance(betChips, floor, payoutVersion);
      if (chance > most) most = chance;
      if (chance < least) least = chance;
    }
  }
  return { most, least };
}

/**
 * The average crash across every stake a wheel award of this kind can be played
 * at (the same walk awardInstantCrashChances makes), at the cap the contract
 * deals. A standard contract-5 award reads 2.7x at every entry; a Super award
 * reads 2.7x without the add-on (its floor is half the stake, like a standard
 * one) and 2.2x with it (two thirds), and the lobby prints that range rather
 * than a figure that is true for one stake and wrong for the next.
 */
export function awardAverageCrash(
  boost: 1 | 2,
  diamondsPerChip: number,
  payoutVersion: number,
  capCents: number
): { low: number; high: number } {
  if (!Number.isFinite(diamondsPerChip) || diamondsPerChip <= 0)
    throw new Error('Invalid Crash Outcome');
  let low = Infinity;
  let high = 0;
  for (let entry = MIN_DIAMOND_SPIN; entry <= MAX_DIAMOND_SPIN; entry++) {
    for (const stake of [entry * boost, entry * boost + entry]) {
      const betChips = Math.round((stake * 100) / diamondsPerChip) / 100;
      const paid = entry + (stake - entry * boost);
      const floor =
        payoutVersion >= CRASH_FLOORED_VERSION
          ? diamondBonusFloor(betChips, boost, paid, diamondsPerChip)
          : diamondBonusMinimum(betChips, boost);
      const average = crashAverageFromShare(
        Math.round(floor * 100) / Math.round(betChips * 100),
        crashReturnPpm(betChips, floor, payoutVersion),
        crashPointFloorCents(payoutVersion),
        capCents
      );
      if (average < low) low = average;
      if (average > high) high = average;
    }
  }
  return { low, high };
}

/** "2.7x", or "2.2x To 2.6x" when the ends of a range read differently at one decimal. */
export function averageRangeLabel(range: { low: number; high: number }): string {
  const lo = range.low.toFixed(1);
  const hi = range.high.toFixed(1);
  return lo === hi ? `${lo}x` : `${lo}x To ${hi}x`;
}

export interface PlinkoFairnessInput {
  serverSeed: string;
  serverSeedHash: string;
  clientSeed: string;
  nonce: number;
  hmacHex: string;
  slot: number;
  pathBits: number;
}

export interface PlinkoFairnessVerdict {
  hashMatches: boolean;
  hmacMatches: boolean;
  pathMatches: boolean;
  fair: boolean;
  computedHash: string;
  computedHmac: string;
  computedPath: PlinkoPath;
}

export async function verifyPlinkoDrop(input: PlinkoFairnessInput): Promise<PlinkoFairnessVerdict> {
  const computedHash = await sha256Hex(input.serverSeed);
  const computedHmac = await hmacSha256Hex(input.serverSeed, `${input.clientSeed}:${input.nonce}`);
  const computedPath = plinkoPathFromHmacHex(computedHmac);
  const hashMatches = computedHash === input.serverSeedHash.toLowerCase();
  const hmacMatches = computedHmac === input.hmacHex.toLowerCase();
  const pathMatches = computedPath.slot === input.slot && computedPath.pathBits === input.pathBits;
  return {
    hashMatches,
    hmacMatches,
    pathMatches,
    fair: hashMatches && hmacMatches && pathMatches,
    computedHash,
    computedHmac,
    computedPath,
  };
}

export interface CrashFairnessInput {
  serverSeed: string;
  serverSeedHash: string;
  clientSeed: string;
  nonce: number;
  roll: number;
  crashCents: number;
  /** The round's stake in chips (bet_chips). Required: the crash point is a share of it. */
  betChips: number;
  /** The minimum sealed into the round (minimum_payout_chips); 0 only before 20260919034436. */
  minimumPayoutChips: number;
  /** The contract the round was sealed under; absent before 2026-09-19. */
  payoutVersion?: number;
}

export interface CrashFairnessVerdict {
  hashMatches: boolean;
  rollMatches: boolean;
  crashMatches: boolean;
  fair: boolean;
  computedHash: string;
  computedRoll: number;
  computedCrashCents: number;
}

export async function verifyCrashRound(input: CrashFairnessInput): Promise<CrashFairnessVerdict> {
  const computedHash = await sha256Hex(input.serverSeed);
  const hmac = await hmacSha256Hex(input.serverSeed, `${input.clientSeed}:${input.nonce}`);
  const computedRoll = rollFromHmacHex(hmac);
  const computedCrashCents = crashPointCentsForContract(
    computedRoll,
    input.betChips,
    input.minimumPayoutChips,
    input.payoutVersion
  );
  const hashMatches = computedHash === input.serverSeedHash.toLowerCase();
  const rollMatches = computedRoll === input.roll;
  const crashMatches = computedCrashCents === input.crashCents;
  return {
    hashMatches,
    rollMatches,
    crashMatches,
    fair: hashMatches && rollMatches && crashMatches,
    computedHash,
    computedRoll,
    computedCrashCents,
  };
}

/** Binomial odds of each of the 17 slots on a 16-row board, C(16,k) / 65536. */
export const PLINKO_SLOT_WEIGHTS = [
  1, 16, 120, 560, 1820, 4368, 8008, 11440, 12870, 11440, 8008, 4368, 1820, 560, 120, 16, 1,
] as const;
export const PLINKO_WEIGHT_TOTAL = 65536;

/** Format a multiplier in cents as a label: 100 -> "1x", 995 -> "9.95x", 100000 -> "1000x". */
export function multiplierLabel(cents: number): string {
  const whole = Math.floor(cents / 100);
  const frac = cents % 100;
  if (frac === 0) return `${whole}x`;
  return `${whole}.${String(frac).padStart(2, '0').replace(/0$/, '')}x`;
}
