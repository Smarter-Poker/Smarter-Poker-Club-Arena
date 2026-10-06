/**
 * WHICH REQUESTS A PRODUCTION BROWSER RUN READS FROM THE ARENA ORIGIN
 * (2026-10-04).
 *
 * This module is the pure half of staticOriginDirect.ts: it decides, from a URL
 * alone, whether a request is a Club Arena static file and where the origin
 * keeps it. It imports nothing from Playwright so Vitest can load it
 * (playwright.config.ts explains why the two runners cannot share a process).
 *
 * The World Hub serves /hub/club-arena/<path> by proxying
 * https://ca-static.smarter.poker/<path>, so the mapping is the rewrite
 * itself, applied by the test runner instead of by Vercel.
 *
 * WHAT IS DELIBERATELY NOT REDIRECTED, and stays on the public path:
 *   - the document, every extension-less client route and every .html file:
 *     that is the route a player's browser asks for, and the www redirect, the
 *     jurisdiction gate and the response headers all live there;
 *   - sw-bus.js: a service worker script must come from the page's own origin;
 *   - .json (build-info.json is the release proof and is read through the
 *     public path on purpose), manifests and anything under /api;
 *   - video: media elements read it with range requests, there are three
 *     files, and a buffered detour buys nothing.
 */

export const PRODUCTION_PUBLIC_HOST = 'smarter.poker';
export const PUBLIC_BASE_PATH = '/hub/club-arena/';
export const STATIC_ORIGIN = 'https://ca-static.smarter.poker';

const STATIC_EXTENSION =
  /\.(?:js|mjs|css|png|jpe?g|webp|avif|gif|svg|ico|woff2?|ttf|otf|mp3|ogg|wav|m4a)$/i;
const NEVER_REDIRECTED = new Set(['sw-bus.js']);

/** True when a run configured with this base URL is looking at production. */
export function targetsProduction(baseURL: string): boolean {
  try {
    const parsed = new URL(baseURL);
    return (
      parsed.protocol === 'https:' &&
      parsed.hostname.toLowerCase() === PRODUCTION_PUBLIC_HOST &&
      parsed.pathname.startsWith(PUBLIC_BASE_PATH)
    );
  } catch {
    return false;
  }
}

/**
 * The origin URL for a Club Arena static file requested through the public
 * path, or null when the request must keep travelling through smarter.poker.
 */
export function staticOriginUrl(requestUrl: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(requestUrl);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:') return null;
  if (parsed.hostname.toLowerCase() !== PRODUCTION_PUBLIC_HOST) return null;
  if (!parsed.pathname.startsWith(PUBLIC_BASE_PATH)) return null;
  const relative = parsed.pathname.slice(PUBLIC_BASE_PATH.length);
  if (!relative || relative.includes('..')) return null;
  if (NEVER_REDIRECTED.has(relative)) return null;
  if (!STATIC_EXTENSION.test(relative)) return null;
  return `${STATIC_ORIGIN}/${relative}${parsed.search}`;
}
