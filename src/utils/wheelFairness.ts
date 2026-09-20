import type {
  WheelDrawDomain,
  WheelSpinResult,
  WheelSegment,
} from '../services/DiamondWheelService';
/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  DIAMOND WHEEL FAIRNESS - recompute a spin in the browser
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * The server commits to a seed before the player presses Spin by publishing
 * sha256(server_seed). The spin reveals the seed. Anyone holding the result
 * can then check two things with WebCrypto and nothing else:
 *
 *   1. sha256(server_seed) equals the hash shown before the spin, so the house
 *      did not pick its seed after seeing the bet;
 *   2. roll = first 6 bytes of HMAC-SHA256(key = server_seed,
 *      message = client_seed || ':' || nonce), read as a 48-bit integer, and
 *      point = floor(roll * weight_total / 2^48) lands on the outcome when the
 *      ELIGIBLE segments' weights are walked in ord order.
 *
 * This is byte-for-byte the mapping fn_wheel_spin uses
 * (supabase/migrations/20260907233833). If the two ever disagree the server is
 * the one that paid, and this file is the one that is wrong, so the unit test
 * pins this file to a vector computed by Postgres.
 */

const TWO_48 = 281474976710656n; // 2^48

export interface WheelFairnessInput {
  domain?: WheelDrawDomain;
  serverSeed: string;
  serverSeedHash: string;
  clientSeed: string;
  nonce: number;
  roll: number;
  weightTotal: number;
  /** ord -> weight, for the segments that were eligible on this spin, in ord order. */
  eligible: Array<{ ord: number; weight: number }>;
  outcomeOrd: number;
}

export interface WheelFairnessVerdict {
  hashMatches: boolean;
  rollMatches: boolean;
  outcomeMatches: boolean;
  /** Everything checked out. */
  fair: boolean;
  computedHash: string;
  computedRoll: number;
  computedPoint: number;
  computedOrd: number | null;
}

function toHex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return toHex(digest);
}

export async function hmacSha256Hex(key: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    enc.encode(key),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', cryptoKey, enc.encode(message));
  return toHex(sig);
}

/** The first six bytes of a hex digest as a 48-bit integer, the way Postgres reads them. */
export function rollFromHmacHex(hmacHex: string): number {
  return Number(BigInt('0x' + hmacHex.slice(0, 12)));
}

/** floor(roll * total / 2^48), in exact integer arithmetic. */
export function pointFromRoll(roll: number, weightTotal: number): number {
  return Number((BigInt(roll) * BigInt(weightTotal)) / TWO_48);
}

/** Walk the eligible weights in ord order; the first cumulative weight past the point wins. */
export function pickOrd(
  point: number,
  eligible: Array<{ ord: number; weight: number }>
): number | null {
  const sorted = [...eligible].sort((a, b) => a.ord - b.ord);
  let acc = 0;
  for (const seg of sorted) {
    acc += seg.weight;
    if (point < acc) return seg.ord;
  }
  return sorted.length ? sorted[sorted.length - 1].ord : null;
}

export async function verifyWheelSpin(input: WheelFairnessInput): Promise<WheelFairnessVerdict> {
  const computedHash = await sha256Hex(input.serverSeed);
  const hmac = await hmacSha256Hex(
    input.serverSeed,
    `${input.domain ? `${input.domain}:` : ''}${input.clientSeed}:${input.nonce}`
  );
  const computedRoll = rollFromHmacHex(hmac);
  const computedPoint = pointFromRoll(computedRoll, input.weightTotal);
  const computedOrd = pickOrd(computedPoint, input.eligible);
  const hashMatches = computedHash === input.serverSeedHash.toLowerCase();
  const rollMatches = computedRoll === input.roll;
  const outcomeMatches = computedOrd === input.outcomeOrd;
  return {
    hashMatches,
    rollMatches,
    outcomeMatches,
    fair: hashMatches && rollMatches && outcomeMatches,
    computedHash,
    computedRoll,
    computedPoint,
    computedOrd,
  };
}

/** A fresh client seed: 16 random bytes as hex. The player may replace it. */
export function randomClientSeed(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** Verify every draw on the saved table. Upgrade is a distinct committed draw,
 * never a second payment or a client-selected game. Legacy tables remain readable. */
export async function verifyWheelReceiptFairness(
  receipt: WheelSpinResult,
  legacySegments: WheelSegment[] = []
): Promise<WheelFairnessVerdict> {
  const verify = (fairness: WheelSpinResult['fairness'], table: WheelSegment[], ord: number) =>
    verifyWheelSpin({
      domain: fairness.domain,
      serverSeed: fairness.server_seed,
      serverSeedHash: fairness.server_seed_hash,
      clientSeed: fairness.client_seed,
      nonce: fairness.nonce,
      roll: fairness.roll,
      weightTotal: fairness.weight_total,
      eligible: table.filter((s) => fairness.eligible_ords.includes(s.ord)),
      outcomeOrd: ord,
    });
  const first = await verify(
    receipt.fairness,
    receipt.segments ?? legacySegments,
    receipt.outcome.ord
  );
  if (!receipt.secondary) return first;
  const second = await verify(
    receipt.secondary.fairness,
    receipt.secondary.segments,
    receipt.secondary.outcome.ord
  );
  return {
    ...first,
    hashMatches: first.hashMatches && second.hashMatches,
    rollMatches: first.rollMatches && second.rollMatches,
    outcomeMatches: first.outcomeMatches && second.outcomeMatches,
    fair: first.fair && second.fair,
  };
}
