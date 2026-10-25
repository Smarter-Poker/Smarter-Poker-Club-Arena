/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  A PROVEN WINNER IS RESPECTED (2026-10-24)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Dan: track the players who are beating the horses and switch the fleet to a
 * counter-strategy against them, so the horses are not taken advantage of.
 *
 * WHAT A WINNER IS. A player whose result, measured over every hand they play
 * (public information: what they put in and what they took out), is credibly
 * positive: the decayed mean net per hand, less WINNER_Z standard errors of
 * that same sample, is still above zero. No horse flag is consulted - a person
 * sitting at the table can see who keeps winning, and that is all this sees.
 * Poker results are noisy (a single hand swings tens of big blinds), so the
 * error term is measured from the player's own swings and a read needs
 * WINNER_MIN_HANDS of effective sample before it can engage at all.
 *
 * WHAT CHANGES AGAINST ONE. Only the two levers a strong player punishes:
 * every horse bluffs them less (WINNER_BLUFF_MOD) and stops value-betting
 * thin into them (WINNER_VALUE_THIN_MOD). Every read of HOW they play stays:
 * a winning maniac is still called down as a maniac. Switching the reads off
 * against winners was measured as the wrong counter - it would have undone
 * the maniac adjustments exactly when the maniac is the one winning.
 *
 * Learned from every completed hand on every worker shard (the owner and each
 * mirror), deduplicated by hand key, bounded in memory, never persisted.
 */
import type { ExploitProfile } from './HorseMind.js';

/** Results decay with this half-life (hands), so a player who stops winning stops being read as one. */
export const WINNER_HALF_LIFE_HANDS = 1000;
/** Effective hands before a winner read can engage. */
export const WINNER_MIN_HANDS = 300;
/**
 * Standard errors the mean must clear (99% one-sided: a break-even player is
 * misread as a winner about one time in a hundred, and the cost of that
 * misread is only fewer bluffs at them). With a 1,000-hand half-life the
 * effective sample settles near 2,800 hands, so at a typical 9bb per-hand
 * swing a player must be winning about 40bb/100 to be read as a winner: a real
 * edge over the horses, not a heater.
 */
export const WINNER_Z = 2.326;
/** Bluff frequency against a proven winner (multiplies, never raises). */
export const WINNER_BLUFF_MOD = 0.6;
/** Thin value against a proven winner (capped at neutral). */
export const WINNER_VALUE_THIN_MOD = 0.85;
/** Net per hand is clipped to this many big blinds, so one cooler cannot make a winner. */
export const WINNER_CLIP_BB = 100;

const DECAY = Math.pow(0.5, 1 / WINNER_HALF_LIFE_HANDS);
const MAX_PLAYERS = 50_000;
const MAX_HANDS_SEEN = 40_000;

interface Row {
  /** sum of weights */
  w: number;
  /** sum of squared weights (effective sample = w^2 / w2) */
  w2: number;
  /** weighted sum of net (bb) */
  s: number;
  /** weighted sum of net^2 */
  q: number;
}

const rows = new Map<string, Row>();
const seen = new Set<string>();

export interface WinnerResult {
  user_id: string;
  /** chips: what this player took out of the pot less what they put in */
  net: number;
}

/** Learn one completed hand. Idempotent per hand key. */
export function observeHandResults(
  handKey: string,
  results: ReadonlyArray<WinnerResult> | null | undefined,
  bigBlind: number
): boolean {
  if (!handKey || !results?.length || !(bigBlind > 0) || seen.has(handKey)) return false;
  seen.add(handKey);
  if (seen.size > MAX_HANDS_SEEN) seen.delete(seen.values().next().value!);
  for (const r of results) {
    if (!r || typeof r.user_id !== 'string' || !Number.isFinite(r.net)) continue;
    const x = Math.max(-WINNER_CLIP_BB, Math.min(WINNER_CLIP_BB, r.net / bigBlind));
    const row = rows.get(r.user_id) ?? { w: 0, w2: 0, s: 0, q: 0 };
    rows.delete(r.user_id);
    row.w = row.w * DECAY + 1;
    row.w2 = row.w2 * DECAY * DECAY + 1;
    row.s = row.s * DECAY + x;
    row.q = row.q * DECAY + x * x;
    rows.set(r.user_id, row);
  }
  while (rows.size > MAX_PLAYERS) rows.delete(rows.keys().next().value!);
  return true;
}

export interface WinnerReadout {
  effectiveHands: number;
  /** decayed mean net, bb per hand */
  meanBB: number;
  /** standard error of that mean */
  seBB: number;
  proven: boolean;
}

export function winnerReadout(userId: string): WinnerReadout | null {
  const row = rows.get(userId);
  if (!row || row.w <= 0) return null;
  const mean = row.s / row.w;
  const variance = Math.max(0, row.q / row.w - mean * mean);
  const effectiveHands = row.w2 > 0 ? (row.w * row.w) / row.w2 : 0;
  const se = effectiveHands > 1 ? Math.sqrt(variance / (effectiveHands - 1)) : Infinity;
  const proven = effectiveHands >= WINNER_MIN_HANDS && mean - WINNER_Z * se > 0;
  return { effectiveHands, meanBB: mean, seBB: se, proven };
}

export function isProvenWinner(userId: string): boolean {
  return winnerReadout(userId)?.proven === true;
}

/** The counter-strategy: fewer bluffs, no thin value; every other lever untouched. */
export function respectWinner(
  profile: ExploitProfile,
  userId: string,
  provenOverride?: boolean
): ExploitProfile {
  if (!(provenOverride ?? isProvenWinner(userId))) return profile;
  return {
    bluffMod: profile.bluffMod * WINNER_BLUFF_MOD,
    callDownMod: profile.callDownMod,
    valueThinMod: Math.min(profile.valueThinMod, WINNER_VALUE_THIN_MOD),
  };
}

/** Test hook. */
export function resetWinnerReads(): void {
  rows.clear();
  seen.clear();
}
