/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  generate-arena-sitemap - the arena tells crawlers its own public pages
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * DISCOVERABILITY PHASE 2 (2026-09-17). Until now the World Hub's
 * pages/sitemap.xml.js carried a hand-typed list of Club Arena URLs. Two
 * repositories, one list, no check between them: a public route added here
 * was invisible to Google until somebody remembered the other repo, and a
 * route retired here stayed advertised there.
 *
 * This runs at the end of build:ci, after prerender-public-routes.mjs, and
 * writes dist/sitemap.xml from dist/prerender-manifest.json: exactly the
 * routes the arena prerenders (the ones src/lib/seo.ts marks indexable, minus
 * the documented exceptions). It is served at
 * https://smarter.poker/hub/club-arena/sitemap.xml through the same rewrite
 * as build-info.json, and robots.txt on the World Hub names it beside the
 * hub's own sitemap. The hub's hand list is gone.
 *
 * lastmod is EVIDENCE, not the build date: the newest commit touching the
 * route's own source (its page, its copy, and seo.ts for its title and
 * description). A sitemap whose every lastmod is "today" tells Google
 * nothing, and Google says as much; one that moves only when the page moved
 * is one it can trust. The publish job checks out with fetch-depth 0, so the
 * dates are real there; anywhere without history the build date is used and
 * said so.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.resolve(ROOT, process.env.CA_DIST || 'dist');
const SITE = 'https://smarter.poker';
const WEB_BASE = '/hub/club-arena';

/** The files whose history dates each route. seo.ts carries every title and description. */
const SOURCES = {
  '/': ['src/pages/PokerArenaLandingPage.tsx', 'src/pages/PokerArenaLandingPage.module.css'],
  '/help': ['src/pages/helpContent.ts', 'src/prerender/HelpPrerender.tsx'],
  '/legal': ['src/pages/legalCenterContent.ts', 'src/prerender/LegalPrerender.tsx'],
  '/legal/tos': ['src/pages/legal/TermsOfServicePage.tsx'],
  '/legal/privacy': ['src/pages/legal/PrivacyPolicyPage.tsx'],
  '/legal/fair-gaming': ['src/pages/legal/FairGamingPage.tsx'],
  '/legal/promotions': ['src/pages/legal/PromotionsPage.tsx'],
};
const SHARED_SOURCES = ['src/lib/seo.ts'];

const PRIORITY = {
  '/': ['0.9', 'weekly'],
  '/help': ['0.6', 'monthly'],
  '/legal': ['0.4', 'yearly'],
  '/legal/tos': ['0.3', 'yearly'],
  '/legal/privacy': ['0.3', 'yearly'],
  '/legal/fair-gaming': ['0.4', 'yearly'],
  '/legal/promotions': ['0.3', 'yearly'],
};

export function urlFor(route) {
  return `${SITE}${WEB_BASE}${route === '/' ? '' : route}`;
}

function gitDate(files) {
  try {
    const out = execFileSync('git', ['log', '-1', '--format=%cI', '--', ...files], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .trim();
    return out || null;
  } catch {
    return null;
  }
}

/**
 * ONE `git log` PER ROUTE, ASKED ONCE (2026-09-22).
 *
 * This used to spawn a git process PER FILE and then take the newest answer,
 * which is what `git log -1 -- a b c` already returns: the newest commit
 * touching any of the paths. Three spawns became one, for the same date.
 *
 * And the answer is memoised for the life of the process, because both
 * callers ask twice: main() builds the sitemap and then logs every route's
 * date again, and the law test derives the whole set in one case and again in
 * the next. Roughly 30 git subprocesses per full sweep became 7, which is
 * what took the law test over vitest's default 5s budget on a loaded machine
 * and blocked a push with a timeout that named no cause (CLAUDE.md 10.86).
 *
 * Only the git answer is cached. The build-time fallback still reads the
 * clock it was handed.
 */
const gitDateByRoute = new Map();

/** ISO date (YYYY-MM-DD) of the newest commit touching any of the files, or null without history. */
export function lastModFor(route, now = new Date()) {
  if (!gitDateByRoute.has(route)) {
    const files = [...(SOURCES[route] || []), ...SHARED_SOURCES].filter((f) =>
      existsSync(path.join(ROOT, f))
    );
    gitDateByRoute.set(route, files.length ? gitDate(files) : null);
  }
  const newest = gitDateByRoute.get(route);
  if (!newest) return { date: now.toISOString().slice(0, 10), evidence: 'build-time' };
  return { date: new Date(newest).toISOString().slice(0, 10), evidence: 'git' };
}

export function buildSitemap(routes, now = new Date()) {
  const entries = routes.map((route) => {
    const [priority, changefreq] = PRIORITY[route] || ['0.5', 'monthly'];
    const { date } = lastModFor(route, now);
    return `  <url>\n    <loc>${urlFor(route)}</loc>\n    <lastmod>${date}</lastmod>\n    <changefreq>${changefreq}</changefreq>\n    <priority>${priority}</priority>\n  </url>`;
  });
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries.join('\n')}\n</urlset>\n`;
}

function main() {
  if (process.env.VITE_NATIVE === '1') {
    console.log('[arena-sitemap] native build: no sitemap (the app shell is not a website)');
    return;
  }
  const manifestPath = path.join(DIST, 'prerender-manifest.json');
  if (!existsSync(manifestPath)) {
    throw new Error(
      `arena-sitemap: ${manifestPath} missing; run after prerender-public-routes.mjs`
    );
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const routes = manifest.routes.map((r) => r.route);
  const unknown = routes.filter((r) => !PRIORITY[r]);
  if (unknown.length) {
    throw new Error(
      `arena-sitemap: prerendered route(s) with no sitemap entry: ${unknown.join(', ')}. Add them to PRIORITY and SOURCES in scripts/generate-arena-sitemap.mjs.`
    );
  }
  const xml = buildSitemap(routes);
  writeFileSync(path.join(DIST, 'sitemap.xml'), xml);
  for (const route of routes) {
    const { date, evidence } = lastModFor(route);
    console.log(`[arena-sitemap] ${urlFor(route)}  lastmod ${date} (${evidence})`);
  }
  console.log(
    `[arena-sitemap] ${routes.length} URLs -> ${path.relative(ROOT, path.join(DIST, 'sitemap.xml'))}`
  );
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  try {
    main();
  } catch (err) {
    console.error(err.message || err);
    process.exit(1);
  }
}
