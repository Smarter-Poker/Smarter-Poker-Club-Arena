/**
 * A SHIPPED ASSET URL'S BYTES ARE PERMANENT (2026-09-23).
 *
 * `/hub/club-arena/assets/**` is served from the origin's ADDITIVE pool.
 * `.github/scripts/publish-origin-activate.sh` walks the staged release against
 * `pool/assets` and refuses the whole transaction when a path that is already
 * pooled arrives with different bytes:
 *
 *     pooled runtime URL would change bytes: diamond-spins/README.md
 *
 * That is exactly how the Diamond Wheel v4 release failed to publish: a
 * provenance note was APPENDED to an art README that had already shipped, so a
 * permanent URL changed under a browser that may still be holding the old copy.
 * Nothing went out until the README was put back byte for byte.
 *
 * Adding art is additive and always allowed - new files, new URLs. Editing a
 * file that is already out there is not, and neither is putting prose in the
 * pool, where every future word is a byte change waiting to happen. Notes about
 * the art belong in `docs/`.
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ASSETS = path.join(process.cwd(), 'public/assets');

function every(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    return entry.isDirectory() ? every(full) : [full];
  });
}

describe('a pooled runtime URL keeps the bytes it shipped with', () => {
  it('holds the Diamond Spins art README to the bytes the pool already has', () => {
    const readme = path.join(ASSETS, 'diamond-spins/README.md');
    const bytes = readFileSync(readme);
    // Published, and therefore frozen. A change here does not fail a test: it
    // fails the publish, after the merge, with nothing shipped.
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(
      '83ecae3e00e4e9f247c78a7a0ba44e5833b5f95680c315822b0b7f1913d063e0'
    );
    expect(bytes).toHaveLength(930);
  });

  it('keeps prose out of the pool, so nothing new has to be frozen', () => {
    const prose = every(ASSETS)
      .filter((file) => file.toLowerCase().endsWith('.md'))
      .map((file) => path.relative(ASSETS, file));
    // The three that are already out there, and nothing else: each of them is
    // frozen where it stands, and a new note goes to docs/ instead.
    expect(prose.sort()).toEqual([
      'club-buttons/console/spade-console-v1/source/README.md',
      'club-buttons/table-management/command-rail-v1/README.md',
      'diamond-spins/README.md',
    ]);
  });
});
