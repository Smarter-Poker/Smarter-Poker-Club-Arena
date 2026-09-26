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
 * THIS STEP IS NOT BEST EFFORT, AND SAYING IT WAS COST TWO PUBLISHES
 * (2026-09-22). Until today any failure here warned and exited 0, on the
 * reasoning that index.html would simply keep its Google Fonts links. That
 * reasoning stopped being true when the origin moved to an append-only
 * runtime pool: `publish-club-arena.yml` requires `<dist>/fonts/fonts.css`
 * in every release, because the pool's fonts.css is a symlink into
 * `current/fonts/fonts.css` and a release without fonts/ would dangle it
 * for every shell already cached on a player's device. So a build that
 * skipped this step could never be published at all - it could only be
 * refused on the host, four minutes later, by a bare `test -d` that printed
 * nothing. That is exactly what happened to 91bd8161 in runs 35763554815
 * and 35764705782, whose only clue was one line in the build job:
 *
 *   [self-host-fonts] Failed (non-fatal, Google Fonts links remain): fetch failed
 *
 * A step whose output the publisher requires does not get to report success
 * when it produced nothing (CLAUDE.md 10.86 rule 1). Every outcome below
 * that does not write <dist>/fonts/fonts.css now names itself and exits
 * non-zero, in the build job, where the cause is on screen.
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fontFileName } from './lib/font-file-name.mjs';

const ROOT = process.argv[2] || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// CA_DIST: the native build (npm run build:native) writes dist-native/ so the
// two bundles can never be confused. Unset means 'dist', exactly as before.
const DIST = path.join(ROOT, process.env.CA_DIST || 'dist');
// CA_PUBLIC_BASE: the bundle's public base. Web '/hub/club-arena/', native '/'.
const PUBLIC_BASE = (process.env.CA_PUBLIC_BASE || '/hub/club-arena/').replace(/\/?$/, '/');
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

async function main() {
  const htmlPath = path.join(DIST, 'index.html');
  if (!existsSync(htmlPath)) {
    throw new Error(
      `${htmlPath} does not exist, so there is no shell to read the font stylesheet out of; ` +
        'the bundle did not build'
    );
  }
  const html = readFileSync(htmlPath, 'utf8');

  const cssUrlMatch = html.match(/https:\/\/fonts\.googleapis\.com\/css2\?[^"']+/);
  if (!cssUrlMatch) {
    throw new Error(
      `${htmlPath} names no fonts.googleapis.com/css2 stylesheet, so no woff2 files can be ` +
        `self-hosted and ${path.join(DIST, 'fonts', 'fonts.css')} would never be written. ` +
        'The origin requires that file in every release. If the Google Fonts link was ' +
        'removed on purpose, remove this build step and the publisher guard together.'
    );
  }
  const cssUrl = cssUrlMatch[0].replace(/&amp;/g, '&');

  const cssRes = await fetch(cssUrl, { headers: { 'User-Agent': UA } });
  if (!cssRes.ok) throw new Error(`css2 fetch failed: ${cssRes.status}`);
  let css = await cssRes.text();

  const fontUrls = [
    ...new Set(
      [...css.matchAll(/url\((https:\/\/fonts\.gstatic\.com\/[^)]+)\)/g)].map((m) => m[1])
    ),
  ];
  if (fontUrls.length === 0) throw new Error('no woff2 URLs found in css');

  const fontsDir = path.join(DIST, 'fonts');
  mkdirSync(fontsDir, { recursive: true });

  let bytes = 0;
  for (const url of fontUrls) {
    // e.g. https://fonts.gstatic.com/s/inter/v19/xyz.woff2 -> inter-v19-xyz.woff2;
    // a kit URL (/l/font?kit=...) is named by its hash (lib/font-file-name.mjs).
    const name = fontFileName(url);
    const res = await fetch(url, { headers: { 'User-Agent': UA } });
    if (!res.ok) throw new Error(`font fetch failed: ${res.status} ${url}`);
    const buf = Buffer.from(await res.arrayBuffer());
    writeFileSync(path.join(fontsDir, name), buf);
    bytes += buf.length;
    css = css.split(url).join(`${PUBLIC_BASE}fonts/${name}`);
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
    .replace(/https:\/\/fonts\.googleapis\.com\/css2\?[^"']+/g, `${PUBLIC_BASE}fonts/${cssName}`)
    .replace(/\s*<link rel="preconnect" href="https:\/\/fonts\.googleapis\.com"[^>]*>/, '')
    .replace(/\s*<link rel="preconnect" href="https:\/\/fonts\.gstatic\.com"[^>]*>/, '');
  writeFileSync(htmlPath, newHtml);

  console.log(
    `[self-host-fonts] self-hosted ${fontUrls.length} woff2 files (${(bytes / 1024).toFixed(0)}KB) + ${cssName} (+legacy fonts.css); index.html rewritten`
  );
}

main()
  .then(() => {
    // The publisher will refuse a release without this file. Prove it exists
    // here, where the failure is one line under the command that caused it,
    // rather than on the origin four minutes later.
    const stylesheet = path.join(DIST, 'fonts', 'fonts.css');
    if (!existsSync(stylesheet)) {
      throw new Error(`${stylesheet} was not written`);
    }
  })
  .catch((err) => {
    console.error(
      `[self-host-fonts] FAILED: ${err?.message || err}\n` +
        `[self-host-fonts] ${path.join(DIST, 'fonts', 'fonts.css')} is required in every ` +
        'release: the origin serves /fonts/* from an append-only pool whose fonts.css is a ' +
        'symlink into the live release, so a bundle without it cannot be published. This ' +
        'build produced no publishable bundle.'
    );
    process.exitCode = 1;
  });
