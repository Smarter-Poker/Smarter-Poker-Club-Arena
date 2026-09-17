/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  check-live-seo-contract - what a crawler gets from PRODUCTION, checked
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * DISCOVERABILITY PHASE 3 (2026-09-17). Every SEO guarantee in this repo is
 * pinned by a unit test that reads source files. None of them look at the
 * site. The failures that matter happen after the build: a rewrite that
 * stops pointing at a prerendered file, a header that reintroduces
 * X-Robots-Tag: noindex, a shell that ships without its JSON-LD block, a
 * sitemap that names a page the origin no longer serves. This reads the
 * live site the way Googlebot does and refuses if the contract is broken.
 *
 * It carries NO hand-typed route list. The contract is derived from what
 * the deployed bundle itself says it published:
 *
 *   1. /hub/club-arena/build-info.json must serve the expected SHA (the
 *      publish that triggered this run), retried while the origin cuts over;
 *   2. /hub/club-arena/prerender-manifest.json lists the prerendered routes
 *      and their titles - every one must serve 200 as static HTML carrying
 *      that title, an indexable robots meta, the exact canonical, no
 *      X-Robots-Tag: noindex, and a parseable JSON-LD document;
 *   3. /hub/club-arena/sitemap.xml must be well formed, name exactly the
 *      manifest routes, and every <loc> must answer 200;
 *   4. the shell for a signed-in route (a deep link) must still carry the
 *      indexable static head - the app flips it to noindex at render time,
 *      which is by design and tested elsewhere.
 *
 * Runs in post-deploy-e2e.yml after the publication gate, independent of
 * the engine certificate. Plain Node 20+, no dependencies.
 *
 * USAGE  node scripts/ci/check-live-seo-contract.mjs [--sha <40 hex>] [--base https://smarter.poker/hub/club-arena]
 */
const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const BASE = opt('--base', 'https://smarter.poker/hub/club-arena').replace(/\/$/, '');
const EXPECTED_SHA = opt('--sha', '');
const UA =
  'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html) smarter-poker-seo-contract';

const problems = [];
const notes = [];
const fail = (msg) => problems.push(msg);

async function get(url) {
  const res = await fetch(`${url}${url.includes('?') ? '&' : '?'}seo-contract=${Date.now()}`, {
    headers: { 'user-agent': UA, 'cache-control': 'no-cache' },
    redirect: 'manual',
  });
  const text = await res.text();
  return { status: res.status, headers: res.headers, text };
}

const attr = (html, re) => {
  const m = html.match(re);
  return m ? m[1] : null;
};

export function inspectHead(html) {
  const title = attr(html, /<title>([^<]*)<\/title>/i);
  const robots = attr(html, /<meta\s+name="robots"\s+content="([^"]*)"/i);
  const canonical = attr(html, /<link\s+rel="canonical"\s+href="([^"]*)"/i);
  const description = attr(html, /<meta\s+name="description"\s+content="([^"]*)"/i);
  const ldRaw = attr(html, /<script type="application\/ld\+json">([\s\S]*?)<\/script>/i);
  let ld = null;
  let ldError = null;
  if (ldRaw) {
    try {
      ld = JSON.parse(ldRaw);
    } catch (e) {
      ldError = e.message;
    }
  }
  const h1 = /<h1[\s>]/i.test(html);
  return { title, robots, canonical, description, ld, ldError, h1 };
}

export function ldTypes(ld) {
  if (!ld) return [];
  const nodes = Array.isArray(ld['@graph']) ? ld['@graph'] : [ld];
  return nodes.map((n) => n && n['@type']).filter(Boolean);
}

export function urlForRoute(route) {
  return `${BASE}${route === '/' ? '' : route}`;
}

/** Words a reader gets without JavaScript: the body minus scripts, styles and comments. */
export function bodyWords(html) {
  const body = html.split(/<body[^>]*>/i)[1] || '';
  return body
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .split(/\s+/)
    .filter(Boolean).length;
}

export function parseSitemapLocs(xml) {
  return [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1].trim());
}

async function waitForBuild(sha) {
  for (let i = 1; i <= 18; i += 1) {
    try {
      const { status, text } = await get(`${BASE}/build-info.json`);
      if (status === 200) {
        const info = JSON.parse(text);
        if (!sha || info.ca_sha === sha) {
          notes.push(`build-info.json serves ${info.ca_sha} (run ${info.run_id})`);
          return info.ca_sha;
        }
        notes.push(`attempt ${i}: origin serves ${info.ca_sha}, waiting for ${sha}`);
      } else {
        notes.push(`attempt ${i}: build-info.json ${status}`);
      }
    } catch (e) {
      notes.push(`attempt ${i}: ${e.message}`);
    }
    await new Promise((r) => setTimeout(r, 10000));
  }
  fail(`build-info.json never served ${sha || 'a build'} within three minutes`);
  return null;
}

async function checkRoute(entry) {
  const url = urlForRoute(entry.route);
  const { status, headers, text } = await get(url);
  const where = `${entry.route} (${url})`;
  if (status !== 200) return fail(`${where}: HTTP ${status}, expected 200`);
  const xr = headers.get('x-robots-tag') || '';
  if (/noindex/i.test(xr)) fail(`${where}: X-Robots-Tag says noindex (${xr})`);
  const head = inspectHead(text);
  const wantTitle = entry.title.includes('Smarter.Poker')
    ? entry.title
    : `${entry.title} | Smarter.Poker`;
  if (head.title !== wantTitle)
    fail(
      `${where}: <title> is ${JSON.stringify(head.title)}, expected ${JSON.stringify(wantTitle)}`
    );
  if (!head.robots || !/^index,\s*follow/i.test(head.robots))
    fail(`${where}: robots meta is ${JSON.stringify(head.robots)}, expected index, follow`);
  if (head.canonical !== url)
    fail(`${where}: canonical is ${JSON.stringify(head.canonical)}, expected ${url}`);
  if (!head.description || head.description.length < 60)
    fail(`${where}: description missing or under 60 characters`);
  if (head.ldError) fail(`${where}: JSON-LD does not parse: ${head.ldError}`);
  else if (!head.ld) fail(`${where}: no JSON-LD block`);
  else if (ldTypes(head.ld).length === 0) fail(`${where}: JSON-LD carries no @type`);
  if (!head.h1) fail(`${where}: no <h1> in the static HTML (not prerendered?)`);
  const words = bodyWords(text);
  if (words < 100)
    fail(
      `${where}: only ${words} words of prerendered content in <body> (the landing lives in #prerender-landing, every other route in #root)`
    );
  notes.push(`${entry.route}: ok (${head.title}; ${ldTypes(head.ld).join(', ')}; ${words} words)`);
}

async function main() {
  const sha = await waitForBuild(EXPECTED_SHA);
  if (!sha) return;

  const manifestRes = await get(`${BASE}/prerender-manifest.json`);
  if (manifestRes.status !== 200) {
    fail(`prerender-manifest.json: HTTP ${manifestRes.status}`);
    return;
  }
  const manifest = JSON.parse(manifestRes.text);
  const routes = manifest.routes || [];
  if (routes.length < 5)
    fail(`prerender-manifest.json lists ${routes.length} routes; expected at least 5`);
  for (const entry of routes) await checkRoute(entry);

  const sm = await get(`${BASE}/sitemap.xml`);
  if (sm.status !== 200) fail(`sitemap.xml: HTTP ${sm.status}`);
  else {
    if (!/^<\?xml[^>]*\?>\s*<urlset/.test(sm.text.trim())) fail('sitemap.xml is not a urlset');
    const locs = parseSitemapLocs(sm.text);
    const want = routes.map((r) => urlForRoute(r.route)).sort();
    const have = [...locs].sort();
    if (JSON.stringify(want) !== JSON.stringify(have))
      fail(
        `sitemap.xml names ${JSON.stringify(have)}; the prerender manifest says ${JSON.stringify(want)}`
      );
    for (const loc of locs) {
      const r = await get(loc);
      if (r.status !== 200) fail(`sitemap <loc> ${loc} answers ${r.status}`);
    }
    const stale = [...sm.text.matchAll(/<lastmod>([^<]+)<\/lastmod>/g)]
      .map((m) => m[1])
      .filter((d) => !/^\d{4}-\d{2}-\d{2}$/.test(d));
    if (stale.length) fail(`sitemap.xml has malformed lastmod values: ${stale.join(', ')}`);
    notes.push(`sitemap.xml: ${locs.length} URLs, all 200, matches the manifest`);
  }

  const deep = await get(`${BASE}/cashier`);
  if (deep.status !== 200)
    fail(`deep link /cashier: HTTP ${deep.status} (the shell must serve every route)`);
  else {
    const head = inspectHead(deep.text);
    if (!head.canonical)
      fail('deep link /cashier: shell has no canonical (the static head is missing)');
    if (!head.ld) fail('deep link /cashier: shell has no JSON-LD block');
    notes.push(
      'deep link /cashier: shell serves the static head (the app flips it to noindex at render time)'
    );
  }
}

const invokedDirectly =
  process.argv[1] &&
  new URL(`file://${process.argv[1]}`).pathname === new URL(import.meta.url).pathname;
if (invokedDirectly) {
  main()
    .catch((e) => fail(`checker crashed: ${e.stack || e.message}`))
    .finally(() => {
      for (const n of notes) console.log(`  ${n}`);
      if (problems.length) {
        console.error('\nLIVE SEO CONTRACT BROKEN');
        for (const p of problems) console.error(`  - ${p}`);
        process.exit(1);
      }
      console.log('\nlive SEO contract: OK');
    });
}
