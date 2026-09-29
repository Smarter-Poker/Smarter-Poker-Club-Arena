/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  generate-webp-media.mjs — Build-Time WebP Generation (PERF PASS 2026-08-22)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Converts the card-face PNGs (750x1050, ~66KB each — a full deck is 3.4MB)
 * into resized WebP variants (~8KB each) that the table actually serves.
 * getCardImagePath() in src/components/table/CardImage.tsx now emits `.webp`
 * URLs, with a PNG onError fallback for any environment where this step was
 * skipped.
 *
 * WHY BUILD-TIME, NOT COMMITTED BINARIES: agents ship through the GitHub MCP,
 * which cannot push binary files. Generating at build keeps the repo text-only
 * for this feature and automatically covers future card art.
 *
 * SELF-INSTALLING: `sharp` is not in package.json (keeping package-lock
 * untouched — it exceeds the MCP push ceiling). If sharp is missing, this
 * script installs it with `npm install --no-save` (CI and dev machines both
 * have registry access). Any failure exits 0 with a warning: the build must
 * never break over an image optimization, because the PNG fallback path keeps
 * the app fully functional.
 *
 * Output cap: 360px wide (largest render is 80x120 CSS px @3x = 240x360).
 */

import { existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSharp } from './lib/sharp-loader.mjs';

const ROOT = process.argv[2] || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const TARGETS = [
  { dir: 'public/cards/2color', width: 360, quality: 82 },
  { dir: 'public/cards/4color', width: 360, quality: 82 },
  /**
   * Diamond Spins wheel art (2026-09-21, R20). These derivatives are COMMITTED,
   * not build-time: public/assets/** is an append-only origin pool whose URLs
   * are permanent, so the bytes must not depend on the encoder of whichever
   * runner built last. `sealed` therefore writes a derivative only when it is
   * missing; re-encoding an existing one is an explicit decision (delete it,
   * rerun, review the diff). Sources stay at their native size: the card
   * atlases are sampled at 2x into the sector meshes and the rim is drawn at
   * up to its native width on desktop.
   */
  {
    dir: 'public/assets/diamond-spins',
    quality: 88,
    sealed: true,
    files: [
      'wheel-main-cards-v1.png',
      'wheel-upgrade-cards-v1.png',
      'wheel-upgrade-titles-v1.png',
      'wheel-prize-atlas-v2.png',
      'wheel-matte-rim-v1.png',
      'wheel-selector-holder-v2.png',
      'wheel-selector-pointer-v2.png',
      'wheel-selector-pointer-glow-v2.png',
    ],
  },
  {
    // The combination throwables cutout, right-sized for the wheel's prize
    // art (reveal, prize card, gallery): about 430 CSS px at its largest.
    dir: 'public/images/marketplace/throwables',
    width: 640,
    quality: 88,
    sealed: true,
    files: [{ from: 'all-throwables-access-v1.png', to: 'wheel-prize-throwables-v1.webp' }],
    outDir: 'public/assets/diamond-spins',
  },
];

async function main() {
  const sharp = await loadSharp();
  if (!sharp) {
    console.warn('[webp-media] SKIPPED — WebP variants not generated. Cards fall back to PNG.');
    return;
  }

  let converted = 0;
  let skipped = 0;
  let failed = 0;
  let bytesIn = 0;
  let bytesOut = 0;

  for (const target of TARGETS) {
    const dirPath = path.join(ROOT, target.dir);
    if (!existsSync(dirPath)) {
      console.warn(`[webp-media] Missing dir (skipping): ${target.dir}`);
      continue;
    }
    const pngs = target.files
      ? target.files.map((entry) => (typeof entry === 'string' ? { from: entry } : entry))
      : readdirSync(dirPath)
          .filter((f) => f.toLowerCase().endsWith('.png'))
          .map((from) => ({ from }));
    for (const { from: file, to } of pngs) {
      const src = path.join(dirPath, file);
      const dest = path.join(
        target.outDir ? path.join(ROOT, target.outDir) : dirPath,
        to ?? file.replace(/\.png$/i, '.webp')
      );
      try {
        // A sealed derivative is generated once and committed; never re-encoded.
        if (target.sealed && existsSync(dest)) {
          skipped++;
          continue;
        }
        // Skip when an up-to-date WebP already exists
        if (existsSync(dest) && statSync(dest).mtimeMs >= statSync(src).mtimeMs) {
          skipped++;
          continue;
        }
        let pipeline = sharp(src);
        if (target.width)
          pipeline = pipeline.resize({ width: target.width, withoutEnlargement: true });
        await pipeline.webp({ quality: target.quality }).toFile(dest);
        bytesIn += statSync(src).size;
        bytesOut += statSync(dest).size;
        converted++;
      } catch (err) {
        failed++;
        console.warn(`[webp-media] Failed on ${file}:`, err?.message || err);
      }
    }
  }

  const mb = (n) => (n / 1024 / 1024).toFixed(2);
  console.log(
    `[webp-media] Done. converted=${converted} skipped=${skipped} failed=${failed}` +
      (converted ? ` | ${mb(bytesIn)}MB PNG -> ${mb(bytesOut)}MB WebP` : '')
  );
}

main().catch((err) => {
  console.warn('[webp-media] Unexpected error (non-fatal):', err?.message || err);
});
