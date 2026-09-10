/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  A THUMBNAIL IS NOT ALLOWED TO OUTLIVE THE ART IT WAS MADE FROM
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * The Studio picker does not show the table skin. It shows a 320px WebP
 * derivative of it, and `scripts/generate-customization-thumbnails.mjs` is
 * append-only on purpose: an existing derivative is rewritten only by an
 * explicit `--force` authoring run, so the bytes that ship are bytes a human
 * looked at. That decision is right and this test does not change it.
 *
 * Its cost is that repairing a skin and forgetting the authoring run leaves the
 * picker showing the OLD picture, and nothing could tell. Which is the exact
 * shape of the fault this whole strand of work is made of: `skin_classic_green`
 * had a hole in its gold line, `arctic_white` painted its table 19px off
 * centre, both were repaired at the source, and the copy the player actually
 * looks at is a separate file that no test compared to anything.
 *
 * ── WHY THIS IS NOT A PIXEL COMPARISON, MEASURED NOT ASSUMED ─────────────────
 * Every committed thumbnail was compared against a fresh regeneration on
 * 2026-09-09, and against a regeneration of the PRE-repair art:
 *
 *   worst 16x16 block, same art, different libvips : up to 37.7  (golden_sand)
 *   worst 16x16 block, genuinely stale art         : as low as 17.7 (classic_green)
 *
 * The bands overlap, and they overlap the wrong way round. A repaired gold line
 * is a small local change; an encoder version bump is a broad faint one. On the
 * mean it is worse still - stale `classic_green` scored 0.54 mean absolute
 * difference while a perfectly correct `golden_sand` scored 1.82. Four
 * comparisons were tried and none separates the two, which is the same dead end
 * the avatar hole/gap discriminators reached.
 *
 * So the output is not measured at all. Each derivative records the sha256 of
 * the INPUT it was made from. That is exact, free, and indifferent to which
 * libvips produced the bytes.
 */
import { describe, it, expect } from 'vitest';
import { createHash } from 'crypto';
import { existsSync, readFileSync, readdirSync } from 'fs';
import { join, resolve } from 'path';

// @ts-expect-error - plain .mjs build helper, no type declarations by design
import { THUMBNAIL_SOURCE_MANIFEST } from '../scripts/lib/customization-thumbnail-policy.mjs';

const ROOT = resolve(__dirname, '..');
const FIX =
  'Run: npm run assets:customization-thumbnails (then commit the derivative and the manifest)';

type Entry = { source: string; sha256: string };

const manifest: Record<string, Entry> = JSON.parse(
  readFileSync(join(ROOT, THUMBNAIL_SOURCE_MANIFEST as string), 'utf8')
);

/** The two derivative families the generator maintains, and their sources. */
const TARGETS = [
  { source: 'src/assets/tables', output: 'src/assets/customization-thumbs/tables', ext: /\.png$/i },
  {
    source: 'src/assets/backgrounds',
    output: 'src/assets/customization-thumbs/backgrounds',
    ext: /\.(jpg|jpeg|png)$/i,
  },
];

const sourceFiles = TARGETS.flatMap((t) =>
  readdirSync(join(ROOT, t.source))
    .filter((f) => t.ext.test(f))
    .sort()
    .map((f) => ({
      source: `${t.source}/${f}`,
      output: `${t.output}/${f.replace(/\.(jpg|jpeg|png)$/i, '.webp')}`,
    }))
);

const sha256 = (rel: string) =>
  createHash('sha256')
    .update(readFileSync(join(ROOT, rel)))
    .digest('hex');

describe('every Studio thumbnail knows which art it came from', () => {
  it('finds the art at all, so a move does not make every case below vacuous', () => {
    // 14 table skins + 31 backgrounds.
    expect(sourceFiles.length).toBe(45);
  });

  it.each(sourceFiles)('$output has a manifest entry', ({ output }) => {
    expect(manifest[output], `${output} records no source. ${FIX}`).toBeTruthy();
  });

  it.each(sourceFiles)('$output was generated from the art now on disk', ({ source, output }) => {
    const entry = manifest[output];
    if (!entry) return; // reported by the case above; do not double-fail

    expect(entry.source, `${output} records the wrong source file`).toBe(source);
    expect(
      entry.sha256,
      `${output} was generated from a different version of ${source} than the one committed. ` +
        `The picker is showing the old picture. ${FIX}`
    ).toBe(sha256(source));
  });

  it.each(sourceFiles)('$output actually exists', ({ output }) => {
    expect(existsSync(join(ROOT, output)), `${output} is missing. ${FIX}`).toBe(true);
  });
});

describe('the manifest does not accumulate entries for art that is gone', () => {
  it('names only derivatives the generator still produces', () => {
    const live = new Set(sourceFiles.map((f) => f.output));
    const orphans = Object.keys(manifest).filter((k) => !live.has(k));

    expect(
      orphans,
      'these manifest entries point at derivatives nothing generates any more; delete them ' +
        'along with the derivative itself'
    ).toEqual([]);
  });
});
