/**
 * ═══ WHOSE AVATAR DID THE PLAYER JUST TAP? (Dan 2026-08-29, pinned) ═══════════
 *
 * Dan, verbatim: "THE ACTION BAR THAT POPS UP WHEN YOU CLICK ON YOUR OWN
 * AVATAR NEEDS TO BE ... THE TABBED HERO HUB ... ON EVERY SINGLE PAGE INSIDE
 * THE CLUB ARENA REGUARDLESS OF WHAT KIND OF GAME YOU ARE PLAYING."
 *
 * The bug this rule buries: the seat renders `displayPlayer`, which
 * synthesizes a hero placeholder while the hero is pending / waiting to be
 * dealt in — and the tap handler used to read `player?.isHero`, null in that
 * whole window, so tapping YOUR OWN avatar took the villain branch and opened
 * the throwable-only selector with no Stats / Profile / Table tabs.
 *
 * The rule lives here as a pure function so a law test can pin it without a
 * table. Two independent signals say "this is you":
 *   1. the isHero stamp on the RENDERED player (`displayPlayer`, never the
 *      raw `player` — the placeholder window is the whole point);
 *   2. the id matching the signed-in user — the backstop for snapshot
 *      rebuilds that drop the isHero stamp (see TablePage's isHero recovery
 *      effect, 2026-07-24).
 *
 * Do not add game-variant, page, or seat-state conditions here. Your own
 * avatar opens YOUR hub, always, everywhere.
 */

/** The two things a seat-avatar tap can open. */
export type SeatTapTarget = 'hero-hub' | 'villain-throwables';

export interface TappedSeatPlayer {
  id?: string;
  isHero?: boolean;
}

/**
 * Decide what a tap on a seat's avatar opens.
 *
 * @param displayPlayer the player object the seat RENDERS (placeholder
 *                      included) — never the raw snapshot player
 * @param userId        the signed-in user's id ('' / undefined when unknown)
 */
export function seatTapTarget(
  displayPlayer: TappedSeatPlayer | null | undefined,
  userId: string | null | undefined
): SeatTapTarget {
  if (!displayPlayer) return 'villain-throwables';
  if (displayPlayer.isHero) return 'hero-hub';
  if (userId && displayPlayer.id === userId) return 'hero-hub';
  return 'villain-throwables';
}
