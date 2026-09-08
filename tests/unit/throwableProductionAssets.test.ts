import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, copyFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

describe('production throwable artwork', () => {
  it('preserves verified lossless atlases through the actual production optimizer', () => {
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
        { encoding: 'utf8', timeout: 15000 }
      );
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain('optimized=1');
      expect(readFileSync(join(folder, 'beer.webp')).equals(before)).toBe(true);
      expect(readFileSync(join(stillFolder, 'beer.webp')).equals(before)).toBe(true);
      expect(readFileSync(join(root, 'dist/images/control.webp')).equals(before)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
