import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runInNewContext } from 'node:vm';
import { build } from 'vite';
import type { RollupOutput } from 'rollup';

const directories: string[] = [];
const source = 'globalThis.sourceMapProbe = function sourceMapProbe() { return 19 + 1; };';

beforeEach(() => {
  vi.stubEnv('NODE_ENV', 'production');
  vi.stubEnv('ROLLUP_MAX_FILE_OPS', '4');
});
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of directories.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function buildProbe(native: boolean, linked = false) {
  vi.stubEnv('VITE_NATIVE', native ? '1' : '');
  vi.resetModules();
  const config = (await import('../../vite.config')).default;
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'ca-source-map-')));
  directories.push(root);
  writeFileSync(path.join(root, 'entry.js'), source);
  // Exercise the actual config in memory. No app dist, upload, dependency
  // installation or build manifest is created on the workstation.
  const result = (await build({
    ...config,
    configFile: false,
    root,
    publicDir: false,
    logLevel: 'silent',
    build: {
      ...config.build,
      ...(linked ? { sourcemap: true } : {}),
      write: false,
      rollupOptions: {
        ...config.build?.rollupOptions,
        input: path.join(root, 'entry.js'),
        output: {
          ...config.build?.rollupOptions?.output,
          entryFileNames: 'assets/probe-[hash].js',
        },
      },
    },
  })) as RollupOutput;
  const chunk = result.output.find((item) => item.type === 'chunk');
  if (!chunk || chunk.type !== 'chunk') throw new Error('No executable probe chunk');
  return { output: result.output, chunk };
}

describe('Source maps stay out of application output', () => {
  it('changes only the map reference, leaving executable output identical', async () => {
    const hidden = await buildProbe(false);
    const linked = await buildProbe(false, true);
    expect(linked.chunk.code).toContain(
      `sourceMappingURL=${path.basename(linked.chunk.fileName)}.map`
    );
    expect(hidden.chunk.code.trim()).toBe(
      linked.chunk.code.replace(/^\/\/# sourceMappingURL=.*$/m, '').trim()
    );
    const context: { sourceMapProbe?: () => number } = {};
    runInNewContext(hidden.chunk.code, context);
    expect(context.sourceMapProbe?.()).toBe(20);
  });

  it('never reuses an immutable chunk URL when the emitted map reference changes', async () => {
    const hidden = await buildProbe(false);
    const linked = await buildProbe(false, true);
    expect(hidden.chunk.code).not.toBe(linked.chunk.code);
    expect(hidden.chunk.fileName).not.toBe(linked.chunk.fileName);

    const repeated = await buildProbe(false);
    expect(repeated.chunk.fileName).toBe(hidden.chunk.fileName);
    expect(repeated.chunk.code).toBe(hidden.chunk.code);
  });

  it.each([false, true])('keeps web and native builds free of maps (native=%s)', async (native) => {
    const { output, chunk } = await buildProbe(native);
    expect(output.filter((item) => item.fileName.endsWith('.map'))).toEqual([]);
    expect(chunk.map).toBeNull();
    expect(chunk.code).not.toContain('sourceMappingURL');
  });
});
