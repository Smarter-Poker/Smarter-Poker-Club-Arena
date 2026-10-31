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

/** Each requested URL mapped to the URL that actually decoded (itself, or the
 *  retry that succeeded), so a later caller paints the copy the browser has. */
const decoded = new Map<string, string>();
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
      // A successful fetch is not a decoded image. Keep a rejected decode
      // out of the session cache and let the existing bounded load retry it.
      if (typeof img.decode === 'function') img.decode().then(done, reject);
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
  const known = decoded.get(url);
  if (known) return Promise.resolve(known);
  const existing = inflight.get(url);
  if (existing) return existing;
  const run = (async () => {
    for (let attempt = 0; ; attempt += 1) {
      if (attempt >= TABLE_ART_MAX_ATTEMPTS) throw new Error('table_art_unavailable');
      const candidate = withAttempt(url, attempt);
      try {
        await loadOnce(candidate);
        decoded.set(url, candidate);
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

/** The URL to paint for `url`: the decoded copy when there is one. */
export function decodedTableImageUrl(url: string): string {
  return decoded.get(url) ?? url;
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

export function useTableArt(
  skinUrl: string,
  backgroundUrl: string,
  selectionReady = true,
  selectionScope = 'default'
): TableArt {
  const both = () =>
    selectionReady && isTableImageDecoded(skinUrl) && isTableImageDecoded(backgroundUrl);
  const [state, setState] = useState(() => ({
    key: `${skinUrl}|${backgroundUrl}`,
    scope: selectionScope,
    skinSrc: decodedTableImageUrl(skinUrl),
    backgroundSrc: decodedTableImageUrl(backgroundUrl),
    ready: both(),
  }));
  const [coverExpired, setCoverExpired] = useState(false);
  /* A shared load gives up after TABLE_ART_MAX_ATTEMPTS. Before 2026-10-16
     that ended this table's art for the rest of the mount (nothing in the
     effect's dependencies changes), contradicting "retried for as long as the
     table is open". A spent load now starts a fresh shared one after the
     longest backoff, and stops the moment the table closes or the art changes. */
  const [retryRound, setRetryRound] = useState(0);
  const key = `${skinUrl}|${backgroundUrl}`;

  useEffect(() => {
    if (!selectionReady) return;
    let cancelled = false;
    let retryTimer: number | undefined;
    void Promise.all([loadTableImage(skinUrl), loadTableImage(backgroundUrl)])
      .then(([skinSrc, backgroundSrc]) => {
        if (!cancelled)
          setState({ key, scope: selectionScope, skinSrc, backgroundSrc, ready: true });
      })
      .catch(() => {
        if (cancelled) return;
        retryTimer = window.setTimeout(
          () => setRetryRound((round) => round + 1),
          TABLE_ART_RETRY_MS[TABLE_ART_RETRY_MS.length - 1]
        );
      });
    return () => {
      cancelled = true;
      if (retryTimer !== undefined) window.clearTimeout(retryTimer);
    };
  }, [key, skinUrl, backgroundUrl, selectionReady, selectionScope, retryRound]);

  useEffect(() => {
    const id = window.setTimeout(() => setCoverExpired(true), TABLE_ART_MAX_COVER_MS);
    return () => window.clearTimeout(id);
  }, []);

  // A theme change keeps painting the previous, already-decoded art until the
  // new pair has decoded, so the felt never blinks out mid-session.
  const current = state.key === key && state.scope === selectionScope;
  const ready = current ? state.ready : false;
  const everReady = state.ready && state.scope === selectionScope;
  return {
    skinSrc: !selectionReady
      ? ''
      : current || !everReady
        ? current
          ? state.skinSrc
          : skinUrl
        : state.skinSrc,
    backgroundSrc: !selectionReady
      ? ''
      : current || !everReady
        ? current
          ? state.backgroundSrc
          : backgroundUrl
        : state.backgroundSrc,
    ready: selectionReady && ready,
    // Preserve the existing gameplay deadline. A failed preference read may
    // leave neutral artwork, but must never conceal a seated player's turn.
    reveal: (selectionReady && (ready || everReady)) || coverExpired,
  };
}
