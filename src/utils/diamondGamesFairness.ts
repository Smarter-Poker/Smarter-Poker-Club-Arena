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
 *   X = max(1.00x, L + (0.8 - L) / u), in cents floor(100 * X), so for any
 *   target x above 1.00x, P(X >= x) = (0.8 - L) / (x - L).
 *
 * THE MINIMUM COMES OUT OF THE ODDS (migration 20260919034436, and the reason
 * the header above used to be wrong). Every live round funds a minimum - a
 * tenth of the stake on an ordinary wheel award, half on a Super one - and
 * pays for it by crashing sooner: 1 in 4.8 of them never reach 1.01x at all
 * against 1 in 4.3 with a tenth and 1 in 2.4 with a half. Only rounds sealed
 * before that migration have L = 0, where this reduces to
 * floor(80 * 2^48 / (r + 1)) and P(X >= x) = 0.8 / x. A check that assumes no
 * minimum disagrees with four of six award rounds, so the bet and the minimum
 * are required inputs here, never defaulted.
 *
 * Byte for byte the mapping of supabase/migrations/20260908010241 and the
 * minimum of 20260919034436 (fn_crash_point_cents(roll, bet, minimum)). The
 * unit tests pin this file to vectors computed by production Postgres.
 */

import { hmacSha256Hex, rollFromHmacHex, sha256Hex } from './wheelFairness';
import { diamondBonusMinimum } from './diamondBonusPayout';
import { MAX_DIAMOND_SPIN, MIN_DIAMOND_SPIN } from './bonusGameBudget';

const EIGHTY_TIMES_TWO_48 = 22517998136852480n; // 80 * 2^48

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
 * The sealed crash point in cents: floor(100 * (L + (0.8 - L) * 2^48 / (roll + 1))),
 * floored at 1.00x, for a stake and the minimum sealed with it. Exact BigInt
 * arithmetic, the same integer division as fn_crash_point_cents(roll, bet, minimum).
 * Both are required: a round that funds a minimum does not recompute without it,
 * and a defaulted zero is how a third-party check came to disagree with four of
 * six award rounds (fairness audit 2026-09-22).
 */
export function crashPointCentsFromRoll(
  roll: number | bigint,
  betChips: number,
  minimumPayoutChips: number
): number {
  if (!Number.isFinite(betChips) || !Number.isFinite(minimumPayoutChips))
    throw new Error('A Crash Round Is Checked With Its Bet And Its Minimum');
  const r = BigInt(roll);
  if (r < 0n || r >= 281474976710656n) throw new Error('Invalid Crash Outcome');
  const betCents = BigInt(Math.round(betChips * 100));
  const minimumCents = BigInt(Math.round(minimumPayoutChips * 100));
  if (betCents <= 0n || minimumCents < 0n || minimumCents * 5n >= betCents * 4n)
    throw new Error('Invalid Crash Outcome');
  // L + (0.8 B - L) / P preserves the same expectation with a guaranteed L.
  const cents =
    minimumCents === 0n
      ? EIGHTY_TIMES_TWO_48 / (r + 1n)
      : (100n *
          (5n * minimumCents * (r + 1n) + (4n * betCents - 5n * minimumCents) * 281474976710656n)) /
        (5n * betCents * (r + 1n));
  return cents < 100n ? 100 : Number(cents);
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
 * The chance a round never reaches `targetCents`, given the stake and the
 * minimum the server seals into it. With X = L + (0.8 - L) / u that is
 * 1 - (0.8 - L) / (x - L), and the instant crash - the round dies at 1.00x,
 * below 1.01x, the first hundredth a cash-out can bind, and pays only its
 * minimum - is this at 101.
 *
 * The minimum is paid for out of the odds, so the larger it is the sooner
 * rounds end: 1 in 4.8 at L = 0 (the no-minimum game the lobby was still
 * describing as "1 In 5"), 1 in 4.3 at a tenth of the stake, 1 in 2.4 at a
 * half. One function, used by every page that prints a figure; the unit test
 * counts the rolls crashPointCentsFromRoll actually seals below the target and
 * agrees with it to the 48-bit grain.
 */
export function crashMissChance(
  targetCents: number,
  betChips: number,
  minimumPayoutChips: number
): number {
  if (
    !Number.isFinite(targetCents) ||
    !Number.isFinite(betChips) ||
    !Number.isFinite(minimumPayoutChips) ||
    betChips <= 0 ||
    minimumPayoutChips < 0 ||
    minimumPayoutChips * 5 >= betChips * 4
  )
    throw new Error('Invalid Crash Outcome');
  if (targetCents <= 100) return 0;
  const share = minimumPayoutChips / betChips;
  return 1 - (0.8 - share) / (targetCents / 100 - share);
}

/** The round crashes at 1.00x: it never reaches 1.01x, the first hundredth a cash-out binds. */
export const crashInstantChance = (betChips: number, minimumPayoutChips: number): number =>
  crashMissChance(101, betChips, minimumPayoutChips);

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
 * and fn_crash_start seals fn_diamond_bonus_minimum's minimum on whichever was
 * played, rounded up to the chip cent - so a small odd stake keeps a little more
 * than its share and crashes at 1.00x a little more often. The ends of that
 * range are what the lobby prints, never a single figure that is true for one
 * entry and wrong for the next.
 */
export function awardInstantCrashChances(
  boost: 1 | 2,
  diamondsPerChip: number
): { most: number; least: number } {
  if (!Number.isFinite(diamondsPerChip) || diamondsPerChip <= 0)
    throw new Error('Invalid Crash Outcome');
  let most = 0;
  let least = 1;
  for (let entry = MIN_DIAMOND_SPIN; entry <= MAX_DIAMOND_SPIN; entry++) {
    for (const stake of [entry * boost, entry * boost + entry]) {
      const betChips = Math.round((stake * 100) / diamondsPerChip) / 100;
      const chance = crashInstantChance(betChips, diamondBonusMinimum(betChips, boost));
      if (chance > most) most = chance;
      if (chance < least) least = chance;
    }
  }
  return { most, least };
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
  const computedCrashCents = crashPointCentsFromRoll(
    computedRoll,
    input.betChips,
    input.minimumPayoutChips
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
