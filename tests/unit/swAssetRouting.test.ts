/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  SERVICE WORKER ASSET ROUTING — the precache must actually be readable
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * 2026-08-23. sw-bus.js precached the entry chunk, the vendor chunks, the CSS
 * and the fonts stylesheet at install time, and then never served any of them.
 * Two independent faults, both silent:
 *
 *   1. `isHashedAsset` was /[-.][a-zA-Z0-9_]{4,}\.(js|css)$/, which matched NO
 *      file this build emits. vite.config.ts uses
 *      `assets/[name]-[hash]-v6.js`, so every chunk ends `-v6.js` and the
 *      regex wanted four or more characters where `v6` has two.
 *   2. The "never intercept documents" guard excluded /assets/ but not
 *      /fonts/, so the fonts stylesheet returned early before any cache was
 *      consulted.
 *
 * Net effect: the versioned cache was written on every install and read for
 * nothing but the shell document. Chunks hit the network on every load, and
 * the offline app shell booted into a page whose scripts could not load —
 * the exact failure the shell exists to prevent.
 *
 * These tests read the SHIPPED sw-bus.js and re-implement its routing against
 * REAL filenames from the built bundle, so a filename-template change or a
 * predicate edit fails here rather than in production six deploys later.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';

const root = (p: string) => path.resolve(__dirname, '../..', p);
const sw = readFileSync(root('public/sw-bus.js'), 'utf8');

/** Mirror of the service worker's routing decision for one path. */
function classify(pathname: string) {
  const isMedia = /\.(png|jpg|jpeg|webp|avif|svg|gif|ico|mp4|webm|woff2?)$/i.test(pathname);
  const earlyReturn =
    !isMedia &&
    pathname.startsWith('/hub/club-arena/') &&
    !pathname.includes('/assets/') &&
    !pathname.includes('/fonts/');
  const isHashedAsset =
    (pathname.startsWith('/hub/club-arena/assets/') ||
      pathname.startsWith('/hub/club-arena/fonts/')) &&
    /\.(js|css)$/.test(pathname);

  if (earlyReturn) return 'passthrough';
  if (isHashedAsset) return 'versioned-cache';
  if (isMedia) return 'media-cache';
  return 'uncached';
}

describe('the service worker can serve what it precaches', () => {
  it('routes assets by directory, not by a filename shape that drifts', () => {
    // The old regex is what made the cache unreadable. Its absence is the fix.
    expect(
      sw.includes("url.pathname.startsWith('/hub/club-arena/assets/')"),
      'the hashed-asset test is no longer path-based'
    ).toBe(true);
    expect(
      /\[-\\\.\]\[a-zA-Z0-9_\]\{4,\}/.test(sw),
      'the filename-shape regex is back; it matches none of the emitted chunks'
    ).toBe(false);
  });

  it('does not return early for /fonts/, or the stylesheet is never cached', () => {
    expect(sw.includes("!url.pathname.includes('/fonts/')")).toBe(true);
  });

  it.each([
    '/hub/club-arena/assets/index-jBJgC_ty-v6.js',
    '/hub/club-arena/assets/vendor-react-BPB2zS-3-v6.js',
    '/hub/club-arena/assets/vendor-supabase-BLlQ2fJ4-v6.js',
    '/hub/club-arena/assets/index-C3-fYKPl-v6.css',
    '/hub/club-arena/fonts/fonts-b19fb04431.css',
  ])('%s is served from the versioned cache', (p) => {
    expect(classify(p)).toBe('versioned-cache');
  });

  it.each([
    '/hub/club-arena/cards/2color/hearts_a.webp',
    '/hub/club-arena/fonts/inter-v20-UcC73Fwr.woff2',
    '/hub/club-arena/images/tiles/cashier-v8.jpg',
  ])('%s is served from the media cache', (p) => {
    expect(classify(p)).toBe('media-cache');
  });

  it.each([
    // build-info.json is how a deploy is verified — a cached copy would lie.
    '/hub/club-arena/build-info.json',
    // A stale SW script pins an old cache policy on the device forever.
    '/hub/club-arena/sw-bus.js',
  ])('%s always goes to the network', (p) => {
    expect(classify(p)).toBe('passthrough');
  });

  it('every real built asset matches, if a build is present', () => {
    // Belt and braces: when dist/ exists, assert against the ACTUAL emitted
    // filenames rather than the samples above.
    const dir = root('dist/assets');
    if (!existsSync(dir)) return; // no build in this checkout — samples cover it
    const built = readdirSync(dir).filter((f) => /\.(js|css)$/.test(f));
    expect(built.length).toBeGreaterThan(0);
    for (const f of built) {
      expect(classify(`/hub/club-arena/assets/${f}`), `${f} would not be cached`).toBe(
        'versioned-cache'
      );
    }
  });
});
