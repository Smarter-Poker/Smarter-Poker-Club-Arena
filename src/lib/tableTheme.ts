/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  TABLE THEME RESOLUTION — pure
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Moved out of TablePage.tsx on 2026-08-19. Two one-line lookups, but they are
 * the lookups that decide a player never sees a blank table: any stored id that
 * is unknown, renamed, or simply absent has to fall back to a real asset rather
 * than to undefined.
 */
import { TABLE_SKINS, TABLE_BACKGROUNDS } from '../assets/tableAssets';

/** Resolve a stored table/theme id to a skin asset; default stays green. */
export function resolveSkin(tid: string): string {
  return TABLE_SKINS[tid] || TABLE_SKINS.classic_green;
}

// Dan 2026-08-18 — INTERCHANGEABLE DESIGNED BACKGROUNDS.
// The blurred-skin backdrop is gone ("remove the weird images around the
// table"). The page behind the table is now one of ten standalone designed
// backgrounds, selected on the Theme modal's Background tab and stored in
// user_theme_settings.background_id. Legacy ids alias to the closest design.

export function resolveBackground(bid: string): string {
  return TABLE_BACKGROUNDS[bid] || TABLE_BACKGROUNDS.midnight;
}
