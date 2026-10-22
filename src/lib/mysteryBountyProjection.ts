/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  THE MYSTERY BOUNTY LADDER BEFORE THE MYSTERY PHASE OPENS (Dan 2026-10-21)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan, verbatim: "ALL MYSTERY BOUNTY TOURNAMENTS NEED TO HAVE THE 'MYSTERY
 * BOUNTY' AMOUNTS DISPLAYED IN THE REWARDS, AND SHOW WHICH 'BOUNTIES' ARE STILL
 * AVAILABLE IN THAT TOURNAMENT, AND WHICH ONES WERE PAID OUT OR SELECTED
 * ALREADY."
 *
 * WHAT IT DID BEFORE. The chests are sealed by the engine only once entry has
 * closed and the field reaches the activation threshold (the money, by
 * default), because until then `tournaments.bounty_pool` is still growing.
 * Until that moment the Rewards tab printed "Bounty Pool 0", "Chests Left 0 Of
 * 0" and "The Ladder Is Drawn When The Mystery Phase Opens" on a 260-entry
 * event already holding a 2,080 bounty pool: a player could not see a single
 * amount he was playing for.
 *
 * WHAT THIS DOES. It runs the engine's OWN pure builders - the same
 * `mysteryPoolCents` split and the same `buildInventoryAtUnit` ladder that
 * `TournamentManagerBase` seeds with - against the pool as it stands now and
 * the number of chests the activation rule will draw. Same inputs, same
 * function, same ladder: the projection is not a second ladder that could
 * disagree with the real one, it is the real one computed early. The only
 * figure that can still move is the pool (late entries, rebuys, add-ons), and
 * the panel says so.
 *
 * Pure. No I/O, no clock, no random source.
 */

import { buildInventoryAtUnit, summariseInventory } from '../../server/src/tournament/mysteryBountyPool';
import {
  mysteryBountyFieldTooSmall,
  mysteryPoolCents,
  type MysteryBountyActivationMode,
} from '../../server/src/tournament/mysteryBountyActivation';
import type { MysteryBountyProfileName } from '../../server/src/config/mysteryBountySpec';

export interface MysteryBountyProjectionInputs {
  /** `tournaments.bounty_pool` (numeric money, the event's unit). */
  bountyPool: number | string | null | undefined;
  /** `tournaments.bounty_pool_paid`: flat knockouts already paid from it. */
  bountyPoolPaid: number | string | null | undefined;
  mysteryPercent: number | string | null | undefined;
  regularPercent: number | string | null | undefined;
  topPercent: number | string | null | undefined;
  profile: string | null | undefined;
  activation: string | null | undefined;
  activationValue: number | string | null | undefined;
  /** How many places the payout structure pays ('at_the_money'). */
  paidPlaces: number;
  /** Every entry the event has taken, rebuys and re-entries included. */
  totalEntries: number;
  /** The event's money grid: 1 for chips, 100 for whole Diamonds. */
  unitCents: number;
}

export interface MysteryBountyProjectedTier {
  tier: string;
  amountCents: number;
  count: number;
}

export interface MysteryBountyProjection {
  /** The mystery half of the bounty pool as it stands now. */
  poolCents: number;
  /** How many chests the activation will draw (players at activation - 1). */
  drawCount: number;
  /** Highest amount first, one row per distinct tier and amount. */
  tiers: MysteryBountyProjectedTier[];
}

const PROFILES: ReadonlySet<string> = new Set(['balanced', 'classic', 'jackpot']);

function num(v: unknown): number {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) ? n : 0;
}

/**
 * Players still in when the mystery phase opens, by the same three rules
 * `mysteryBountyThresholdReached` applies, so the chest count is that number
 * minus one (Dan's spec section 8: no chest for the eventual winner).
 */
export function projectedDrawCount(
  mode: MysteryBountyActivationMode,
  modeValue: number | string | null | undefined,
  paidPlaces: number,
  totalEntries: number
): number {
  let atActivation = 0;
  switch (mode) {
    case 'player_count':
      atActivation = Math.floor(num(modeValue));
      break;
    case 'percent_field': {
      const pct = num(modeValue);
      atActivation = pct > 0 && totalEntries > 0 ? Math.ceil((totalEntries * pct) / 100) : 0;
      break;
    }
    case 'at_the_money':
    default:
      atActivation = Math.floor(num(paidPlaces));
      break;
  }
  // Activation cannot happen with more players than entered.
  if (totalEntries > 0) atActivation = Math.min(atActivation, totalEntries);
  return Math.max(0, atActivation - 1);
}

/**
 * The ladder the mystery phase will draw, from the pool as it stands now.
 * Null when there is nothing honest to show: no pool yet, a field of ten or
 * fewer (flat bounties only), or a chest count the pool cannot fund.
 */
export function projectMysteryBountyLadder(
  input: MysteryBountyProjectionInputs
): MysteryBountyProjection | null {
  const unit = Math.floor(num(input.unitCents));
  if (!(unit > 0)) return null;
  if (input.totalEntries > 0 && mysteryBountyFieldTooSmall(input.totalEntries)) return null;

  const bountyCents = Math.round(num(input.bountyPool) * 100);
  const paidCents = Math.round(num(input.bountyPoolPaid) * 100);
  const poolCents = mysteryPoolCents(
    bountyCents,
    input.mysteryPercent == null ? null : num(input.mysteryPercent),
    input.regularPercent == null ? null : num(input.regularPercent),
    paidCents,
    unit
  );
  if (!(poolCents > 0)) return null;

  const rawMode = String(input.activation ?? 'at_the_money');
  const mode: MysteryBountyActivationMode =
    rawMode === 'percent_field' || rawMode === 'player_count' ? rawMode : 'at_the_money';
  const drawCount = projectedDrawCount(
    mode,
    input.activationValue,
    input.paidPlaces,
    input.totalEntries
  );
  if (drawCount < 1) return null;

  const profileName = String(input.profile ?? 'classic');
  const profile = (PROFILES.has(profileName) ? profileName : 'classic') as MysteryBountyProfileName;
  const top = input.topPercent == null ? null : num(input.topPercent);
  try {
    const chests = buildInventoryAtUnit(poolCents, drawCount, profile, top, unit);
    return {
      poolCents,
      drawCount,
      tiers: summariseInventory(chests).map((row) => ({
        tier: row.tier,
        amountCents: row.amountCents,
        count: row.count,
      })),
    };
  } catch {
    // A pool that cannot fund one unit per chest has no ladder to show yet.
    return null;
  }
}
