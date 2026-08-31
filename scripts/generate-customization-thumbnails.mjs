/** Generate compact Studio thumbnails while preserving full gameplay art. */
import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSharp } from './lib/sharp-loader.mjs';
import { shouldGenerateCustomizationThumbnail } from './lib/customization-thumbnail-policy.mjs';

const args = process.argv.slice(2);
const force = args.includes('--force');
const rootArg = args.find((arg) => !arg.startsWith('--'));
const ROOT = rootArg || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const targets = [
  {
    source: 'src/assets/backgrounds',
    output: 'src/assets/customization-thumbs/backgrounds',
    extensions: /\.(jpg|jpeg|png)$/i,
    width: 360,
    quality: 72,
  },
  {
    source: 'src/assets/tables',
    output: 'src/assets/customization-thumbs/tables',
    extensions: /\.png$/i,
    width: 320,
    quality: 76,
  },
];

const sharp = await loadSharp();
if (!sharp) {
  console.warn('[customization-thumbs] SKIPPED — sharp unavailable.');
  process.exit(0);
}

let generated = 0;
let skipped = 0;
let bytesIn = 0;
let bytesOut = 0;
for (const target of targets) {
  const sourceDir = path.join(ROOT, target.source);
  const outputDir = path.join(ROOT, target.output);
  if (!existsSync(sourceDir)) continue;
  mkdirSync(outputDir, { recursive: true });
  for (const file of readdirSync(sourceDir).filter((name) => target.extensions.test(name))) {
    const source = path.join(sourceDir, file);
    const output = path.join(outputDir, file.replace(/\.(jpg|jpeg|png)$/i, '.webp'));
    /*
     * Build-time generation is intentionally append-only. Git checkouts do
     * not preserve source mtimes, so comparing the source and committed WebP
     * timestamps made a clean CI checkout rewrite a non-deterministic subset
     * of tracked thumbnails. The bundle was then stamped `dirty: true` even
     * though it came from protected main.
     *
     * Missing derivatives are still generated automatically. Updating an
     * existing derivative is an explicit authoring action (`--force`) so the
     * reviewed bytes are committed before the production build starts.
     */
    if (!shouldGenerateCustomizationThumbnail({ outputExists: existsSync(output), force })) {
      skipped++;
      continue;
    }
    await sharp(source)
      .resize({ width: target.width, withoutEnlargement: true })
      .webp({ quality: target.quality, effort: 5 })
      .toFile(output);
    bytesIn += statSync(source).size;
    bytesOut += statSync(output).size;
    generated++;
  }
}

const mb = (value) => (value / 1024 / 1024).toFixed(2);
console.log(
  `[customization-thumbs] generated=${generated} skipped=${skipped}` +
    (generated ? ` | ${mb(bytesIn)}MB -> ${mb(bytesOut)}MB` : '')
);
