import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build, loadConfigFromFile } from 'vite';
import { resolve } from 'node:path';

const loaded = await loadConfigFromFile(
  { command: 'build', mode: 'production' },
  resolve('vite.config.ts')
);
assert.ok(loaded);
const configured = loaded.config.build;
assert.equal(configured.minify, 'terser');
assert.equal(configured.rollupOptions.output.experimentalMinChunkSize, undefined);

// Real Vite-generated modules compare the configured production minifier with
// an unminified control: lazy execution, cycles, caching and license retention.
// This is a small disposable module graph, never an application build/install.
const modules = {
  entry: `import {events} from 'state';
    events.push('entry'); export {events};
    export const loadA = () => import('a');
    export const loadB = () => import('b');`,
  state: 'export const events = [];',
  shared: `/*! @license owned-regression-fixture */ export const meaning = () => 42;`,
  a: `import {events} from 'state'; import {meaning} from 'shared';
    import {left} from 'left'; events.push('a');
    export const value = meaning() + left();`,
  b: `import {events} from 'state'; import {meaning} from 'shared';
    events.push('b'); export const value = meaning();`,
  left: `import {right} from 'right'; export const name = 'left';
    export const left = () => right();`,
  right: `import {name} from 'left';
    export const right = () => name.length;`,
};

async function execute(minified, order) {
  const directory = await mkdtemp(join(tmpdir(), 'ca-chunk-order-'));
  try {
    const { output } = await build({
      configFile: false,
      root: resolve('.'),
      envFile: false,
      base: './',
      logLevel: 'silent',
      esbuild: loaded.config.esbuild,
      define: loaded.config.define,
      plugins: [
        {
          name: 'owned-virtual-graph',
          resolveId(id) {
            return Object.hasOwn(modules, id) ? '\0' + id : null;
          },
          load(id) {
            return modules[id.slice(1)];
          },
        },
      ],
      build: {
        minify: minified ? configured.minify : false,
        terserOptions: configured.terserOptions,
        modulePreload: false,
        sourcemap: 'hidden',
        write: false,
        rollupOptions: {
          input: 'entry',
          preserveEntrySignatures: 'strict',
          onwarn(warning) {
            if (warning.code !== 'CIRCULAR_DEPENDENCY') throw new Error(warning.code);
          },
          output: {
            format: 'es',
            entryFileNames: 'entry.mjs',
            chunkFileNames: '[name]-[hash].mjs',
          },
        },
      },
    });
    assert.ok(output.some((chunk) => chunk.type === 'asset' && chunk.fileName.endsWith('.map')));
    assert.ok(
      output.some(
        (chunk) =>
          chunk.type === 'chunk' && chunk.code.includes('@license owned-regression-fixture')
      )
    );
    for (const chunk of output) {
      if (chunk.type !== 'chunk') continue;
      assert.ok(!chunk.code.includes('sourceMappingURL='));
      assert.match(chunk.fileName, /^[A-Za-z0-9_-]+\.mjs$/);
      await writeFile(join(directory, chunk.fileName), chunk.code, { flag: 'wx' });
    }
    const entry = await import(pathToFileURL(join(directory, 'entry.mjs')).href);
    const observed = [{ events: [...entry.events] }];
    for (const name of order) {
      const value = await (name === 'a' ? entry.loadA() : entry.loadB());
      observed.push({ events: [...entry.events], value: value.value });
    }
    return observed;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

for (const order of [
  ['a', 'b', 'a'],
  ['b', 'a', 'b'],
]) {
  test(`configured minifier preserves lazy execution, cycles, cached imports, license and hidden maps: ${order}`, async () => {
    const original = await execute(false, order);
    const combined = await execute(true, order);
    assert.deepEqual(combined, original);
    assert.deepEqual(combined[0], { events: ['entry'] });
    assert.deepEqual(combined[1].events, ['entry', order[0]]);
    assert.deepEqual(combined[2].events, ['entry', ...order.slice(0, 2)]);
    assert.deepEqual(combined[3].events, combined[2].events);
    assert.equal(combined[1].value, order[0] === 'a' ? 46 : 42);
    assert.equal(combined[2].value, order[1] === 'a' ? 46 : 42);
  });
}
