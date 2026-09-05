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
  if (requested.has(url)) {
    // Refresh its place so the deck in play is never the thing evicted.
    requested.delete(url);
    requested.add(url);
    return;
  }
  /* AUDIT FIX 2026-09-05: evict ONE, oldest first. This used to `clear()` the
     whole set at the ceiling, so a player near the boundary - two decks is
     104 faces plus backs - re-decoded a card they had just decoded, every
     time they crossed it. */
  while (requested.size >= MAX_REMEMBERED) {
    const oldest = requested.values().next().value;
    if (oldest === undefined) break;
    requested.delete(oldest);
  }
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
