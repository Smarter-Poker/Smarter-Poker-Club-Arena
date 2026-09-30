/**
 * AN OLD SERVICE WORKER AND ITS CACHED BUNDLE, AFTER A DEPLOY
 * (Diamond Phase 11, line 7: "Test old bookmarks, expired/revoked sessions,
 * stale storage, service workers and mobile rotation").
 *
 * The unit suites pin the rules one at a time (swBootLatency, shellUpdateGate,
 * homeScreenShellRecovery, lazyWithRetry). This file runs them together, in a
 * real browser, against two real builds deployed one over the other on a
 * production-shaped origin (deploy-server.mjs), and asks the three questions a
 * player's device actually asks after a deploy:
 *
 *   1. Does my next visit run the new build, and are the old caches gone?
 *   2. If I booted the old build anyway, is it the WHOLE old build (never a
 *      mix of old and new chunks), and do I reach the new one once, not in a
 *      loop?
 *   3. If an old chunk has vanished, do I land on the new build, not on a
 *      dead screen?
 *
 * "No mixed chunks" is measured on everything the page loaded, whichever
 * layer served it (network, service worker or HTTP cache), from the
 * Resource Timing entries, against the asset list of each build on disk.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

const DIST_A = process.env.STALE_CLIENT_DIST_A || '';
const DIST_B = process.env.STALE_CLIENT_DIST_B || '';

interface Build {
  entry: string;
  cache: string;
  assets: Set<string>;
}

function readBuild(dir: string): Build {
  const html = readFileSync(join(dir, 'index.html'), 'utf8');
  const sw = readFileSync(join(dir, 'sw-bus.js'), 'utf8');
  const entry = html.match(/assets\/index-[A-Za-z0-9_-]+\.js/)?.[0];
  const stamp = sw.match(/const DEPLOY_TS = '(\d+)'/)?.[1];
  if (!entry || !stamp) throw new Error(`${dir} is not a finished build`);
  return { entry, cache: `club-arena-${stamp}`, assets: new Set(readdirSync(join(dir, 'assets'))) };
}

test.skip(!DIST_A || !DIST_B, 'needs two builds: see playwright.stale-client.config.ts');
const A = DIST_A ? readBuild(DIST_A) : (null as unknown as Build);
const B = DIST_B ? readBuild(DIST_B) : (null as unknown as Build);

async function deploy(
  request: APIRequestContext,
  to: 'a' | 'b',
  opts: { pool?: 'keep' | 'prune'; shellDelayMs?: number } = {}
): Promise<void> {
  const q = new URLSearchParams({
    to,
    pool: opts.pool ?? 'keep',
    shellDelayMs: String(opts.shellDelayMs ?? 0),
  });
  // A root path resolves against the configured origin, whatever its port.
  expect((await request.get(`/__deploy?${q}`)).ok()).toBe(true);
}

/**
 * The build this document is executing: the entry chunk its shell names. Null
 * while a navigation is replacing the document - which is exactly what the
 * update gate does - so a poll keeps asking instead of failing on the reload.
 */
function running(page: Page): Promise<string | null> {
  return page
    .evaluate(
      () =>
        document.documentElement.outerHTML.match(/assets\/index-[A-Za-z0-9_-]+\.js/)?.[0] ?? null
    )
    .catch(() => null);
}

function cacheNames(page: Page): Promise<string[]> {
  return page.evaluate(() => caches.keys()).catch(() => []);
}

/** Every chunk and stylesheet this document loaded, from any layer. */
function loadedAssets(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    performance
      .getEntriesByType('resource')
      .map((e) => new URL(e.name).pathname)
      .filter((p) => p.startsWith('/hub/club-arena/assets/'))
      .map((p) => p.slice('/hub/club-arena/assets/'.length))
  );
}

function outside(build: Build, files: string[]): string[] {
  return files.filter((f) => !build.assets.has(f));
}

/** The Club Arena worker controls this page and holds this build's shell. */
async function controlledBy(page: Page, cache: string): Promise<boolean> {
  return page.evaluate(async (name) => {
    if (!navigator.serviceWorker.controller) return false;
    if (!(await caches.keys()).includes(name)) return false;
    return !!(await (await caches.open(name)).match('/hub/club-arena'));
  }, cache);
}

/** Visit once, so the device holds this build's worker and precached shell. */
async function becomeReturningClient(page: Page, build: Build): Promise<void> {
  await page.goto('legal');
  await expect(page.getByRole('heading', { name: 'Legal Center' })).toBeVisible();
  await expect.poll(() => controlledBy(page, build.cache), { timeout: 30_000 }).toBe(true);
  expect(await running(page)).toBe(build.entry);
}

/** Whole documents loaded in this tab (history.pushState is not one). */
function countDocumentLoads(page: Page): { count: number } {
  const loads = { count: 0 };
  page.on('load', () => {
    loads.count += 1;
  });
  return loads;
}

test.beforeEach(async ({ request }) => {
  await deploy(request, 'a', { pool: 'prune' });
});

test('the next visit after a deploy runs the new build, whole, and the visit after retires the old worker', async ({
  page,
  request,
}) => {
  await becomeReturningClient(page, A);
  const context = page.context();
  await page.close();

  await deploy(request, 'b');
  const next = await context.newPage();
  const loads = countDocumentLoads(next);
  await next.goto('legal');
  await expect(next.getByRole('heading', { name: 'Legal Center' })).toBeVisible();

  /* The old worker answered this navigation; its 300ms race is won by the
     network, so the document is the new shell from the first paint. */
  await expect.poll(() => running(next), { timeout: 30_000 }).toBe(B.entry);
  const loaded = await loadedAssets(next);
  expect(loaded.length).toBeGreaterThan(0);
  expect(outside(B, loaded), 'a chunk from another build ran in this document').toEqual([]);
  /* One document, or one adoption reload if the freshness race was lost. */
  expect(loads.count).toBeLessThanOrEqual(2);

  /* Chromium activates the new worker (skipWaiting) once the old one has no
     work in flight, which an open tab can defer (measured 2026-09-30: on
     /legal it waits until the tab navigates; on /health it is immediate).
     The tab is already running the new build, so what matters is the NEXT
     visit: the old worker and its versioned cache are gone by then. */
  await next.close();
  const third = await context.newPage();
  await third.goto('legal');
  await expect(third.getByRole('heading', { name: 'Legal Center' })).toBeVisible();
  expect(await running(third)).toBe(B.entry);
  await expect.poll(() => controlledBy(third, B.cache), { timeout: 30_000 }).toBe(true);
  await expect
    .poll(async () => (await cacheNames(third)).includes(A.cache), { timeout: 30_000 })
    .toBe(false);
  expect(outside(B, await loadedAssets(third))).toEqual([]);
  console.log(
    `[next visit] ran ${B.entry} after ${loads.count} document load(s), ${loaded.length} ` +
      `assets, 0 foreign; the visit after: controlled by the new worker, caches ` +
      `${JSON.stringify(await cacheNames(third))}`
  );
});

test('a boot that lost the freshness race runs the whole old build, then adopts the new one once', async ({
  page,
  request,
}) => {
  await becomeReturningClient(page, A);
  const context = page.context();
  await page.close();

  /* A slow shell: the worker's 300ms race is lost and the cached old shell
     boots. That is the only way an old build can start after a deploy. */
  await deploy(request, 'b', { shellDelayMs: 2_000 });
  const next = await context.newPage();
  const loads = countDocumentLoads(next);
  await next.goto('legal');
  await expect(next.getByRole('heading', { name: 'Legal Center' })).toBeVisible();

  /* Deterministic: the navigation is answered by the OLD worker, and its
     race against a 2s shell is lost at 300ms. */
  const first = await running(next);
  expect(first, 'the premise: the cached old shell booted').toBe(A.entry);
  const oldBoot = await loadedAssets(next);
  expect(outside(A, oldBoot), 'the old build ran a new chunk').toEqual([]);

  /* The gate verifies (the deployed shell names another entry), then reloads
     at a safe moment: not at a table, visible, once. */
  await expect.poll(() => running(next), { timeout: 60_000 }).toBe(B.entry);
  await expect(next.getByRole('heading', { name: 'Legal Center' })).toBeVisible();
  expect(outside(B, await loadedAssets(next)), 'the new build ran an old chunk').toEqual([]);
  const reloadedAt = await next.evaluate(() => sessionStorage.getItem('ca_shell_reload_at'));
  expect(reloadedAt, 'the adoption was the gate, on the record').not.toBeNull();

  /* No loop: exactly one adoption reload, and nothing follows it. */
  expect(loads.count).toBe(2);
  await next.waitForTimeout(12_000);
  expect(loads.count).toBe(2);
  console.log(
    `[race lost] booted ${first} (${oldBoot.length} old-build assets, 0 foreign), ` +
      `adopted ${B.entry} with one reload, no further reload in 12s`
  );
});

test('an old client whose chunk has vanished recovers onto the new build, not a dead screen', async ({
  page,
  request,
}) => {
  await becomeReturningClient(page, A);
  const healthA = [...A.assets].find((f) => /^HealthCheckPage-.*\.js$/.test(f));
  expect(healthA && !B.assets.has(healthA), 'the health chunk must change between builds').toBe(
    true
  );

  /* The case production's append-only pool never produces: the old build's
     chunks are gone. The open tab asks for a route it has not loaded yet. */
  await deploy(request, 'b', { pool: 'prune' });
  await page.evaluate(() => {
    history.pushState({}, '', '/hub/club-arena/health');
    window.dispatchEvent(new PopStateEvent('popstate'));
  });

  await expect.poll(() => running(page), { timeout: 60_000 }).toBe(B.entry);
  expect(new URL(page.url()).pathname).toBe('/hub/club-arena/health');
  await expect(page.locator('body')).not.toContainText('Something Went Wrong');
  await expect(page.locator('#root')).not.toBeEmpty();
  const recovered = await loadedAssets(page);
  expect(outside(B, recovered)).toEqual([]);
  console.log(
    `[pruned pool] ${healthA} was gone; the tab recovered to ${B.entry} at ` +
      `${new URL(page.url()).pathname}${new URL(page.url()).search} (${recovered.length} assets, 0 foreign)`
  );
});

test('no worker serves a retired Diamond page, and an alias inside the app is a clear not-found', async ({
  page,
}) => {
  await becomeReturningClient(page, A);

  const retired = await page.goto('/hub/diamond-arena');
  expect(retired?.status()).toBe(404);
  await expect(page.locator('[data-stub="world-hub-404"]')).toBeVisible();

  /* Inside the app's own scope the shell is served for every path, so the
     answer is the router's: a named not-found, never the arena. */
  await page.goto('diamond-arena');
  await expect(page.getByText('This Arena Door Is Closed')).toBeVisible({ timeout: 30_000 });
  expect(new URL(page.url()).pathname).toBe('/hub/club-arena/diamond-arena');
});
