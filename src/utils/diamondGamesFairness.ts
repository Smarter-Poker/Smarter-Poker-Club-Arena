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
 *   CRASH: the first six bytes as a 48-bit integer r, and the crash point in
 *   cents is floor(80 * 2^48 / (r + 1)), floored at 100 (1.00x). For any
 *   target x, P(X >= x) = 0.8 / x. With a guaranteed floor L the point is
 *   floor(100 (L + (0.8B - L) 2^48 / (r + 1)) / B), so P(X >= x) = (0.8B - L)/(xB - L).
 *   CONTRACT 4 (Dan, 2026-09-21, R3): the point is floored at 110 (1.10x) and
 *   cash out opens at 1.11x. For any x above 1.10, max(raw, 110) >= x iff
 *   raw >= x, so every cash-out target still returns exactly 0.80B; the ship
 *   can never explode until after 1.10x. A receipt says which floor it was
 *   sealed under through payout_version.
 *
 * Byte for byte the mapping of supabase/migrations/20260908010241, 20260919034436
 * and 20260921203512. The unit test pins this file to vectors computed by
 * production Postgres.
 */

import { hmacSha256Hex, rollFromHmacHex, sha256Hex } from './wheelFairness';

const EIGHTY_TIMES_TWO_48 = 22517998136852480n; // 80 * 2^48

/** The contract every crash round sealed since 2026-09-21 carries. */
export const CRASH_PAYOUT_VERSION = 4;
/** The lowest crash point a round of this contract can seal: 1.00x before
 * contract 4, 1.10x from it. Mirrors GREATEST(100|110, ...) in fn_crash_point_cents. */
export function crashPointFloorCents(payoutVersion?: number): number {
  return (payoutVersion ?? 0) >= CRASH_PAYOUT_VERSION ? 110 : 100;
}
/** The first multiplier a round of this contract may cash out at: 1.01x before
 * contract 4, 1.11x from it. Mirrors fn_crash_decide and fn_crash_cashout. */
export function crashCashoutFloorCents(payoutVersion?: number): number {
  return (payoutVersion ?? 0) >= CRASH_PAYOUT_VERSION ? 111 : 101;
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

/** floor(80 * 2^48 / (roll + 1)) cents, floored at the contract's floor (1.00x,
 * or 1.10x under contract 4). Exact BigInt arithmetic. */
export function crashPointCentsFromRoll(
  roll: number | bigint,
  betChips = 1,
  minimumPayoutChips = 0,
  pointFloorCents = 100
): number {
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
  if (!Number.isInteger(pointFloorCents) || pointFloorCents < 100)
    throw new Error('Invalid Crash Outcome');
  return cents < BigInt(pointFloorCents) ? pointFloorCents : Number(cents);
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
  betChips?: number;
  minimumPayoutChips?: number;
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
  const computedCrashCents = crashPointCentsFromRoll(
    computedRoll,
    input.betChips,
    input.minimumPayoutChips,
    crashPointFloorCents(input.payoutVersion)
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
