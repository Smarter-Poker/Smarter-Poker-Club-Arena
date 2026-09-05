/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  ASSET PRELOADING (spec 41, 42)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * PHASE 2 2026-09-05. "Do not wait for the reveal before decoding the card
 * face." The face is behind `backface-visibility: hidden` for the first half
 * of the flip, so on a warm cache the browser has ~180ms of cover to decode
 * it and nobody ever sees the gap. On a cold one - a card design a player has
 * never been dealt, a phone that evicted the cache, the first hand after a
 * deploy changed every asset hash - the face can arrive AFTER the surfaces
 * have already swapped, and the card turns over to an empty white box.
 *
 * So the moment a presentation starts, the face is decoded off to the side.
 * `HTMLImageElement.decode()` is the right call: it resolves when the bitmap
 * is ready to paint, not merely when the bytes have landed.
 *
 * Fire and forget, and never awaited by anything: a decode that fails, is
 * unsupported, or is slow must not hold up an animation, let alone a hand.
 * The cache is a Set of URLs already asked for, so a thousand hands of the
 * same deck cost one decode each.
 */

const requested = new Set<string>();

/** How many distinct urls to remember before starting over (52 + backs). */
const MAX_REMEMBERED = 128;

export function preloadImage(url: string | null | undefined): void {
  if (!url) return;
  if (typeof Image === 'undefined') return;
  if (requested.has(url)) return;
  if (requested.size >= MAX_REMEMBERED) requested.clear();
  requested.add(url);
  try {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    // decode() rejects on a 404 or an aborted load; neither is this module's
    // problem, and an unhandled rejection in the console would be.
    void img.decode?.().catch(() => {});
  } catch {
    /* no Image in this environment - the animation is unaffected */
  }
}

/** Test seam. */
export function resetPreloadCache(): void {
  requested.clear();
}

export function preloadCount(): number {
  return requested.size;
}
