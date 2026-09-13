/** Generate compact Studio thumbnails while preserving full gameplay art. */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSharp } from './lib/sharp-loader.mjs';
import {
  shouldGenerateCustomizationThumbnail,
  THUMBNAIL_SOURCE_MANIFEST,
} from './lib/customization-thumbnail-policy.mjs';

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

/**
 * Every derivative records the sha256 of the art it was made from, so a repair
 * to a skin that forgets this authoring run is caught at review time instead of
 * shipping a thumbnail of the old picture. Measured on 2026-09-09: no threshold
 * on a rendered comparison can tell a stale thumbnail from one encoded by a
 * different libvips - the bands overlap the wrong way round. The input hash is
 * exact and is not an opinion. See ./lib/customization-thumbnail-policy.mjs.
 */
const MANIFEST_PATH = path.join(ROOT, THUMBNAIL_SOURCE_MANIFEST);
const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');

let manifest = {};
if (existsSync(MANIFEST_PATH)) {
  try {
    manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
  } catch {
    // A manifest we cannot read is rebuilt from what we generate, never
    // half-trusted: a partially-parsed one would bless the wrong entries.
    manifest = {};
  }
}
let manifestChanged = false;

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
    const key = path.relative(ROOT, output).split(path.sep).join('/');
    const sourceHash = sha256(source);

    if (!shouldGenerateCustomizationThumbnail({ outputExists: existsSync(output), force })) {
      skipped++;
      // Record what an already-correct derivative was made from WITHOUT
      // rewriting it. This is what seeds the manifest for art that predates it;
      // it never touches a pixel, so the build stays hermetic.
      if (!manifest[key]) {
        manifest[key] = { source: path.relative(ROOT, source).split(path.sep).join('/'), sha256: sourceHash };
        manifestChanged = true;
      }
      continue;
    }
    await sharp(source)
      .resize({ width: target.width, withoutEnlargement: true })
      .webp({ quality: target.quality, effort: 5 })
      .toFile(output);
    bytesIn += statSync(source).size;
    bytesOut += statSync(output).size;
    generated++;
    if (manifest[key]?.sha256 !== sourceHash) {
      manifest[key] = { source: path.relative(ROOT, source).split(path.sep).join('/'), sha256: sourceHash };
      manifestChanged = true;
    }
  }
}

if (manifestChanged) {
  const ordered = Object.fromEntries(Object.keys(manifest).sort().map((k) => [k, manifest[k]]));
  writeFileSync(MANIFEST_PATH, `${JSON.stringify(ordered, null, 2)}\n`);
}

const mb = (value) => (value / 1024 / 1024).toFixed(2);
console.log(
  `[customization-thumbs] generated=${generated} skipped=${skipped}` +
    (generated ? ` | ${mb(bytesIn)}MB -> ${mb(bytesOut)}MB` : '') +
    (manifestChanged ? ' | source manifest updated' : '')
);
