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

// ═══════════════════════════════════════════════════════════════════════════════
// DEFAULT BACKDROP — Dan 2026-08-20: "EVERY SINGLE TABLE NEEDS A BACKGROUND...
// IT SHOULD NEVER BE BLANK. WE NEED A DEFAULT BACKGROUND."
// ═══════════════════════════════════════════════════════════════════════════════
//
// resolveBackground() always returns a real asset URL, but a URL is not a
// rendered pixel: if the JPG 404s (pruned/renamed asset, CDN miss), fails to
// decode, or is still in flight on a cold connection, `background-image:
// url(...)` paints NOTHING and the player stares at a blank page.
//
// The fix is a painted floor. CSS multi-layer backgrounds composite top-to-
// bottom and each layer fails independently, so listing the designed artwork
// FIRST and a pure-CSS backdrop BENEATH it means the CSS always paints —
// instantly, with no network — and the artwork simply layers over it when it
// arrives. There is no state in which the page has no background.
//
// The backdrop is deliberately designed rather than a flat fill: a warm centre
// pool where the table sits, a cool corner falloff, and a fine diagonal weave
// so large screens read as a room instead of a void. It also carries the
// desktop composition for the ten designed backgrounds, which are authored
// portrait (750x1624) and therefore crop to a near-featureless slice on a wide
// viewport.

/**
 * AMBIENCE — painted ON TOP of the artwork.
 *
 * 2026-08-20 follow-up: guaranteeing a layer *underneath* stopped the page
 * being empty when an asset fails, but it did nothing for the reported
 * symptom, because the artwork does load — it is simply almost invisible.
 * Update 2026-08-20: Backgrounds were regenerated in landscape (2560x1440) with higher luma (55-85),
 * so they are no longer near-black or heavily cropped on wide viewports. A backdrop hidden *behind* that reads exactly as blank.
 *
 * So the ambience moves above the art: a soft pool lifts the centre where the
 * table sits, and a vignette frames the edges. The artwork still reads —
 * these are translucent — but the page is now unmistakably a lit room instead
 * of a void, on every design and at every viewport ratio.
 */
export const DEFAULT_TABLE_AMBIENCE = [
  // Vignette frames the edges (topmost)
  'radial-gradient(ellipse 120% 100% at 50% 55%, transparent 30%, rgba(0,0,0,0.5) 100%)',
  // Soft pool of light where the table sits
  'radial-gradient(ellipse 88% 60% at 50% 46%, rgba(84,116,168,0.30) 0%, rgba(38,54,86,0.16) 45%, transparent 74%)',
].join(', ');

/**
 * Pure-CSS designed floor, painted UNDER the artwork. Zero network
 * dependency — this is what guarantees the page is never blank.
 */
export const DEFAULT_TABLE_BACKDROP = [
  // Fine diagonal weave — texture that survives any upscale
  'repeating-linear-gradient(45deg, rgba(255,255,255,0.014) 0px, rgba(255,255,255,0.014) 1px, transparent 1px, transparent 14px)',
  // Deep base gradient
  'linear-gradient(180deg, #101828 0%, #0b1424 45%, #060a12 100%)',
].join(', ');

/** Solid base colour — the last line of defence behind every layer. */
export const DEFAULT_TABLE_BACKDROP_COLOR = '#0a1020';

/**
 * Full `background-image` value for the table page: the selected design first,
 * the always-paints CSS backdrop underneath.
 *
 * @param bid stored background_id (unknown/empty ids fall back to midnight)
 */
export function resolveBackgroundLayers(bid?: string | null): string {
  const asset = resolveBackground(bid || 'midnight');
  // Paint order, top to bottom: ambience over artwork over the always-paints
  // CSS floor. Layers fail independently, so the floor survives any asset
  // problem and the ambience survives even that.
  return asset
    ? `${DEFAULT_TABLE_AMBIENCE}, url(${asset}), ${DEFAULT_TABLE_BACKDROP}`
    : `${DEFAULT_TABLE_AMBIENCE}, ${DEFAULT_TABLE_BACKDROP}`;
}

// Five layers: vignette, pool, artwork, weave, base. Only the weave tiles.
/** Matching background-size list. */
export const TABLE_BACKGROUND_SIZE = 'cover, cover, cover, auto, cover';
/** Matching background-position list. */
export const TABLE_BACKGROUND_POSITION =
  'center center, center center, center center, center center, center center';
/** Matching background-repeat list — only the weave tiles. */
export const TABLE_BACKGROUND_REPEAT = 'no-repeat, no-repeat, no-repeat, repeat, no-repeat';
