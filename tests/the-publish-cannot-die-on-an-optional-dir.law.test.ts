/**
 * LAW: nothing OPTIONAL may stop the publish, and nothing AFTER the swap may
 * report a live release as a failure.
 *
 * Found 2026-09-03 auditing the new origin publisher. The pool upload was:
 *
 *   rsync -az ... dist/assets/ ...:$ORIGIN_ROOT/pool/assets/
 *   rsync -az ... dist/fonts/  ...:$ORIGIN_ROOT/pool/fonts/
 *   $SSH "set -e; ... ln -sfn ... && mv -Tf current.tmp current && ..."
 *
 * `dist/fonts` is NOT guaranteed. scripts/self-host-fonts.mjs is deliberately
 * non-fatal and returns early when dist/index.html is missing, when it finds
 * no Google Fonts URL, and on any download failure; no font file is committed
 * to this repo. rsync exits 23 on a missing source directory, and under
 * `set -euo pipefail` that killed the job between the release upload and the
 * symlink swap - so the release existed on the origin, `current` still pointed
 * at the old one, nothing shipped, and the failure looked like a build problem.
 * Verified on GNU coreutils: old shape exits 23 with no `current`; guarded
 * shape publishes and `current` resolves to the new release.
 *
 * The second half is the mirror image. Once `mv -Tf` has run the site IS live.
 * Pruning old releases and ageing the pool happen after that, and a failure
 * there must not turn a shipped publish red - the next run retries it anyway.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const wf = readFileSync(join(__dirname, '../.github/workflows/publish-club-arena.yml'), 'utf8');

describe('the publish cannot die on an optional directory', () => {
  it('every pooled directory is existence-checked before rsync', () => {
    // The bare `rsync dist/fonts/` form is what exits 23 and stops the world.
    expect(wf).not.toMatch(/^\s*rsync[^\n]*\sdist\/fonts\//m);
    expect(wf).not.toMatch(/^\s*rsync[^\n]*\sdist\/assets\//m);
    expect(wf).toMatch(/for POOLED in assets fonts; do/);
    expect(wf).toMatch(/if \[ -d "dist\/\$POOLED" \]; then/);
  });

  it('the symlink swap is the last thing under set -e', () => {
    const i = wf.indexOf('mv -Tf current.tmp current');
    expect(i).toBeGreaterThan(-1);
    // The swap command must END at readlink - no pruning chained onto it.
    const swapLine = wf.slice(wf.lastIndexOf('\n', i), wf.indexOf('\n', i));
    expect(swapLine).toContain('set -e;');
    expect(swapLine).toContain('readlink current');
    expect(swapLine).not.toContain('rm -rf');
    expect(swapLine).not.toContain('find pool');
  });

  it('housekeeping after the swap cannot fail the job', () => {
    const i = wf.indexOf('find pool -type f -mtime');
    expect(i).toBeGreaterThan(-1);
    const block = wf.slice(wf.lastIndexOf('$SSH', i), i + 500);
    // It runs in its own SSH call, without set -e, and its failure is a
    // warning - because the release is already live by then.
    expect(block).not.toContain('set -e;');
    expect(block).toMatch(/\|\| echo/);
    expect(block).toMatch(/::warning::.*the release IS live/);
  });
});
