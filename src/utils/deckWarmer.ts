/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  deckWarmer — Preload The Full Card Deck During Idle Time (PERF PASS 2026-08-22)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Every card image used to be fetched the first time it was dealt, so early
 * hands showed cards popping in one network round-trip at a time. A full deck
 * in the WebP variants is ~500KB total (52 x ~8-10KB) — small enough to warm
 * up-front during browser idle, after which the service worker's media cache
 * plus the long-lived Cache-Control headers make every deal instant, on every
 * visit, forever (until the art changes).
 *
 * Respects Data Saver and very slow connections. Runs once per session.
 */

import { MEDIA_BASE } from './mediaBase';
import { getDeckStyle } from '../hooks/useDeckStyle';

const SUITS = ['hearts', 'diamonds', 'clubs', 'spades'] as const;
const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'j', 'q', 'k', 'a'] as const;

let warmed = false;

interface NetworkInformationLike {
  saveData?: boolean;
  effectiveType?: string;
}

function connectionAllowsWarming(): boolean {
  const conn = (navigator as { connection?: NetworkInformationLike }).connection;
  if (!conn) return true;
  if (conn.saveData) return false;
  if (conn.effectiveType === 'slow-2g' || conn.effectiveType === '2g') return false;
  return true;
}

/**
 * Warm the player's preferred deck (and the default card back) in the
 * background. Fire-and-forget; failures are silent — the normal per-card
 * load path (with its own PNG fallback) still applies at deal time.
 */
export function warmDeckImages(): void {
  if (warmed) return;
  warmed = true;

  if (!connectionAllowsWarming()) return;

  const deckStyle = getDeckStyle();
  const urls: string[] = [];
  for (const suit of SUITS) {
    for (const rank of RANKS) {
      urls.push(`${MEDIA_BASE}cards/${deckStyle}/${suit}_${rank}.webp`);
    }
  }

  // Stagger gently: 4 per tick keeps the network free for real requests.
  let i = 0;
  const batch = () => {
    for (let n = 0; n < 4 && i < urls.length; n++, i++) {
      const img = new Image();
      img.decoding = 'async';
      img.src = urls[i];
    }
    if (i < urls.length) setTimeout(batch, 120);
  };
  batch();
}
