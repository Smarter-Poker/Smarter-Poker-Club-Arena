/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * MYSTERY BOUNTY — THE TIER LADDER
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * This file is the ONLY place a mystery bounty tier ladder is defined.
 *
 * Before it, there were three, none of which agreed and none of which was the
 * one Dan asked for:
 *
 *   - a hard-coded five-step multiplier ladder inside the SQL registration
 *     function, rolled with Postgres `random()` at REGISTRATION time, so every
 *     player's mystery bounty was already decided before a card was dealt;
 *   - `TournamentService.rollMysteryBounty()`, a client-side `Math.random()`
 *     re-roll with no callers at all;
 *   - a `mysteryTiers` array built by CreateTournamentModal from a min/max
 *     multiplier pair and then thrown away before the create RPC was called.
 *
 * The ladder below replaces all three. Two numbers describe each tier:
 *
 *   frequency  — the TARGET share of chests that carry this tier, in percent.
 *                It is a target, not a guarantee: `buildInventory` allocates
 *                whole chests by largest remainder, forces exactly one jackpot
 *                when the field is big enough to carry one, and merges tiers
 *                that a small field cannot express.
 *
 *   poolShare  — the share of the mystery pool this tier holds in total, in
 *                percent. Divided by the tier's chest count, this is what one
 *                chest of that tier is worth.
 *
 * Both columns sum to exactly 100 in every profile. That is asserted by
 * `assertProfileSane()` below and by a test, because a ladder that does not
 * sum to 100 silently under- or over-pays the whole event.
 *
 * The share/frequency ratio is what actually makes a tier feel big, and it is
 * strictly decreasing down every ladder — jackpot is worth 20x an average
 * chest in CLASSIC, base is worth about a quarter of one. Keep it that way: a
 * ladder where a lower tier pays more than a higher one is a bug the reveal
 * animation cannot hide.
 */

import { CHEST_LANDING_MS, CHEST_AUTO_OPEN_MS } from './mysteryChestSpec.js';

/**
 * How long the engine waits after reserving a chest before it reveals and pays
 * authoritatively.
 *
 * The winner's own client opens the chest at CHEST_AUTO_OPEN_MS whether they
 * tap or not, so this is the moment the amount is on their screen either way.
 * A tap earlier than this calls fn_mystery_bounty_reveal itself and shows them
 * the number first — which is the whole point of the tap — and the engine's
 * later call is idempotent and returns the identical payload, so the table
 * broadcast and the private reveal can never disagree.
 */
export const MYSTERY_BOUNTY_REVEAL_DELAY_MS = CHEST_LANDING_MS + CHEST_AUTO_OPEN_MS;

export type MysteryBountyTierName =
  | 'jackpot'
  | 'mega'
  | 'major'
  | 'large'
  | 'medium'
  | 'small'
  | 'base_plus'
  | 'base';

/** Ordered highest value first. `buildInventory` relies on this order. */
export const MYSTERY_BOUNTY_TIER_ORDER: readonly MysteryBountyTierName[] = [
  'jackpot',
  'mega',
  'major',
  'large',
  'medium',
  'small',
  'base_plus',
  'base',
] as const;

/**
 * The tier as a player reads it (Dan section 50).
 *
 * The chest used to NAME THE TIER ITSELF, from `amount / avgBounty`. That is
 * not a tier, it is a ratio — and the average moves as an event runs, so the
 * identical chest could be announced as a "Mega Prize" at the first knockout
 * and a "Large Prize" at the last. The tier is a property of the chest that
 * was drawn out of the inventory, it is decided at seed time, and it is the
 * server's to state.
 *
 * House rule (CLAUDE.md §5.7): First Letter Of Every Word Capitalised.
 */
const TIER_LABELS: Readonly<Record<MysteryBountyTierName, string>> = {
  jackpot: 'Jackpot',
  mega: 'Mega Prize',
  major: 'Major Prize',
  large: 'Large Prize',
  medium: 'Medium Prize',
  small: 'Small Prize',
  base_plus: 'Bonus Prize',
  base: 'Standard Prize',
};

export function formatBountyTier(tier: string | null | undefined): string {
  const key = String(tier ?? '').trim() as MysteryBountyTierName;
  return TIER_LABELS[key] ?? 'Prize';
}

export type MysteryBountyProfileName = 'balanced' | 'classic' | 'jackpot';

export interface MysteryBountyTierSpec {
  readonly tier: MysteryBountyTierName;
  /** Target percentage of chests carrying this tier. Sums to 100. */
  readonly frequency: number;
  /** Percentage of the mystery pool held by this tier in total. Sums to 100. */
  readonly poolShare: number;
}

/**
 * CLASSIC — Dan's spec, sections 9 and 11. The default.
 *
 * One chest in a hundred is the jackpot and it holds a fifth of the entire
 * mystery pool. Two thirds of chests sit in the bottom three tiers and share
 * 30% of the money, which is what makes the top of the ladder mean anything.
 */
const CLASSIC: readonly MysteryBountyTierSpec[] = [
  { tier: 'jackpot', frequency: 1, poolShare: 20 },
  { tier: 'mega', frequency: 1, poolShare: 12 },
  { tier: 'major', frequency: 3, poolShare: 12 },
  { tier: 'large', frequency: 5, poolShare: 12 },
  { tier: 'medium', frequency: 10, poolShare: 14 },
  { tier: 'small', frequency: 20, poolShare: 12 },
  { tier: 'base_plus', frequency: 25, poolShare: 10 },
  { tier: 'base', frequency: 35, poolShare: 8 },
] as const;

/**
 * BALANCED — a flatter event. The jackpot is 15% of the pool rather than 20%,
 * and the bottom tiers keep more, so a typical chest is worth noticeably more
 * and the top prize is worth noticeably less. For clubs whose players complain
 * that everyone but one person got nothing.
 */
const BALANCED: readonly MysteryBountyTierSpec[] = [
  { tier: 'jackpot', frequency: 1, poolShare: 15 },
  { tier: 'mega', frequency: 2, poolShare: 10 },
  { tier: 'major', frequency: 4, poolShare: 11 },
  { tier: 'large', frequency: 6, poolShare: 12 },
  { tier: 'medium', frequency: 12, poolShare: 15 },
  { tier: 'small', frequency: 20, poolShare: 14 },
  { tier: 'base_plus', frequency: 25, poolShare: 12 },
  { tier: 'base', frequency: 30, poolShare: 11 },
] as const;

/**
 * JACKPOT — the lottery. Nearly a third of the pool sits on a single chest and
 * the bottom 40% of chests share 5% of the money. This is the profile that
 * produces the screenshot, and the one that produces the most complaints; it
 * is deliberately not the default.
 */
const JACKPOT: readonly MysteryBountyTierSpec[] = [
  { tier: 'jackpot', frequency: 1, poolShare: 30 },
  { tier: 'mega', frequency: 1, poolShare: 14 },
  { tier: 'major', frequency: 2, poolShare: 12 },
  { tier: 'large', frequency: 4, poolShare: 10 },
  { tier: 'medium', frequency: 8, poolShare: 12 },
  { tier: 'small', frequency: 18, poolShare: 10 },
  { tier: 'base_plus', frequency: 26, poolShare: 7 },
  { tier: 'base', frequency: 40, poolShare: 5 },
] as const;

export const MYSTERY_BOUNTY_PROFILES: Readonly<
  Record<MysteryBountyProfileName, readonly MysteryBountyTierSpec[]>
> = {
  balanced: BALANCED,
  classic: CLASSIC,
  jackpot: JACKPOT,
};

export const DEFAULT_MYSTERY_BOUNTY_PROFILE: MysteryBountyProfileName = 'classic';

/**
 * A field smaller than this cannot carry a jackpot chest: with nine chests a
 * 20%-of-pool jackpot is only twice an average chest, which is not a jackpot,
 * it is noise. Below the threshold the jackpot tier is dropped entirely and
 * its share is redistributed across the tiers that survive.
 */
export const MYSTERY_BOUNTY_MIN_FIELD_FOR_JACKPOT = 10;

export function resolveMysteryBountyProfile(
  name: string | null | undefined
): MysteryBountyProfileName {
  if (name === 'balanced' || name === 'classic' || name === 'jackpot') return name;
  return DEFAULT_MYSTERY_BOUNTY_PROFILE;
}

export function mysteryBountyTiers(
  profile: MysteryBountyProfileName
): readonly MysteryBountyTierSpec[] {
  return MYSTERY_BOUNTY_PROFILES[profile] ?? CLASSIC;
}

/** The advertised headline prize, as a percentage of the whole mystery pool. */
export const DEFAULT_TOP_BOUNTY_PERCENT = 20;

/**
 * Re-cut a ladder so the JACKPOT holds exactly `topPercent` of the pool.
 *
 * Dan's spec section 10: "TOP BOUNTY = 20% OF THE ENTIRE MYSTERY BOUNTY POOL",
 * and the lobby advertises that number before a single chest is opened. So the
 * number the lobby prints and the number the generator uses have to be the
 * same one - `tournaments.mystery_bounty_top_percent` was being stored,
 * validated and then ignored, which meant an event configured at 25% would
 * advertise 25% and pay 20%.
 *
 * Everything below the jackpot keeps its RELATIVE weighting and shares
 * whatever is left, so moving the top prize never reorders the ladder: at 20%
 * this returns CLASSIC unchanged, and at 30% every lower tier shrinks by the
 * same factor rather than one of them absorbing the difference.
 */
export function applyTopBountyPercent(
  tiers: readonly MysteryBountyTierSpec[],
  topPercent: number | null | undefined
): readonly MysteryBountyTierSpec[] {
  const top = Number(topPercent);
  // A jackpot cannot be the whole pool (nothing left for the other tiers) and
  // cannot be nothing (the event has no headline prize). Outside that, use the
  // profile as written.
  if (!Number.isFinite(top) || top <= 0 || top >= 100) return tiers;
  if (tiers.length === 0 || tiers[0].tier !== 'jackpot') return tiers;
  if (Math.abs(top - tiers[0].poolShare) < 1e-9) return tiers;

  const restBefore = tiers.slice(1).reduce((sum, t) => sum + t.poolShare, 0);
  if (restBefore <= 0) return tiers;
  const scale = (100 - top) / restBefore;

  return [
    { ...tiers[0], poolShare: top },
    ...tiers.slice(1).map((t) => ({ ...t, poolShare: t.poolShare * scale })),
  ];
}

/**
 * Every profile must describe a whole field and a whole pool. A ladder whose
 * frequencies sum to 97 leaves three chests per hundred undefined; one whose
 * shares sum to 103 promises money that does not exist. Both are silent at
 * runtime and neither is recoverable once the event is live, so they are
 * checked here and in a test rather than trusted.
 */
export function assertProfileSane(profile: MysteryBountyProfileName): void {
  const tiers = mysteryBountyTiers(profile);
  const freq = tiers.reduce((s, t) => s + t.frequency, 0);
  const share = tiers.reduce((s, t) => s + t.poolShare, 0);
  if (Math.abs(freq - 100) > 1e-9) {
    throw new Error(`mystery bounty profile ${profile}: frequencies sum to ${freq}, not 100`);
  }
  if (Math.abs(share - 100) > 1e-9) {
    throw new Error(`mystery bounty profile ${profile}: pool shares sum to ${share}, not 100`);
  }
  if (tiers.length !== MYSTERY_BOUNTY_TIER_ORDER.length) {
    throw new Error(`mystery bounty profile ${profile}: expected every tier to be present`);
  }
  for (let i = 0; i < tiers.length; i++) {
    if (tiers[i].tier !== MYSTERY_BOUNTY_TIER_ORDER[i]) {
      throw new Error(
        `mystery bounty profile ${profile}: tier ${i} is ${tiers[i].tier}, expected ${MYSTERY_BOUNTY_TIER_ORDER[i]}`
      );
    }
    if (i > 0) {
      const prev = tiers[i - 1].poolShare / tiers[i - 1].frequency;
      const here = tiers[i].poolShare / tiers[i].frequency;
      if (here >= prev) {
        throw new Error(
          `mystery bounty profile ${profile}: ${tiers[i].tier} is worth more per chest than ${tiers[i - 1].tier}`
        );
      }
    }
  }
}
