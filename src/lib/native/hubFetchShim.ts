/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  HUB FETCH SHIM — relative /api/* calls reach smarter.poker (native only)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Twenty-one call sites in this tree fetch the World Hub's API by a relative
 * path - `fetch('/api/vip/check-status')` - because on the web the Hub is the
 * same origin. Inside the app the origin is capacitor://localhost, where
 * /api/anything is index.html. The audit (tier 1) lists them; rewriting every
 * site is twenty-one edits today and a trap for every site written tomorrow.
 *
 * So the app installs ONE shim at boot, before any fetch: a relative `/api/`
 * request is sent to https://smarter.poker instead. Nothing else changes -
 * headers, method, body, credentials - and the Hub answers with CORS for the
 * two app origins (World Hub middleware section 0). Supabase, error reporting, PostHog
 * and every absolute URL pass straight through.
 *
 * Installed from main.tsx's native boot path. Never loaded on the web.
 */

import { WEB_ORIGIN } from '../appBase';

let installed = false;

function rewrite(input: RequestInfo | URL): RequestInfo | URL {
  if (typeof input === 'string') {
    return input.startsWith('/api/') ? `${WEB_ORIGIN}${input}` : input;
  }
  if (input instanceof URL) {
    if (input.pathname.startsWith('/api/') && input.hostname === 'localhost') {
      return new URL(`${WEB_ORIGIN}${input.pathname}${input.search}`);
    }
    return input;
  }
  if (typeof Request !== 'undefined' && input instanceof Request) {
    try {
      const u = new URL(input.url);
      if (u.pathname.startsWith('/api/') && u.hostname === 'localhost') {
        return new Request(`${WEB_ORIGIN}${u.pathname}${u.search}`, input);
      }
    } catch {
      /* leave it */
    }
  }
  return input;
}

export function installHubFetchShim(): void {
  if (installed || typeof window === 'undefined' || typeof window.fetch !== 'function') return;
  installed = true;
  const original = window.fetch.bind(window);
  window.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
    original(rewrite(input), init)) as typeof window.fetch;
}

/** Test-only. */
export function __rewriteForTests(input: RequestInfo | URL): RequestInfo | URL {
  return rewrite(input);
}
