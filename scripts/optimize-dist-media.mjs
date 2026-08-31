/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  optimize-dist-media.mjs — Post-Build Media Optimizer + SW Precache Injector
 *  (PERF PASS 2, 2026-08-22)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Runs AFTER `vite build`, operates on dist/ ONLY — the committed source
 * assets and the developer working tree are never touched.
 *
 * PART 1 — In-place media optimization (same URL, same format, fewer bytes).
 * The audit found ~20MB of media the app actually references at sizes far
 * beyond their render size: 51 lobby game-card emblems at ~150KB each
 * (7.9MB), 25 club-logo presets at 100-260KB, card-back art up to 1.2MB
 * used as a 3D texture, 300-900KB page backgrounds and modal frames. Every
 * oversized raster in dist/ is re-encoded at a sane maximum dimension in
 * its ORIGINAL format and replaced only when that makes it ≥10% smaller.
 * Because the URL and format never change, no code reference, fallback, or
 * cache rule has to know this happened — a failure here simply ships the
 * original bytes.
 *
 * PART 2 — Service-worker deploy stamp + shell precache list.
 * dist/sw-bus.js carries a DEPLOY_TS constant and an (empty) PRECACHE_URLS
 * list. This script stamps DEPLOY_TS with the build time (the committed
 * placeholder was previously updated by hand and had been stale since
 * April) and injects the entry chunk, modulepreloaded vendors, and entry
 * CSS from dist/index.html so the SW warms the app shell at install time.
 *
 * Both parts are best-effort: any failure logs and exits 0, because a
 * missed optimization must never block the deploy pipeline.
 */

import {
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
  existsSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSharp } from './lib/sharp-loader.mjs';

const ROOT = process.argv[2] || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');

// Directory → max dimension (px) for the longest edge. Render-size informed:
// game-card emblems and club logos never render above ~256 CSS px, card backs
// top out at 80x120 CSS (240x360 @3x), page backgrounds at viewport width.
const DIR_RULES = [
  // Approved Club Arena footer is a pixel-locked visual source. Re-encoding
  // the lossless WebP changed 465,144 of 490,496 pixels in the production
  // artifact, so it must pass through byte-for-byte.
  { prefix: 'images/club-footer/', maxDim: 0 },
  // User-approved production artwork. It was converted to lossless WebP after
  // exterior-only transparency extraction; resizing or lossy re-encoding here
  // would no longer be the exact supplied action pill.
  { prefix: 'images/club-arena/approved-club-entry-action-pill-v1.webp', maxDim: 0 },
  { prefix: 'game-card-icons/', maxDim: 512 },
  { prefix: 'club-logos/', maxDim: 512 },
  // The approved global-header artwork is a locked, lossless release asset.
  // Resizing it changes both its definition and its byte identity, so it must
  // bypass the generic images/ optimizer and ship exactly as committed.
  { prefix: 'images/global-header/', maxDim: 0 },
  { prefix: 'cards/backs/table/', maxDim: 0 }, // already hand-optimized — skip
  { prefix: 'cards/backs/', maxDim: 512 },
  { prefix: 'cards/', maxDim: 512 }, // full-size card faces (root + 2color/4color PNGs)
  { prefix: 'images/', maxDim: 1280 },
  { prefix: 'assets/', maxDim: 1280 }, // public/assets media (metal-ui frames etc.)
  // The PWA/apple-touch icon. manifest.json declares it "sizes": "512x512"
  // and the file was 1024x1024, so this makes the asset match its own
  // declaration as well as shrinking it. It is fetched on every iOS
  // add-to-home-screen and by the SW precache list in public/sw-bus.js.
  { prefix: 'poker-chip-logo.png', maxDim: 512 },
  // CATCH-ALL, and it must stay last. Before 2026-08-23 ruleFor() returned
  // null for anything outside the prefixes above, so every image sitting at
  // the ROOT of public/ was shipped at full size — which is how a
  // 180x180 apple-touch-icon (poker-chip-logo.png) went out as 637KB. An
  // opt-in list silently misses whatever nobody remembered to add; a
  // catch-all only ever misses on the safe side. Earlier rules still win,
  // including cards/backs/table's explicit skip, and RASTER_RE keeps this
  // away from video, fonts and svg.
  { prefix: '', maxDim: 1280 },
];

const MIN_BYTES = 40 * 1024; // leave already-small files alone
const RASTER_RE = /\.(png|jpe?g|webp)$/i;

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) yield* walk(p);
    else yield { path: p, size: st.size };
  }
}

function ruleFor(relPath) {
  for (const rule of DIR_RULES) {
    if (relPath.startsWith(rule.prefix)) return rule;
  }
  return null;
}

async function optimizeMedia(sharp) {
  let optimized = 0;
  let skipped = 0;
  let failed = 0;
  let bytesIn = 0;
  let bytesOut = 0;

  for (const file of walk(DIST)) {
    const rel = path.relative(DIST, file.path).split(path.sep).join('/');
    if (!RASTER_RE.test(rel)) continue;
    if (file.size < MIN_BYTES) continue;
    const rule = ruleFor(rel);
    if (!rule || rule.maxDim === 0) {
      skipped++;
      continue;
    }

    try {
      const ext = rel.toLowerCase().split('.').pop();
      let pipeline = sharp(file.path).rotate().resize({
        width: rule.maxDim,
        height: rule.maxDim,
        fit: 'inside',
        withoutEnlargement: true,
      });
      if (ext === 'png') {
        pipeline = pipeline.png({ compressionLevel: 9, palette: true, quality: 90 });
      } else if (ext === 'webp') {
        pipeline = pipeline.webp({ quality: 80 });
      } else {
        pipeline = pipeline.jpeg({ quality: 78, mozjpeg: true });
      }
      const tmpOut = file.path + '.opt';
      await pipeline.toFile(tmpOut);
      const outSize = statSync(tmpOut).size;
      if (outSize < file.size * 0.9) {
        renameSync(tmpOut, file.path);
        bytesIn += file.size;
        bytesOut += outSize;
        optimized++;
      } else {
        // Not meaningfully smaller — keep the original bytes.
        renameSync(tmpOut, tmpOut + '.discard');
        try {
          // best-effort cleanup; a stray .discard in dist is harmless but ugly
          const { unlinkSync } = await import('node:fs');
          unlinkSync(tmpOut + '.discard');
        } catch {
          /* ignore */
        }
        skipped++;
      }
    } catch (err) {
      failed++;
      console.warn(`[dist-media] Failed on ${rel}:`, err?.message || err);
    }
  }

  const mb = (n) => (n / 1024 / 1024).toFixed(2);
  console.log(
    `[dist-media] optimized=${optimized} skipped=${skipped} failed=${failed}` +
      (optimized ? ` | ${mb(bytesIn)}MB -> ${mb(bytesOut)}MB` : '')
  );
}

function injectServiceWorker() {
  const swPath = path.join(DIST, 'sw-bus.js');
  const htmlPath = path.join(DIST, 'index.html');
  if (!existsSync(swPath) || !existsSync(htmlPath)) {
    console.warn('[dist-media] sw-bus.js or index.html missing in dist — skipping SW injection');
    return;
  }

  const html = readFileSync(htmlPath, 'utf8');
  // Entry module, modulepreloaded vendors, and stylesheets emitted by Vite.
  const urls = new Set();
  for (const m of html.matchAll(
    /(?:src|href)="(\/hub\/club-arena\/(?:assets|fonts)\/[^"]+\.(?:js|css))"/g
  )) {
    urls.add(m[1]);
  }

  let sw = readFileSync(swPath, 'utf8');
  const ts = new Date()
    .toISOString()
    .replace(/[-:TZ.]/g, '')
    .slice(0, 14);

  const stamped = sw.replace(/const DEPLOY_TS = '[0-9]+';/, `const DEPLOY_TS = '${ts}';`);
  const withList = stamped.replace(
    /const PRECACHE_URLS = \[\];/,
    `const PRECACHE_URLS = ${JSON.stringify([...urls])};`
  );

  if (withList === sw) {
    console.warn('[dist-media] SW placeholders not found — sw-bus.js left unchanged');
    return;
  }
  writeFileSync(swPath, withList);
  console.log(`[dist-media] sw-bus.js stamped DEPLOY_TS=${ts}, precache=${urls.size} shell assets`);
}

async function main() {
  if (!existsSync(DIST)) {
    console.warn('[dist-media] no dist/ directory — nothing to do');
    return;
  }
  // Shell rewriting needs no external dependencies and must happen even if
  // sharp is unavailable. HomePage remains a route-level dynamic import: a
  // manual modulepreload made every deep link pay for the lobby and pushed the
  // Linux initial-load artifact over its hard budget.
  try {
    injectServiceWorker();
  } catch (err) {
    console.warn('[dist-media] SW injection failed (non-fatal):', err?.message || err);
  }

  const sharp = await loadSharp();
  if (!sharp) {
    console.warn('[dist-media] SKIPPED media optimization — sharp unavailable.');
    return;
  }
  await optimizeMedia(sharp);
}

main().catch((err) => {
  console.warn('[dist-media] Unexpected error (non-fatal):', err?.message || err);
});
