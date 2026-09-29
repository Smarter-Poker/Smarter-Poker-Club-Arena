import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, copyFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

/**
 * This test spawns the real optimizer and waits for it. Two budgets govern
 * that wait: the one this test grants the child process, and the one vitest
 * grants this test. If the second is not larger than the first, the test can
 * fail while the child is still inside the time it was given - which is what
 * happened on 2026-09-24, when the child finished in 5,248ms against vitest's
 * 5,000ms default and shard 4 went red on a branch that touches no artwork.
 *
 * So both budgets come from one number here, and the test's own budget is
 * derived from the child's rather than written next to it. A later change to
 * how long the optimizer may take moves both, and they cannot drift apart.
 */
const OPTIMIZER_BUDGET_MS = 15000;
const TEST_BUDGET_MS = OPTIMIZER_BUDGET_MS + 5000;

describe('production throwable artwork', () => {
  it(
    'preserves verified lossless atlases through the actual production optimizer',
    () => {
      const root = mkdtempSync(join(tmpdir(), 'throwable-dist-'));
      try {
        const folder = join(root, 'dist/images/throwables/animated');
        mkdirSync(folder, { recursive: true });
        const stillFolder = join(root, 'dist/images/throwables/stylized');
        mkdirSync(stillFolder, { recursive: true });
        const source = resolve('public/images/throwables/animated/beer.webp');
        const before = readFileSync(source);
        expect(before.length).toBeGreaterThan(40 * 1024);
        copyFileSync(source, join(folder, 'beer.webp'));
        copyFileSync(source, join(stillFolder, 'beer.webp'));
        copyFileSync(source, join(root, 'dist/images/control.webp'));
        const result = spawnSync(
          process.execPath,
          [resolve('scripts/optimize-dist-media.mjs'), root],
          { encoding: 'utf8', timeout: OPTIMIZER_BUDGET_MS }
        );
        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout).toContain('optimized=1');
        expect(readFileSync(join(folder, 'beer.webp')).equals(before)).toBe(true);
        expect(readFileSync(join(stillFolder, 'beer.webp')).equals(before)).toBe(true);
        expect(readFileSync(join(root, 'dist/images/control.webp')).equals(before)).toBe(false);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    TEST_BUDGET_MS
  );
});
