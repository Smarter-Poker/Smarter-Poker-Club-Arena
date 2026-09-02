/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  MYSTERY BOUNTY TIERS — one vocabulary for every client surface
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan section 50: a chest's tier is a property of the CHEST, not of how big the
 * number happens to look next to the running average. The server decides it
 * (server/src/config/mysteryBountySpec.ts) and every client surface has to say
 * the same word for the same tier, or the reveal animation, the lobby ladder,
 * the award history and the results table will disagree about what a player
 * just won.
 *
 * This is where every NON-ANIMATION surface reads them: the lobby ladder, the
 * award history, the results table. MysteryBountyChest.tsx keeps its own copy,
 * deliberately - it is the reveal animation, it is mid-migration territory for
 * two other streams, and a refactor of it to import this file would be a change
 * to the chest for no behavioural gain.
 *
 * That leaves THREE copies of one mapping (here, the chest, and the server), so
 * tests/unit/mysteryBountyTierParity.test.ts asserts all three agree. The bug it
 * prevents is specific: the designated revealer's own tap calls
 * fn_mystery_bounty_reveal directly and gets back a raw tier name, while every
 * spectator reads the label off the broadcast - so a drifted copy shows one
 * player "Mega Prize" and everybody else "Major Prize" for the same chest.
 *
 * MIRRORS server/src/config/mysteryBountySpec.ts. The server tsconfig sets
 * `rootDir: ./src`, so neither side can import the other.
 *
 * House rule (CLAUDE.md 5.7): First Letter Of Every Word Capitalized.
 */

/** Highest to lowest. The lobby ladder renders in this order. */
export const MYSTERY_BOUNTY_TIER_ORDER = [
  'jackpot',
  'mega',
  'major',
  'large',
  'medium',
  'small',
  'base_plus',
  'base',
] as const;

export type MysteryBountyTierName = (typeof MYSTERY_BOUNTY_TIER_ORDER)[number];

/** The words a player reads. */
export const MYSTERY_BOUNTY_TIER_LABELS: Record<string, string> = {
  jackpot: 'Jackpot',
  mega: 'Mega Prize',
  major: 'Major Prize',
  large: 'Large Prize',
  medium: 'Medium Prize',
  small: 'Small Prize',
  base_plus: 'Bonus Prize',
  base: 'Standard Prize',
};

/**
 * Tier colours.
 *
 * The lower-case entries with no suffix are the server's inventory tier names.
 * The rest are the legacy label words `getTier()` still produces when a very
 * old engine build sends no tier at all.
 */
export const MYSTERY_BOUNTY_TIER_COLORS: Record<string, string> = {
  // Server tier names.
  jackpot: '#6fdcff',
  mega: '#ef4444',
  major: '#a855f7',
  large: '#6fdcff',
  medium: '#6fdcff',
  small: '#60a5fa',
  base_plus: '#60a5fa',
  base: '#6b7280',
  // Legacy label words (getTier).
  min: '#6b7280',
  huge: '#1877f2',
  grand: '#a855f7',
};

/**
 * The tiers Dan calls MAJOR (section 33/35): once one of these is won it stays
 * visible in the lobby for the rest of the event and into the results, even
 * with zero remaining. Lower tiers may collapse.
 */
export const MYSTERY_BOUNTY_HEADLINE_TIERS: ReadonlySet<string> = new Set([
  'jackpot',
  'mega',
  'major',
]);

function normalise(tier: string | null | undefined): string {
  return String(tier ?? '')
    .trim()
    .toLowerCase();
}

/**
 * The words for a server tier name. Never empty: an unknown tier reads as a
 * plain "Prize", which is what the server's own formatBountyTier does.
 */
export function mysteryBountyTierLabel(tier: string | null | undefined): string {
  return MYSTERY_BOUNTY_TIER_LABELS[normalise(tier)] ?? 'Prize';
}

/** Colour for a tier name or a legacy label word. Steel when unknown. */
export function mysteryBountyTierColor(tier: string | null | undefined): string {
  return MYSTERY_BOUNTY_TIER_COLORS[normalise(tier)] ?? '#6b7280';
}

/** Is this one of the tiers that must stay visible once exhausted? */
export function isHeadlineTier(tier: string | null | undefined): boolean {
  return MYSTERY_BOUNTY_HEADLINE_TIERS.has(normalise(tier));
}

/**
 * Sort key for a tier, highest first. Unknown tiers sort last rather than
 * throwing, so a tier the server adds tomorrow still renders today.
 */
export function tierRank(tier: string | null | undefined): number {
  const idx = (MYSTERY_BOUNTY_TIER_ORDER as readonly string[]).indexOf(normalise(tier));
  return idx === -1 ? MYSTERY_BOUNTY_TIER_ORDER.length : idx;
}
