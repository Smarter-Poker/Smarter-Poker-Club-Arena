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
    const pngs = readdirSync(dirPath).filter((f) => f.toLowerCase().endsWith('.png'));
    for (const file of pngs) {
      const src = path.join(dirPath, file);
      const dest = src.replace(/\.png$/i, '.webp');
      try {
        // Skip when an up-to-date WebP already exists
        if (existsSync(dest) && statSync(dest).mtimeMs >= statSync(src).mtimeMs) {
          skipped++;
          continue;
        }
        await sharp(src)
          .resize({ width: target.width, withoutEnlargement: true })
          .webp({ quality: target.quality })
          .toFile(dest);
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
