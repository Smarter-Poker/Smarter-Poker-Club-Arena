/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * MYSTERY BOUNTY CHEST — timing contract shared with the client
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan 2026-08-21: "after it finished and the prize is awarded, the next hand
 * starts with the dealing animation to move onto the next hand."
 *
 * The table must not deal a hand over a live reveal. The engine therefore holds
 * dealing on the knockout's table for the full length of the chest sequence,
 * using the same holdDealingUntil() mechanism the spin wheel uses.
 *
 * These numbers MIRROR src/components/tournament/MysteryBountyChest.tsx. If the
 * chest's phases change there, change them here in the same commit — a hold
 * that is too short deals cards under the reveal, and one that is too long
 * leaves a table idle for no reason.
 *
 * Worst case is the AFK winner: nobody taps, so the chest opens itself at
 * AUTO_OPEN_MS and the rest of the sequence follows. A winner who taps
 * immediately finishes sooner; the hold does not shorten with them, which is
 * the deliberate trade — a few idle seconds costs a knockout celebration
 * nothing, whereas dealing over the reveal destroys it.
 */

/** Chest drops in and thumps before it can be tapped. */
export const CHEST_LANDING_MS = 700;

/** The winner's client opens it automatically if they never tap. */
export const CHEST_AUTO_OPEN_MS = 9000;

/** Latch pops, lid swings, light floods the seam. */
export const CHEST_OPENING_MS = 900;

/** Flash, shockwave, coin shower. */
export const CHEST_EXPLOSION_MS = 600;

/** Amount counts up, tier named, then the overlay dismisses itself. */
export const CHEST_REVEALED_MS = 5200;

/** A beat of air after the overlay clears, before cards move again. */
export const CHEST_SETTLE_MS = 400;

/**
 * Total time to hold dealing after a mystery bounty is revealed at a table.
 * ~16.8s at 1x animation speed.
 */
export function mysteryChestHoldMs(): number {
  return (
    CHEST_LANDING_MS +
    CHEST_AUTO_OPEN_MS +
    CHEST_OPENING_MS +
    CHEST_EXPLOSION_MS +
    CHEST_REVEALED_MS +
    CHEST_SETTLE_MS
  );
}
