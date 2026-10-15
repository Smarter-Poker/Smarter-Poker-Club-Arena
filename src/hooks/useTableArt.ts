/**
 * THE TABLE ART ARRIVES TOGETHER, OR THE TABLE WAITS FOR IT (Dan 2026-10-15)
 * ============================================================================
 * Dan, with a screenshot of a live table showing seats, pot and masthead on a
 * plain navy gradient: "SOMETIMES THE 'LIVE GAME PLAY PAGE' LOADS LIKE THIS ...
 * THIS CAN'T HAPPEN AND NEEDS TO BE FIXED. IT MUST ALWAYS LOAD THE ACTUAL
 * TABLE AND BACKGROUND IMAGES AND EVERYTHING AT ONCE."
 *
 * The felt (a ~0.8 MB PNG) and the room (a ~0.3 MB JPG) were handed straight
 * to an <img> and a CSS url() with nothing preloading them, nothing watching
 * them and nothing retrying them. On a cold cache the table drew its seats
 * first and the art "arrived later"; on a dropped fetch the service worker
 * answered with a 0-byte 200 and the art never arrived at all.
 *
 * This loader fetches both, decodes both, and only then says the art is
 * ready, so TablePage reveals the felt, the room and the seats in one frame.
 * A failed or empty image is retried with a fresh URL on a short backoff, for
 * as long as the table is open. Decoded URLs are remembered for the session,
 * so the second table, a table switch or a remount is instant.
 */
import { useEffect, useState } from 'react';

const decoded = new Set<string>();
const inflight = new Map<string, Promise<string>>();

/** Backoff between attempts; the last value repeats. */
export const TABLE_ART_RETRY_MS = [250, 750, 1500, 3000, 5000];

/** After this long the table is shown even if art is still retrying, so a
 *  player is never locked out of their own turn by a picture. */
export const TABLE_ART_MAX_COVER_MS = 12_000;

function withAttempt(url: string, attempt: number): string {
  if (attempt === 0 || url.startsWith('data:')) return url;
  return `${url}${url.includes('?') ? '&' : '?'}r=${attempt}`;
}

function loadOnce(url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.decoding = 'async';
    try {
      (img as HTMLImageElement & { fetchPriority?: string }).fetchPriority = 'high';
    } catch {
      /* older engines */
    }
    img.onload = () => {
      // A 0x0 "image" is the empty body a failed fetch can produce.
      if (!img.naturalWidth || !img.naturalHeight) {
        reject(new Error('empty_image'));
        return;
      }
      const done = () => resolve();
      if (typeof img.decode === 'function') img.decode().then(done, done);
      else done();
    };
    img.onerror = () => reject(new Error('image_failed'));
    img.src = url;
  });
}

/** Attempts before a shared load gives up (about three minutes of backoff). */
export const TABLE_ART_MAX_ATTEMPTS = 40;

/** Resolve to a URL of `url` that has loaded and decoded. One load is shared
 *  by every caller, so it is never cancelled by one of them leaving. */
export function loadTableImage(url: string): Promise<string> {
  if (!url) return Promise.resolve(url);
  if (decoded.has(url)) return Promise.resolve(url);
  const existing = inflight.get(url);
  if (existing) return existing;
  const run = (async () => {
    for (let attempt = 0; ; attempt += 1) {
      if (attempt >= TABLE_ART_MAX_ATTEMPTS) throw new Error('table_art_unavailable');
      const candidate = withAttempt(url, attempt);
      try {
        await loadOnce(candidate);
        decoded.add(url);
        decoded.add(candidate);
        return candidate;
      } catch {
        const wait = TABLE_ART_RETRY_MS[Math.min(attempt, TABLE_ART_RETRY_MS.length - 1)];
        await new Promise((r) => setTimeout(r, wait));
      }
    }
  })();
  inflight.set(url, run);
  run.finally(() => inflight.delete(url)).catch(() => undefined);
  return run;
}

export function isTableImageDecoded(url: string): boolean {
  return !url || decoded.has(url);
}

export interface TableArt {
  /** The felt URL to paint (the original, or the retry that succeeded). */
  skinSrc: string;
  /** The room URL to paint. */
  backgroundSrc: string;
  /** Both images have loaded and decoded. */
  ready: boolean;
  /** The table may be revealed: ready, or the cover has waited long enough. */
  reveal: boolean;
}

export function useTableArt(skinUrl: string, backgroundUrl: string): TableArt {
  const both = () => isTableImageDecoded(skinUrl) && isTableImageDecoded(backgroundUrl);
  const [state, setState] = useState(() => ({
    key: `${skinUrl}|${backgroundUrl}`,
    skinSrc: skinUrl,
    backgroundSrc: backgroundUrl,
    ready: both(),
  }));
  const [coverExpired, setCoverExpired] = useState(false);
  const key = `${skinUrl}|${backgroundUrl}`;

  useEffect(() => {
    let cancelled = false;
    void Promise.all([loadTableImage(skinUrl), loadTableImage(backgroundUrl)])
      .then(([skinSrc, backgroundSrc]) => {
        if (!cancelled) setState({ key, skinSrc, backgroundSrc, ready: true });
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [key, skinUrl, backgroundUrl]);

  useEffect(() => {
    const id = window.setTimeout(() => setCoverExpired(true), TABLE_ART_MAX_COVER_MS);
    return () => window.clearTimeout(id);
  }, []);

  // A theme change keeps painting the previous, already-decoded art until the
  // new pair has decoded, so the felt never blinks out mid-session.
  const current = state.key === key;
  const ready = current ? state.ready : false;
  const everReady = state.ready;
  return {
    skinSrc: current || !everReady ? (current ? state.skinSrc : skinUrl) : state.skinSrc,
    backgroundSrc:
      current || !everReady ? (current ? state.backgroundSrc : backgroundUrl) : state.backgroundSrc,
    ready,
    reveal: ready || everReady || coverExpired,
  };
}
