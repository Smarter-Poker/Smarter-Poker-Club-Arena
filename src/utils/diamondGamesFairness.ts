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
 *   CONTRACT 5 (Dan, 2026-10-12, migration 20261012052305): "CRASH CAN BE A 5%
 *   HOUSE EDGE GAME". The return is 0.95 where it was 0.80, the floor is 125
 *   (1.25x) and cash out opens at 1.26x, so X = max(1.25, L + (0.95 - L) / u)
 *   and every cash-out target returns 0.95B. The return is carried in
 *   twentieths (16 = 0.80, 19 = 0.95) so the arithmetic stays in integers.
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
 * 20261012052305). Rounds sealed under 4 and earlier keep their own rules. */
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
/** What every cash-out target returns, in twentieths of the stake: 16 (0.80)
 * through contract 4, 19 (0.95) from contract 5 (Dan, 2026-10-12: "CRASH CAN BE
 * A 5% HOUSE EDGE GAME"). */
export function crashReturnTwentieths(payoutVersion?: number): number {
  return (payoutVersion ?? 0) >= 5 ? 19 : 16;
}
/** The cap of every flight sealed under contract 5: 20.00x (Dan, 2026-10-12). */
export const CRASH_CAP_CENTS = 2000;

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
 * R in twentieths (16 = 0.80 through contract 4, 19 = 0.95 from contract 5).
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
  returnTwentieths = 16
): number {
  if (!Number.isFinite(betChips) || !Number.isFinite(minimumPayoutChips))
    throw new Error('A Crash Round Is Checked With Its Bet And Its Minimum');
  const r = BigInt(roll);
  if (r < 0n || r >= TWO_48) throw new Error('Invalid Crash Outcome');
  if (returnTwentieths !== 16 && returnTwentieths !== 19) throw new Error('Invalid Crash Outcome');
  const ret = BigInt(returnTwentieths);
  const betCents = BigInt(Math.round(betChips * 100));
  const minimumCents = BigInt(Math.round(minimumPayoutChips * 100));
  // The minimum is always under 0.80 of the stake (fn_diamond_bonus_floor clamps a
  // cent below it), so it is under the contract's return on every contract.
  if (betCents <= 0n || minimumCents < 0n || minimumCents * 5n >= betCents * 4n)
    throw new Error('Invalid Crash Outcome');
  // L + (R B - L) / P preserves the same expectation R B with a guaranteed L.
  // With L = 0 and R = 0.80 this is floor(80 * 2^48 / (r + 1)), the launch game.
  const cents =
    (100n * (20n * minimumCents * (r + 1n) + (ret * betCents - 20n * minimumCents) * TWO_48)) /
    (20n * betCents * (r + 1n));
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
    crashReturnTwentieths(payoutVersion)
  );
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
  returnTwentieths = 16
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
    (returnTwentieths !== 16 && returnTwentieths !== 19)
  )
    throw new Error('Invalid Crash Outcome');
  // Nothing below the contract's own crash floor can be missed: max(raw, F) >= x
  // is certain for every x at or under F, and above it max(raw, F) >= x iff
  // raw >= x, which leaves the identity untouched.
  if (targetCents <= pointFloorCents) return 0;
  const share = minimumPayoutChips / betChips;
  return 1 - (returnTwentieths / 20 - share) / (targetCents / 100 - share);
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
    crashReturnTwentieths(payoutVersion)
  );

/**
 * THE AVERAGE CRASH (Dan, 2026-10-12: "MAKE SURE THAT PLAYERS ARE AWARE THAT
 * THE 'AVERAGE CRASH' IS BETWEEN 2.4 - 3.0X"). The mean of where a round of
 * these terms ends, min(X, cap), computed from the round's own stake, minimum,
 * contract and cap - never a typed figure. With P(X >= x) = min(1, (R - L)/(x - L))
 * above the floor F, E[min(X, C)] = F + the integral of that survival from F
 * to C, which is F + (R - L) ln((C - L)/(F - L)) whenever F >= R (every
 * contract here). A standard round of contract 5 (L = half) averages 2.72x; a
 * Super award with the add-on keeps two thirds of its stake and pays for it out
 * of the odds, so it averages 2.24x, and that is the figure it shows. The
 * point is sealed in whole hundredths, which lowers the mean by under half a
 * hundredth; the page prints one decimal.
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
    !Number.isFinite(capCents) ||
    betChips <= 0 ||
    minimumPayoutChips < 0 ||
    minimumPayoutChips * 5 >= betChips * 4
  )
    throw new Error('Invalid Crash Outcome');
  const floor = crashPointFloorCents(payoutVersion) / 100;
  const cap = capCents / 100;
  if (cap <= floor) return cap;
  const ret = crashReturnTwentieths(payoutVersion) / 20;
  const share = minimumPayoutChips / betChips;
  // Below R a round has certainly not ended yet; above it the survival is (R - L)/(x - L).
  const certain = Math.min(cap, Math.max(floor, ret));
  return certain + (ret - share) * Math.log((cap - share) / (certain - share));
}

/** "Average Crash 2.7x": the average a player reads, to one decimal. */
export function crashAverageLabel(averageMultiplier: number): string {
  if (!Number.isFinite(averageMultiplier) || averageMultiplier < 1)
    throw new Error('Invalid Crash Outcome');
  return `Average Crash ${averageMultiplier.toFixed(1)}x`;
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
      const average = crashAverageMultiplier(betChips, floor, payoutVersion, capCents);
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
