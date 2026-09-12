/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  DIAMOND ARENA IS LIGHT, AND ONLY DIAMOND ARENA
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Dan, 2026-09-11: "ONLY DIFFERENCE BETWEEN THEM IS DIAMOND ARENA SHOULD BE
 * WHITE, OR LIGHT SCHEMA, CLUB ARENA DARK."
 *
 * That sits directly on top of an older instruction, 2026-08-30: "THE WHOLE
 * BACKGROUND SHOULD BE SOLID BLACK AND ALL THE SAME COLOR", which is why the
 * body rule in club-engine.css paints `#000` with a note saying so. The two
 * are not in conflict once the light one is SCOPED: black is the rule for the
 * chip estate, and the Diamond Arena is the one room that is not part of it.
 *
 * ─── WHY A THIRD ATTRIBUTE ───────────────────────────────────────────────
 *
 * `<html>` already carries two, and they were one attribute until they fought:
 *
 *   data-theme        the player's INTERFACE mode, 'dark' | 'light', chosen in
 *                     Settings and written by three owners (useSettingsStore,
 *                     the MasterBus UI_THEME_CHANGED handler, and Shell).
 *   data-color-theme  the table FELT palette, black|blue|gold|purple|red.
 *
 * The split, and the production incident where the app ran in light mode
 * because the felt attribute was selecting interface tokens, is written up in
 * docs/changelog/2026-09-05-the-route-gate-could-not-fail-and-realism-becomes-
 * one-vocabulary.md. Overloading `data-theme` here would mean a fourth writer
 * racing three others for one attribute, and a player who chose dark would
 * find their choice silently rewritten by walking into a room.
 *
 * So this is its own attribute with one writer and one input. It says where
 * you ARE, not what you PREFER, which is why it never reads or writes the
 * player's setting and never needs to be reconciled with it.
 *
 * ─── WHAT IT MAY NOT DO ──────────────────────────────────────────────────
 *
 * It may not lighten a table. `tests/seat-plates-stay-dark.law.test.ts` holds
 * seat plates, the felt and the timer dark in every interface scheme, and that
 * law is about the cards being readable rather than about Club Arena being
 * dark, so it binds here too. The scheme block declares chrome tokens only; a
 * light FELT, if one is ever wanted, is a table theme preset.
 */

/** The attribute this scheme is published on. One writer, one reader. */
export const ARENA_SCHEME_ATTR = 'data-arena-scheme';

/** The only value it takes. Absent means the estate's dark scheme. */
export const ARENA_SCHEME_LIGHT = 'light';

import { isDiamondArenaClubKey, isDiamondArenaClubPath } from './constants';

/**
 * The scheme for where the player is right now, or null for the dark estate.
 *
 * Two inputs, the same two `shouldShowClubFooterFor` takes, and for the same
 * reason: the in-table "+" opens a club lobby as a TAB while the URL stays on
 * /table/<id>, so a route gate alone would send a player into the Diamond
 * lobby with the chip estate's chrome around it.
 */
export function arenaSchemeFor(
  pathname: string,
  selectedClubId?: string | null
): typeof ARENA_SCHEME_LIGHT | null {
  if (isDiamondArenaClubPath(pathname)) return ARENA_SCHEME_LIGHT;
  if (selectedClubId && isDiamondArenaClubKey(selectedClubId)) return ARENA_SCHEME_LIGHT;
  return null;
}

/**
 * Publish it, or take it away. Idempotent, so an effect that re-runs on every
 * navigation costs one attribute read.
 */
export function applyArenaScheme(scheme: typeof ARENA_SCHEME_LIGHT | null): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  if (scheme === null) {
    if (root.hasAttribute(ARENA_SCHEME_ATTR)) root.removeAttribute(ARENA_SCHEME_ATTR);
    return;
  }
  if (root.getAttribute(ARENA_SCHEME_ATTR) !== scheme) root.setAttribute(ARENA_SCHEME_ATTR, scheme);
}
