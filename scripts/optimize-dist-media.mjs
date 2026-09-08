/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  optimize-dist-media.mjs - Post-Build Media Optimizer + SW Precache Injector
 *  (PERF PASS 2, 2026-08-22; parallel + content-addressed cache, 2026-09-04)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Runs AFTER `vite build`, operates on dist/ ONLY - the committed source
 * assets and the developer working tree are never touched.
 *
 * PART 1 - In-place media optimization (same URL, same format, fewer bytes).
 * The audit found ~20MB of media the app actually references at sizes far
 * beyond their render size: 51 lobby game-card emblems at ~150KB each
 * (7.9MB), 25 club-logo presets at 100-260KB, card-back art up to 1.2MB
 * used as a 3D texture, 300-900KB page backgrounds and modal frames. Every
 * oversized raster in dist/ is re-encoded at a sane maximum dimension in
 * its ORIGINAL format and replaced only when that makes it >=10% smaller.
 * Because the URL and format never change, no code reference, fallback, or
 * cache rule has to know this happened - a failure here simply ships the
 * original bytes.
 *
 * PART 2 - Service-worker deploy stamp + shell precache list.
 * dist/sw-bus.js carries a DEPLOY_TS constant and an (empty) PRECACHE_URLS
 * list. This script stamps DEPLOY_TS with the build time (the committed
 * placeholder was previously updated by hand and had been stale since
 * April) and injects the entry chunk, modulepreloaded vendors, and entry
 * CSS from dist/index.html so the SW warms the app shell at install time.
 *
 * Both parts are best-effort: any failure logs and exits 0, because a
 * missed optimization must never block the deploy pipeline.
 *
 * ── 2026-09-04: why this file got a cache and a worker pool ──────────────────
 *
 * Measured on the estate's CI logs, this step was 88.0s of a 266s CI build,
 * 85.7s of a 120s publisher build, and it runs THREE TIMES per merge. It was
 * the second largest item on the push-to-live critical path after the network
 * install of sharp. Two things were wrong with it and both are fixed here:
 *
 *  1. IT WAS SERIAL. `await pipeline.toFile()` one file at a time, 496
 *     candidates, on a 16-core box. Every raster is independent, so the whole
 *     pass is embarrassingly parallel. It now runs a fixed-width worker pool
 *     with sharp's own internal concurrency pinned to 1, which is the
 *     combination that actually uses the cores instead of oversubscribing
 *     them.
 *
 *  2. IT HAD NO MEMORY AND WAS NOT IDEMPOTENT. Every raster in dist/ is a
 *     byte-for-byte copy of a committed source asset, so the same input was
 *     decoded and re-encoded on every build of every branch forever, and a
 *     second pass over an already-optimized dist re-encoded 90 more files -
 *     generational quality loss, silently, for anyone who restored a warm
 *     dist. Results are now content-addressed: the cache is keyed by the
 *     sha256 of the INPUT bytes plus everything that can change the output
 *     (the rule's max dimension, the extension, the encoder settings version
 *     and sharp's own version). A hit copies bytes; it never decodes.
 *
 *     Idempotency falls out of the same index. When a file IS optimized, the
 *     sha256 of the OUTPUT is recorded as a no-win entry too, so re-running
 *     over the produced bytes recognises them and leaves them alone.
 *
 * The cache directory is disposable by construction. Delete it and the only
 * consequence is one slow build. It is never consulted for correctness - a
 * cached entry is used only when its key matches every input to the encode.
 */

import {
  copyFileSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  unlinkSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSharp } from './lib/sharp-loader.mjs';

const ROOT = process.argv[2] || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// CA_DIST: the native build (npm run build:native) writes dist-native/ so the
// two bundles can never be confused. Unset means 'dist', exactly as before.
const DIST = path.join(ROOT, process.env.CA_DIST || 'dist');

/**
 * Bump this whenever the encoder settings below change. It is part of every
 * cache key, so a settings change invalidates exactly the entries it should
 * and nothing else. Forgetting to bump it is the one way to serve stale bytes
 * from this cache, which is why it sits directly above the settings it covers.
 */
const ENCODER_SETTINGS_VERSION = 1;

const CACHE_DIR =
  process.env.CA_DIST_MEDIA_CACHE || path.join(ROOT, 'node_modules', '.cache', 'dist-media');

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
  // The three approved hamburger rasters are also byte-locked. The generic
  // images rule used to palette-reencode the PNG during every production build,
  // which made the deployed file differ from the approved source even though
  // no component changed. These specific paths must pass through untouched.
  { prefix: 'images/btn-hamburger-v4.png', maxDim: 0 },
  { prefix: 'images/btn-hamburger.png', maxDim: 0 },
  { prefix: 'images/btn-hamburger.webp', maxDim: 0 },
  { prefix: 'cards/backs/table/', maxDim: 0 }, // already hand-optimized - skip
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
  // the ROOT of public/ was shipped at full size - which is how a
  // 180x180 apple-touch-icon (poker-chip-logo.png) went out as 637KB. An
  // opt-in list silently misses whatever nobody remembered to add; a
  // catch-all only ever misses on the safe side. Earlier rules still win,
  // including cards/backs/table's explicit skip, and RASTER_RE keeps this
  // away from video, fonts and svg.
  { prefix: '', maxDim: 1280 },
];

const MIN_BYTES = 40 * 1024; // leave already-small files alone
const RASTER_RE = /\.(png|jpe?g|webp)$/i;

/**
 * How many rasters to encode at once. sharp's own libvips concurrency is
 * pinned to 1 below, so this number IS the parallelism: N images, one thread
 * each. Oversubscribing (N images x cores threads) was measurably slower than
 * either extreme. Capped because each in-flight encode holds a decoded bitmap
 * in memory and the largest source here is a 1024x1024 32-bit PNG.
 */
const POOL_WIDTH = Math.max(1, Math.min(os.cpus()?.length || 4, 12));

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

function sha256File(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

/**
 * The cache key covers every input to the encode. Two files with the same
 * bytes, the same rule and the same encoder produce the same output, so they
 * share one entry no matter what they are called or which branch built them.
 */
function cacheKey(inputSha, rule, ext, sharpVersion) {
  return createHash('sha256')
    .update(`${inputSha}|${rule.maxDim}|${ext}|v${ENCODER_SETTINGS_VERSION}|sharp${sharpVersion}`)
    .digest('hex');
}

function encodeFor(sharp, file, rule, ext) {
  let pipeline = sharp(file).rotate().resize({
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
  return pipeline;
}

async function optimizeMedia(sharp, sharpVersion) {
  // One libvips thread per image; the pool below provides the parallelism.
  try {
    sharp.concurrency(1);
    sharp.cache(false);
  } catch {
    /* older sharp, or a stub - the pool still works */
  }

  let cacheReady = true;
  try {
    mkdirSync(CACHE_DIR, { recursive: true });
  } catch (err) {
    cacheReady = false;
    console.warn('[dist-media] cache unavailable (continuing without it):', err?.message || err);
  }

  const candidates = [];
  let skipped = 0;
  for (const file of walk(DIST)) {
    const rel = path.relative(DIST, file.path).split(path.sep).join('/');
    if (!RASTER_RE.test(rel)) continue;
    if (file.size < MIN_BYTES) continue;
    const rule = ruleFor(rel);
    if (!rule || rule.maxDim === 0) {
      skipped++;
      continue;
    }
    candidates.push({ ...file, rel, rule });
  }

  const stats = { optimized: 0, hits: 0, misses: 0, failed: 0, bytesIn: 0, bytesOut: 0 };

  // Cache entries are published by rename, never written in place. Two pool
  // workers can hold the same key at once (two paths with identical bytes),
  // and a reader that saw a half-copied `.bin` would put a truncated image
  // into dist/. rename(2) on one filesystem is atomic, so a reader sees
  // either no entry or a complete one.
  let tmpSeq = 0;
  const publish = (name, write) => {
    if (!cacheReady) return;
    const finalPath = path.join(CACHE_DIR, name);
    const tmpPath = path.join(CACHE_DIR, `.tmp-${process.pid}-${tmpSeq++}`);
    try {
      write(tmpPath);
      renameSync(tmpPath, finalPath);
    } catch {
      /* a cache write failure must never fail a build */
      try {
        unlinkSync(tmpPath);
      } catch {
        /* ignore */
      }
    }
  };

  const markNoWin = (key) => publish(`${key}.skip`, (tmp) => writeFileSync(tmp, ''));

  async function processOne(item) {
    const ext = item.rel.toLowerCase().split('.').pop();
    let key = null;
    try {
      if (cacheReady) {
        const inputSha = sha256File(item.path);
        key = cacheKey(inputSha, item.rule, ext, sharpVersion);
        const skipPath = path.join(CACHE_DIR, `${key}.skip`);
        const binPath = path.join(CACHE_DIR, `${key}.bin`);
        if (existsSync(skipPath)) {
          // Either a previous run proved this input does not shrink by 10%,
          // or these bytes ARE a previous run's output. Both mean: leave it.
          stats.hits++;
          skipped++;
          return;
        }
        if (existsSync(binPath)) {
          const outSize = statSync(binPath).size;
          copyFileSync(binPath, item.path);
          stats.hits++;
          stats.optimized++;
          stats.bytesIn += item.size;
          stats.bytesOut += outSize;
          return;
        }
      }

      stats.misses++;
      const tmpOut = `${item.path}.opt`;
      await encodeFor(sharp, item.path, item.rule, ext).toFile(tmpOut);
      const outSize = statSync(tmpOut).size;

      if (outSize < item.size * 0.9) {
        if (cacheReady && key) {
          publish(`${key}.bin`, (tmp) => copyFileSync(tmpOut, tmp));
          // Idempotency: recognise our own output as "already optimized".
          markNoWin(cacheKey(sha256File(tmpOut), item.rule, ext, sharpVersion));
        }
        renameSync(tmpOut, item.path);
        stats.bytesIn += item.size;
        stats.bytesOut += outSize;
        stats.optimized++;
      } else {
        // Not meaningfully smaller - keep the original bytes, and remember
        // that so no future build pays to learn it again.
        if (key) markNoWin(key);
        try {
          unlinkSync(tmpOut);
        } catch {
          /* a stray .opt in dist is harmless but ugly */
        }
        skipped++;
      }
    } catch (err) {
      stats.failed++;
      console.warn(`[dist-media] Failed on ${item.rel}:`, err?.message || err);
    }
  }

  // Fixed-width pool: every worker pulls the next index until the list runs
  // out. No batching, so one slow 4MB PNG cannot idle eleven cores behind it.
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= candidates.length) return;
      await processOne(candidates[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(POOL_WIDTH, candidates.length) }, worker));

  const mb = (n) => (n / 1024 / 1024).toFixed(2);
  console.log(
    `[dist-media] optimized=${stats.optimized} skipped=${skipped} failed=${stats.failed} ` +
      `cache=${stats.hits}hit/${stats.misses}miss pool=${POOL_WIDTH}` +
      (stats.optimized ? ` | ${mb(stats.bytesIn)}MB -> ${mb(stats.bytesOut)}MB` : '')
  );
}

function injectServiceWorker() {
  const swPath = path.join(DIST, 'sw-bus.js');
  const htmlPath = path.join(DIST, 'index.html');
  if (!existsSync(swPath) || !existsSync(htmlPath)) {
    console.warn('[dist-media] sw-bus.js or index.html missing in dist - skipping SW injection');
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
    console.warn('[dist-media] SW placeholders not found - sw-bus.js left unchanged');
    return;
  }
  writeFileSync(swPath, withList);
  console.log(`[dist-media] sw-bus.js stamped DEPLOY_TS=${ts}, precache=${urls.size} shell assets`);
}

async function main() {
  if (!existsSync(DIST)) {
    console.warn('[dist-media] no dist/ directory - nothing to do');
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
    console.warn('[dist-media] SKIPPED media optimization - sharp unavailable.');
    return;
  }
  // The sharp VERSION is part of every cache key: a new encoder can produce
  // different bytes from the same input, and a cache that ignored that would
  // ship last version's output forever.
  const sharpVersion = (typeof sharp.versions === 'object' && sharp.versions?.sharp) || 'unknown';
  await optimizeMedia(sharp, sharpVersion);
}

main().catch((err) => {
  console.warn('[dist-media] Unexpected error (non-fatal):', err?.message || err);
});
