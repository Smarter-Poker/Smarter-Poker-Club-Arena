import type {
  WheelCardPick,
  WheelDrawDomain,
  WheelPreviousOutcome,
  WheelSpinResult,
  WheelSegment,
} from '../services/DiamondWheelService';
import {
  WHEEL_V4_FOLLOW,
  WHEEL_V4_GAME_BY_ORD,
  WHEEL_V4_GAME_ORDS,
  WHEEL_V4_TOTAL,
  WHEEL_V4_UPGRADE_ORD_BY_GAME,
  WHEEL_V4_UPGRADE_WEIGHTS,
  WHEEL_V4_WEIGHTS,
} from './wheelV4Model';
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
  /** Contract 4: false when the receipt's own weights are not the published law's. */
  lawMatches?: boolean;
}

export interface WheelFairnessVerdict {
  hashMatches: boolean;
  rollMatches: boolean;
  outcomeMatches: boolean;
  /**
   * Contract 4: the weights the receipt says it drew from are the ones the
   * PUBLISHED law gives for that previous outcome. A receipt that quietly
   * reweighted itself fails here even though its own arithmetic is consistent.
   * True for older contracts, which have no such law to check.
   */
  lawMatches: boolean;
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
  const lawMatches = input.lawMatches !== false;
  return {
    hashMatches,
    rollMatches,
    outcomeMatches,
    lawMatches,
    fair: hashMatches && rollMatches && outcomeMatches && lawMatches,
    computedHash,
    computedRoll,
    computedPoint,
    computedOrd,
  };
}

/**
 * THE PUBLISHED FOLLOW-UP LAW (owner ruling 2026-09-21, R12), recomputed here.
 *
 * The spin after ord i draws from ROW i of the symmetric matrix in
 * `wheelV4Model.ts`, and when the previous final outcome was a SUPER game the
 * ordinary card of that same game is dropped from the row as well, its weight
 * shared evenly (largest share first) among the other three ordinary games. A
 * player's very first spin ever draws the base law. The browser derives the row
 * itself so that a receipt cannot hand it a set of weights of its own choosing.
 */
export function wheelV4MainWeights(previous: WheelPreviousOutcome | null | undefined): number[] {
  if (!previous || !Number.isInteger(previous.ord) || previous.ord < 1 || previous.ord > 12)
    return [...WHEEL_V4_WEIGHTS];
  const row = [...WHEEL_V4_FOLLOW[previous.ord - 1]];
  if (previous.tier !== 'super' || !previous.game) return row;
  const hit = WHEEL_V4_GAME_ORDS.find((ord) => WHEEL_V4_GAME_BY_ORD[ord] === previous.game);
  if (hit === undefined) return row;
  const others = WHEEL_V4_GAME_ORDS.filter((ord) => ord !== hit);
  const share = Math.floor(row[hit - 1] / others.length);
  const rest = row[hit - 1] % others.length;
  row[hit - 1] = 0;
  others.forEach((ord, index) => {
    row[ord - 1] += share + (index < rest ? 1 : 0);
  });
  return row;
}

/**
 * The Upgrade wheel's own law: after an ORDINARY game the Super card of that
 * game is dropped and its weight shared among the other three Super games. A
 * Super previous outcome cannot reach this wheel at all, because two Upgrades
 * in a row are impossible.
 */
export function wheelV4UpgradeWeights(previous: WheelPreviousOutcome | null | undefined): number[] {
  const row = [...WHEEL_V4_UPGRADE_WEIGHTS];
  const game = previous?.game;
  if (!game) return row;
  const hit = WHEEL_V4_UPGRADE_ORD_BY_GAME[game];
  if (hit === undefined) return row;
  const others = Object.values(WHEEL_V4_UPGRADE_ORD_BY_GAME)
    .filter((ord) => ord !== hit)
    .sort((a, b) => a - b);
  const share = Math.floor(row[hit - 1] / others.length);
  const rest = row[hit - 1] % others.length;
  row[hit - 1] = 0;
  others.forEach((ord, index) => {
    row[ord - 1] += share + (index < rest ? 1 : 0);
  });
  return row;
}

const sameWeights = (a: readonly number[], b: readonly number[]): boolean =>
  a.length === b.length && a.every((w, i) => w === b[i]);

/** The eligible list a contract-4 receipt draws from: its own row, zeros dropped. */
function eligibleFromWeights(weights: readonly number[]): Array<{ ord: number; weight: number }> {
  return weights
    .map((weight, index) => ({ ord: index + 1, weight }))
    .filter((segment) => segment.weight > 0);
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
  // FROM CONTRACT 4 THE TABLE AND THE DRAW ARE TWO DIFFERENT THINGS. `segments`
  // is the published prize table, always at its base weights, so the odds a
  // player was shown never move; `fairness.weights` is the row this one spin
  // drew from. The row is recomputed here from the published law rather than
  // trusted, and the walk uses the row, not the table.
  const lawful = (
    fairness: WheelSpinResult['fairness'],
    expected: number[]
  ): { eligible: Array<{ ord: number; weight: number }>; lawMatches: boolean } | null => {
    if (!fairness.weights) return null;
    const eligible = eligibleFromWeights(fairness.weights);
    return {
      eligible,
      lawMatches:
        sameWeights(fairness.weights, expected) &&
        fairness.weight_total === fairness.weights.reduce((sum, w) => sum + w, 0) &&
        eligible.length === fairness.eligible_ords.length &&
        eligible.every((segment) => fairness.eligible_ords.includes(segment.ord)),
    };
  };
  const verify = (
    fairness: WheelSpinResult['fairness'],
    table: WheelSegment[],
    ord: number,
    expected: number[]
  ) => {
    const row = lawful(fairness, expected);
    return verifyWheelSpin({
      domain: fairness.domain,
      serverSeed: fairness.server_seed,
      serverSeedHash: fairness.server_seed_hash,
      clientSeed: fairness.client_seed,
      nonce: fairness.nonce,
      roll: fairness.roll,
      weightTotal: fairness.weight_total,
      eligible: row ? row.eligible : table.filter((s) => fairness.eligible_ords.includes(s.ord)),
      outcomeOrd: ord,
      lawMatches: row ? row.lawMatches : true,
    });
  };
  const previous = receipt.fairness.previous;
  const first = await verify(
    receipt.fairness,
    receipt.segments ?? legacySegments,
    receipt.outcome.ord,
    wheelV4MainWeights(previous)
  );
  const publishedTable =
    receipt.contract_version === 4
      ? (receipt.segments ?? []).reduce((sum, s) => sum + s.weight, 0) === WHEEL_V4_TOTAL
      : true;
  if (!receipt.secondary)
    return publishedTable ? first : { ...first, lawMatches: false, fair: false };
  const second = await verify(
    receipt.secondary.fairness,
    receipt.secondary.segments,
    receipt.secondary.outcome.ord,
    wheelV4UpgradeWeights(previous)
  );
  return {
    ...first,
    hashMatches: first.hashMatches && second.hashMatches,
    rollMatches: first.rollMatches && second.rollMatches,
    outcomeMatches: first.outcomeMatches && second.outcomeMatches,
    lawMatches: first.lawMatches && second.lawMatches && publishedTable,
    fair: first.fair && second.fair && publishedTable,
  };
}

/**
 * THE THREE CARDS WERE SEALED BEFORE THE PICK (owner ruling 2026-09-21, R15).
 * The permutation index is floor(roll * 6 / 2^48) over the six orders of
 * (half, double, triple) in lexicographic order, with roll the first six bytes
 * of HMAC-SHA256(server_seed, 'wheel-v4-cards:' || client_seed || ':' || nonce).
 * Half is the risk halved, rounded by the server's own sealed draw, so both
 * floor and ceil are accepted on an odd risk and nothing else is.
 */
export interface WheelCardVerdict {
  hashMatches: boolean;
  rollMatches: boolean;
  permutationMatches: boolean;
  cardsMatch: boolean;
  paidMatches: boolean;
  fair: boolean;
  computedRoll: number;
  computedPermutation: number;
  computedCards: number[] | null;
}

const CARD_ORDERS: ReadonlyArray<readonly [number, number, number]> = [
  [0, 1, 2],
  [0, 2, 1],
  [1, 0, 2],
  [1, 2, 0],
  [2, 0, 1],
  [2, 1, 0],
];

export async function verifyWheelCardPick(pick: WheelCardPick): Promise<WheelCardVerdict> {
  const { fairness, risk_diamonds: risk } = pick;
  const computedHash = await sha256Hex(fairness.server_seed);
  const hmac = await hmacSha256Hex(
    fairness.server_seed,
    `wheel-v4-cards:${fairness.client_seed}:${fairness.nonce}`
  );
  const computedRoll = rollFromHmacHex(hmac);
  const computedPermutation = Number((BigInt(computedRoll) * 6n) / TWO_48);
  const half = pick.cards.find(
    (value) => value === Math.floor(risk / 2) || value === Math.ceil(risk / 2)
  );
  const computedCards =
    half === undefined
      ? null
      : CARD_ORDERS[computedPermutation].map((slot) => [half, 2 * risk, 3 * risk][slot]);
  const hashMatches = computedHash === fairness.server_seed_hash.toLowerCase();
  const rollMatches = computedRoll === fairness.roll;
  const permutationMatches = computedPermutation === fairness.permutation;
  const cardsMatch =
    computedCards !== null &&
    computedCards.length === pick.cards.length &&
    computedCards.every((value, index) => value === pick.cards[index]);
  const paidMatches =
    Number.isInteger(pick.picked) &&
    pick.picked >= 1 &&
    pick.picked <= 3 &&
    pick.cards[pick.picked - 1] === pick.paid_diamonds;
  return {
    hashMatches,
    rollMatches,
    permutationMatches,
    cardsMatch,
    paidMatches,
    fair: hashMatches && rollMatches && permutationMatches && cardsMatch && paidMatches,
    computedRoll,
    computedPermutation,
    computedCards,
  };
}
