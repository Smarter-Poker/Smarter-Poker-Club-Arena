import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { cpus, tmpdir } from 'node:os';
import path from 'node:path';
import { build, type Plugin } from 'vite';

const directories: string[] = [];
beforeEach(() => {
  vi.stubEnv('VITE_NATIVE', '');
  vi.stubEnv('NODE_ENV', 'production');
});

afterEach(() => {
  vi.unstubAllEnvs();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe('Build file concurrency reaches Rollup', () => {
  it.each([
    { name: 'local intended cap', ci: undefined, override: undefined, expected: 20 },
    {
      name: 'actual shared CI host',
      ci: '1',
      override: undefined,
      expected: Math.max(4, Math.floor(cpus().length / 2)),
    },
    { name: 'minimum CI cap', ci: '1', override: '4', expected: 4 },
    { name: 'explicit operator cap', ci: '1', override: '7', expected: 7 },
    { name: 'empty override uses local default', ci: undefined, override: '', expected: 20 },
  ])('$name', async ({ ci, override, expected }) => {
    vi.stubEnv('CI', ci);
    vi.stubEnv('ROLLUP_MAX_FILE_OPS', override);
    vi.resetModules();
    const config = (await import('../../vite.config')).default;
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'ca-build-concurrency-')));
    directories.push(root);
    writeFileSync(
      path.join(root, 'index.html'),
      '<!doctype html><script type="module" src="/entry.js"></script>'
    );
    writeFileSync(path.join(root, 'entry.js'), 'globalThis.concurrencyFixture = true;');
    const observed: (number | undefined)[] = [];
    const observer: Plugin = {
      name: 'observe-actual-rollup-options',
      options(options) {
        observed.push(options.maxParallelFileOps);
      },
    };
    // Use the real Vite config and Rollup input pipeline. The tiny bundle stays
    // in memory, so no existing dist, manifest, or source map can be overwritten.
    await build({
      ...config,
      configFile: false,
      root,
      publicDir: false,
      logLevel: 'silent',
      plugins: [...(config.plugins ?? []), observer],
      build: { ...config.build, write: false },
    });
    expect(observed).toEqual([expected]);
  });
  it.each(['0', '-1', 'NaN', '3x', '1.5', 'Infinity', '1e309', '9007199254740992', '  '])(
    'refuses invalid override %s before building',
    async (override) => {
      vi.stubEnv('ROLLUP_MAX_FILE_OPS', override);
      vi.resetModules();
      await expect(import('../../vite.config')).rejects.toThrow(
        'ROLLUP_MAX_FILE_OPS must be a positive safe integer.'
      );
    }
  );
});
