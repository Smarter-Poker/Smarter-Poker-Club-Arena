/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  BOOT LATENCY — the caching layer must actually reach the front door
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * 2026-08-24. Two faults made the whole service-worker caching layer invisible
 * to the most common way anyone enters Club Arena — tapping the tile in the
 * World Hub, which navigates to the bare URL `/hub/club-arena`.
 *
 *   1. SCOPE. `register('/hub/club-arena/sw-bus.js')` with no scope option
 *      takes the script's directory as its scope: `/hub/club-arena/`, WITH the
 *      trailing slash. Scope matching is a plain string prefix, and
 *      `/hub/club-arena/` is not a prefix of `/hub/club-arena`. So the page
 *      served at the bare URL was never controlled, and none of its requests
 *      passed through the worker. Deep links were in scope, which is why the
 *      worker looked like it was working whenever anyone checked.
 *
 *   2. THE SHELL WAS NETWORK-FIRST with a 3.5s deadline, so even a controlled
 *      navigation blocked on a full HTML round trip before the app could
 *      start — while a byte-identical shell sat in the cache from install.
 *
 *   3. And trimCache evicted oldest-first with no exemptions. The precached
 *      shell and boot chunks are written at install and are therefore the
 *      OLDEST entries, so the first trim past the cap threw away exactly the
 *      set that makes a cache-first shell safe.
 *
 * These read the shipped files. They are string-level on purpose: the runtime
 * being pinned is the browser's, and the only thing this repo controls is what
 * it asks the browser for.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const root = (p: string) => path.resolve(__dirname, '../..', p);
const sw = readFileSync(root('public/sw-bus.js'), 'utf8');
const app = readFileSync(root('src/App.tsx'), 'utf8');
const vite = readFileSync(root('vite.config.ts'), 'utf8');

/**
 * The browser's own rule, reproduced: a client is controlled when the
 * registration's scope is a prefix of the client's URL.
 * https://w3c.github.io/ServiceWorker/#scope-match-algorithm
 */
const inScope = (scope: string, clientUrl: string) => clientUrl.startsWith(scope);

describe('service worker scope covers the URL the World Hub links to', () => {
  it('registers with an explicit scope, not the script directory default', () => {
    expect(
      /register\(\s*swPath\s*,\s*\{\s*scope:/.test(app),
      'App.tsx registers without a scope — the bare /hub/club-arena URL is then uncontrolled'
    ).toBe(true);
  });

  it('strips the trailing slash off BASE_URL when deriving that scope', () => {
    // BASE_URL is '/hub/club-arena/'. Handing that straight to `scope` is the
    // original bug wearing an explicit option.
    expect(app.includes("base.replace(/\\/$/, '')")).toBe(true);
  });

  it('falls back to the default scope if the server withholds Service-Worker-Allowed', () => {
    // A wider scope than the script's directory needs that header. Without the
    // fallback a missing header means NO service worker at all, which is
    // strictly worse than the bug being fixed.
    expect(app.match(/\.register\(swPath/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
  });

  it('allows the slashless scope on the local server used by browser tests', () => {
    expect(vite).toContain("'Service-Worker-Allowed': '/hub/club-arena'");
  });

  it('the default scope really does miss the bare URL (this is why)', () => {
    expect(inScope('/hub/club-arena/', '/hub/club-arena')).toBe(false);
    expect(inScope('/hub/club-arena/', '/hub/club-arena/clubs/abc')).toBe(true);
  });

  it('the scope we ask for covers both', () => {
    expect(inScope('/hub/club-arena', '/hub/club-arena')).toBe(true);
    expect(inScope('/hub/club-arena', '/hub/club-arena/clubs/abc')).toBe(true);
  });
});

describe('the app shell is served from cache with a bounded freshness race', () => {
  /* Updated 2026-08-29, same commit as the change it pins, per rule 8 in
     CLAUDE.md §5. Pure cache-first meant every post-deploy entry booted the
     one-deploy-old shell and was then visibly hard-reloaded seconds after
     paint by useShellUpdateGate — Dan: "it like glitches and reloads... it
     looks like broken code. THATS GOT TO STOP HAPPENING." The revalidation
     fetch (already on the wire every navigation) now gets a short fixed
     budget to answer BEFORE the cached shell is returned; if it lands, the
     session boots current and there is nothing to reload. On expiry the
     cached shell is served instantly, exactly as before. */
  it('navigations still resolve from cache when the network is slow — no long deadline', () => {
    expect(sw.includes('shellFromCache'), 'the cache-first shell handler is gone').toBe(true);
    expect(
      sw.includes('networkFirstShell'),
      'the shell is network-first again; every entry pays a full HTML round trip'
    ).toBe(false);
    expect(
      /setTimeout\(\(\) => controller\.abort\(\), 3500\)/.test(sw),
      'the 3.5s navigation deadline is back'
    ).toBe(false);
  });

  it('gives the in-flight revalidation a short budget so a post-deploy entry boots CURRENT', () => {
    const budget = Number(sw.match(/const SHELL_FRESH_RACE_MS = (\d+)/)?.[1]);
    expect(
      budget,
      'the freshness race is gone — the post-deploy boot-then-reload glitch is back'
    ).toBeGreaterThan(0);
    // The budget must stay a blink, not a deadline. 500ms is where "part of
    // loading" starts turning back into "300-800ms of nothing" (2026-08-24).
    expect(budget).toBeLessThanOrEqual(500);
    expect(sw.includes('Promise.race'), 'the race itself is gone').toBe(true);
  });

  it('still revalidates in the background, so a deploy is never more than one navigation away', () => {
    expect(sw.includes('event.waitUntil(revalidate)')).toBe(true);
    expect(sw.includes('SHELL_UPDATED')).toBe(true);
  });

  it('keeps the offline fallback for a device that has never been here', () => {
    expect(sw.includes("cache.match('/hub/club-arena/offline.html')")).toBe(true);
  });
});

describe('cache eviction cannot delete the boot set', () => {
  it('exempts the precached shell and chunks from trimming', () => {
    expect(sw.includes('PROTECTED_PATHS')).toBe(true);
    expect(/const PROTECTED_PATHS = new Set\(\[[^\]]*\.\.\.PRECACHE_URLS/.test(sw)).toBe(true);
  });

  it('declares SHELL_KEY before the set that references it', () => {
    // A `const` read during module evaluation before its declaration throws a
    // TDZ ReferenceError and takes the entire worker down on install.
    expect(sw.indexOf('const SHELL_KEY')).toBeLessThan(sw.indexOf('const PROTECTED_PATHS'));
    expect(sw.indexOf('const PRECACHE_URLS')).toBeLessThan(sw.indexOf('const PROTECTED_PATHS'));
  });

  it('holds more entries than one deploy emits', () => {
    const cap = Number(sw.match(/const MAX_CACHE_ENTRIES = (\d+)/)?.[1]);
    // A full build emits ~330 hashed chunks. A cap below that guarantees
    // eviction of live code inside a single session.
    expect(cap).toBeGreaterThanOrEqual(400);
  });
});
