/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  self-host-fonts.mjs — Move Google Fonts Onto Our Origin (PERF PASS 3)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Runs after `vite build`, before optimize-dist-media.mjs. Operates on dist/
 * only. WHY: the Google Fonts chain costs a cold visitor two extra origins
 * (fonts.googleapis.com for CSS, then fonts.gstatic.com for woff2), and since
 * browsers partition cross-origin caches per-site, those bytes are re-paid
 * per site regardless of how popular the fonts are. Self-hosted, the woff2
 * files are same-origin: covered by the immutable woff2 Cache-Control rule,
 * cacheable by sw-bus.js, and free of both extra TLS handshakes.
 *
 * Mechanism:
 *   1. Find the fonts.googleapis.com/css2 URL in dist/index.html.
 *   2. Fetch it with a modern-Chrome UA (so Google serves woff2 + unicode-range
 *      subsets — browsers then download only the subsets they need).
 *   3. Download every referenced woff2 into dist/fonts/.
 *   4. Write dist/fonts/fonts.css with rewritten same-origin URLs.
 *   5. Rewrite dist/index.html: the async-loading stylesheet links (and the
 *      noscript fallback) point at /hub/club-arena/fonts/fonts.css, and the
 *      now-useless Google preconnect hints are dropped.
 *
 * Best-effort: ANY failure leaves dist/index.html untouched, so the page
 * falls back to loading from Google exactly as before. Exit code is always 0.
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = process.argv[2] || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

async function main() {
  const htmlPath = path.join(DIST, 'index.html');
  if (!existsSync(htmlPath)) {
    console.warn('[self-host-fonts] dist/index.html missing — skipping');
    return;
  }
  const html = readFileSync(htmlPath, 'utf8');

  const cssUrlMatch = html.match(/https:\/\/fonts\.googleapis\.com\/css2\?[^"']+/);
  if (!cssUrlMatch) {
    console.warn('[self-host-fonts] no Google Fonts URL found — skipping');
    return;
  }
  const cssUrl = cssUrlMatch[0].replace(/&amp;/g, '&');

  const cssRes = await fetch(cssUrl, { headers: { 'User-Agent': UA } });
  if (!cssRes.ok) throw new Error(`css2 fetch failed: ${cssRes.status}`);
  let css = await cssRes.text();

  const fontUrls = [...new Set([...css.matchAll(/url\((https:\/\/fonts\.gstatic\.com\/[^)]+)\)/g)].map((m) => m[1]))];
  if (fontUrls.length === 0) throw new Error('no woff2 URLs found in css');

  const fontsDir = path.join(DIST, 'fonts');
  mkdirSync(fontsDir, { recursive: true });

  let bytes = 0;
  for (const url of fontUrls) {
    // e.g. https://fonts.gstatic.com/s/inter/v19/xyz.woff2 -> inter-v19-xyz.woff2
    const name = url
      .replace('https://fonts.gstatic.com/s/', '')
      .split('/')
      .join('-');
    const res = await fetch(url, { headers: { 'User-Agent': UA } });
    if (!res.ok) throw new Error(`font fetch failed: ${res.status} ${url}`);
    const buf = Buffer.from(await res.arrayBuffer());
    writeFileSync(path.join(fontsDir, name), buf);
    bytes += buf.length;
    css = css.split(url).join(`/hub/club-arena/fonts/${name}`);
  }
  // PERF PASS 2026-08-22 (handoff item 5): the stylesheet is content-hashed
  // (fonts-<hash>.css) so World Hub can serve it immutable like every other
  // hashed asset — the un-hashed fonts.css revalidated on every cold nav.
  // The legacy fonts.css is STILL written: shells cached by the service
  // worker before this change reference it by that name, and an rsync
  // --delete deploy would otherwise 404 their fonts until the shell
  // refreshes. Drop the legacy copy only after a few deploy cycles.
  const cssHash = createHash('sha256').update(css).digest('hex').slice(0, 10);
  const cssName = `fonts-${cssHash}.css`;
  writeFileSync(path.join(fontsDir, cssName), css);
  writeFileSync(path.join(fontsDir, 'fonts.css'), css);

  // Rewrite index.html: swap both stylesheet links (async + noscript) to the
  // local file and drop the Google preconnects.
  let newHtml = html
    .replace(/https:\/\/fonts\.googleapis\.com\/css2\?[^"']+/g, `/hub/club-arena/fonts/${cssName}`)
    .replace(/\s*<link rel="preconnect" href="https:\/\/fonts\.googleapis\.com"[^>]*>/, '')
    .replace(/\s*<link rel="preconnect" href="https:\/\/fonts\.gstatic\.com"[^>]*>/, '');
  writeFileSync(htmlPath, newHtml);

  console.log(
    `[self-host-fonts] self-hosted ${fontUrls.length} woff2 files (${(bytes / 1024).toFixed(0)}KB) + ${cssName} (+legacy fonts.css); index.html rewritten`
  );
}

main().catch((err) => {
  console.warn('[self-host-fonts] Failed (non-fatal, Google Fonts links remain):', err?.message || err);
});
