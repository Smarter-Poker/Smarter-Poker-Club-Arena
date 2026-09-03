/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * MEDIA BASE — Phase U5.3 (Cloudflare R2 static-asset offload)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Every LARGE static media reference (cards/, images/, club-logos/, videos/,
 * game-card-icons/) resolves through this helper instead of raw
 * `import.meta.env.BASE_URL`, so the media origin can be flipped to a CDN
 * with a single build-time env var:
 *
 *   VITE_MEDIA_BASE unset  -> same-origin `/hub/club-arena/` (today's behavior,
 *                             byte-identical URLs)
 *   VITE_MEDIA_BASE set    -> e.g. `https://static.smarter.poker/club-arena/`
 *                             (R2 bucket behind a custom domain)
 *
 * DO NOT route code-split JS/CSS, `sw-bus.js`, or the router basename through
 * this — those must stay same-origin for deploy atomicity and service-worker
 * scope rules. This helper is for media files only.
 */

const raw = (import.meta.env.VITE_MEDIA_BASE as string | undefined)?.trim();

export const MEDIA_BASE: string =
  raw && raw.length > 0
    ? raw.endsWith('/')
      ? raw
      : `${raw}/`
    : import.meta.env.BASE_URL || '/hub/club-arena/';

/** Convenience for one-off paths: mediaUrl('images/foo.png') */
export function mediaUrl(relPath: string): string {
  return `${MEDIA_BASE}${relPath.replace(/^\//, '')}`;
}
