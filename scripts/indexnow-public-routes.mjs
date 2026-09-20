/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  indexnow-public-routes - tell Bing the arena's public pages changed
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * AEO PHASE 1 (2026-09-17). World Hub pings IndexNow when one of ITS pages
 * merges, but the arena's public pages (/hub/club-arena, /help, the legal
 * documents) live on the same host and change on every Club Arena publish,
 * which World Hub never sees. This runs after a successful Publish Club
 * Arena run (workflow_run, event-driven, not a schedule): it reads the
 * prerender manifest the publish just put on the public address, builds the
 * public URLs, and submits them with the host's IndexNow key. The key is
 * public by protocol (it is served at keyLocation), so nothing here is a
 * secret. Best effort: any failure is a notice, never a red run, because
 * a missed ping costs a day of freshness and nothing else.
 *
 *   node scripts/indexnow-public-routes.mjs             (CI)
 *   node scripts/indexnow-public-routes.mjs --dry-run
 */
const HOST = 'smarter.poker';
const PUBLIC_BASE = `https://${HOST}/hub/club-arena`;
const KEY_FILE = 'ebee30927d6f8e9d19a8deb450a4359e.txt';
const ENDPOINT = 'https://api.indexnow.org/indexnow';

/** The public URLs a prerender manifest describes. */
export function publicUrlsFromManifest(manifest) {
  const routes = Array.isArray(manifest?.routes) ? manifest.routes : [];
  return routes
    .map((r) => (typeof r === 'string' ? r : r?.route))
    .filter((route) => typeof route === 'string' && route.startsWith('/'))
    .map((route) => (route === '/' ? PUBLIC_BASE : `${PUBLIC_BASE}${route}`));
}

export function indexNowBody(urls, key) {
  return { host: HOST, key, keyLocation: `https://${HOST}/${KEY_FILE}`, urlList: urls };
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const manifestRes = await fetch(`${PUBLIC_BASE}/prerender-manifest.json`, { headers: { 'Cache-Control': 'no-cache' } });
  if (!manifestRes.ok) {
    console.log(`::notice::indexnow: prerender-manifest.json answered ${manifestRes.status}; nothing submitted`);
    return;
  }
  const urls = publicUrlsFromManifest(await manifestRes.json());
  if (urls.length === 0) {
    console.log('::notice::indexnow: the manifest lists no routes; nothing submitted');
    return;
  }
  const keyRes = await fetch(`https://${HOST}/${KEY_FILE}`);
  const key = keyRes.ok ? (await keyRes.text()).trim() : '';
  if (!/^[a-f0-9]{32}$/.test(key)) {
    console.log(`::notice::indexnow: key file answered ${keyRes.status}; nothing submitted`);
    return;
  }
  const body = indexNowBody(urls, key);
  console.log(`indexnow: ${dryRun ? 'would submit' : 'submitting'} ${urls.length} url(s):\n  ${urls.join('\n  ')}`);
  if (dryRun) return;
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify(body),
  });
  console.log(`indexnow: HTTP ${res.status} ${res.statusText}`);
  if (res.status !== 200 && res.status !== 202) {
    console.log(`::notice::indexnow: endpoint answered ${res.status}; Bing will still find the pages through the sitemap`);
  }
}

const invokedDirectly = process.argv[1] && new URL(`file://${process.argv[1]}`).pathname === new URL(import.meta.url).pathname;
if (invokedDirectly) {
  main().catch((err) => {
    console.log(`::notice::indexnow: ${err?.message || err}`);
  });
}
