import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * The standalone Diamond bonus test entry (diamond-test.html) is built as a
 * SECOND Vite pass, never as a second Rollup input of the application build.
 * A second input hoists every shared module into a shared chunk whose CSS
 * Vite links ahead of the application stylesheet; that reordered the cascade
 * for the whole arena and turned the Table Studio pixel baselines red on a
 * page the test entry never touches (CI run 35458870630, 2026-09-19).
 *
 * These pin the two halves of that contract: the application build keeps one
 * default input and its assets/ layout, and the test pass keeps to its own
 * directory without emptying or re-copying what the first pass wrote.
 */
const ROOT = path.join(__dirname, '..', '..');
const read = (file: string) => readFileSync(path.join(ROOT, file), 'utf8');

type BuiltConfig = {
  build?: {
    emptyOutDir?: boolean;
    copyPublicDir?: boolean;
    rollupOptions?: {
      input?: unknown;
      output?: {
        entryFileNames?: unknown;
        chunkFileNames?: unknown;
        assetFileNames?: unknown;
      };
    };
  };
};

async function load(entry: string | undefined): Promise<BuiltConfig> {
  vi.stubEnv('CA_HTML_ENTRY', entry);
  vi.resetModules();
  return (await import('../../vite.config')).default as BuiltConfig;
}

describe('the Diamond test entry is a pass of its own', () => {
  beforeEach(() => {
    vi.stubEnv('VITE_NATIVE', '');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('the application build keeps a single default input and the assets/ layout', async () => {
    const config = await load(undefined);
    const build = config.build!;
    expect(build.rollupOptions?.input).toBeUndefined();
    expect(build.emptyOutDir).toBeUndefined();
    expect(build.copyPublicDir).toBeUndefined();
    expect(build.rollupOptions?.output?.entryFileNames).toBe('assets/[name]-[hash]-v6.js');
    expect(build.rollupOptions?.output?.chunkFileNames).toBe('assets/[name]-[hash]-v6.js');
  });

  it('the test pass builds only diamond-test.html, beside the first pass, under diamond-test/', async () => {
    const config = await load('diamond-test');
    const build = config.build!;
    expect(build.rollupOptions?.input).toBe(path.resolve(ROOT, 'diamond-test.html'));
    expect(build.emptyOutDir).toBe(false);
    expect(build.copyPublicDir).toBe(false);
    expect(build.rollupOptions?.output?.entryFileNames).toBe('diamond-test/[name]-[hash]-v6.js');
    expect(build.rollupOptions?.output?.chunkFileNames).toBe('diamond-test/[name]-[hash]-v6.js');
    const assetFileNames = build.rollupOptions?.output?.assetFileNames as (asset: {
      names?: string[];
      name?: string;
      source: unknown;
    }) => string;
    expect(typeof assetFileNames).toBe('function');
    // Stylesheets stay out of dist/assets/ (bundle-size.mjs charges that
    // directory to the arena's total); media keeps the shared identity policy
    // so artwork both entries import is written once.
    expect(assetFileNames({ names: ['diamondTest.css'], source: '' })).toBe(
      'diamond-test/[name]-[hash]-v6[extname]'
    );
    expect(assetFileNames({ names: ['logo.svg'], source: '' })).toBe(
      'assets/[name]-[hash]-v6[extname]'
    );
  });

  it('an unrelated CA_HTML_ENTRY value is the application build', async () => {
    const config = await load('index');
    expect(config.build?.rollupOptions?.input).toBeUndefined();
    expect(config.build?.rollupOptions?.output?.entryFileNames).toBe('assets/[name]-[hash]-v6.js');
  });

  it('build:ci runs the pass right after the application build and before the dist is stamped', () => {
    const { scripts } = JSON.parse(read('package.json'));
    const steps: string[] = scripts['build:ci'].split('&&').map((s: string) => s.trim());
    const at = (needle: string) => steps.findIndex((s) => s.includes(needle));
    expect(at('scripts/build-diamond-test.mjs')).toBe(at('vite build') + 1);
    expect(at('scripts/build-diamond-test.mjs')).toBeLessThan(
      at('scripts/stamp-manifest-base.mjs')
    );
  });

  it('the pass is web-only and never rebuilds through a second input', () => {
    const script = read('scripts/build-diamond-test.mjs');
    expect(script).toContain("process.env.VITE_NATIVE === '1'");
    expect(script).toContain("process.env.CA_HTML_ENTRY = 'diamond-test'");
    // The switch is set before Vite loads the config, and the pass reuses the
    // one config file rather than a second, driftable copy of it.
    expect(script.indexOf("process.env.CA_HTML_ENTRY = 'diamond-test'")).toBeLessThan(
      script.indexOf("await import('vite')")
    );
    expect(script).toContain("configFile: 'vite.config.ts'");
    const vite = read('vite.config.ts');
    expect(vite).not.toMatch(/input:\s*\{/);
    expect(vite).toContain("path.resolve(__dirname, 'diamond-test.html')");
  });
});
