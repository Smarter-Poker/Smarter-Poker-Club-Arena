import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { rollup } from 'rollup';

// Real generated modules exercise the observable risk of chunk merging:
// eagerly running lazy entries, reordering side effects, or breaking cycles.
// This is a small disposable module graph, never an application build/install.
const modules = {
  entry: `import {events} from 'state';
    events.push('entry'); export {events};
    export const loadA = () => import('a');
    export const loadB = () => import('b');`,
  state: 'export const events = [];',
  shared: `export const meaning = () => 42;`,
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

async function execute(size, order) {
  const directory = await mkdtemp(join(tmpdir(), 'ca-chunk-order-'));
  let bundle;
  try {
    bundle = await rollup({
      input: 'entry',
      plugins: [
        {
          name: 'owned-virtual-graph',
          resolveId(id) {
            return Object.hasOwn(modules, id) ? id : null;
          },
          load(id) {
            return modules[id];
          },
        },
      ],
      onwarn(warning) {
        if (warning.code !== 'CIRCULAR_DEPENDENCY') throw new Error(warning.code);
      },
    });
    const { output } = await bundle.generate({
      format: 'es',
      entryFileNames: 'entry.mjs',
      chunkFileNames: '[name]-[hash].mjs',
      experimentalMinChunkSize: size,
    });
    for (const chunk of output) {
      assert.equal(chunk.type, 'chunk');
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
    await bundle?.close();
    await rm(directory, { recursive: true, force: true });
  }
}

for (const order of [
  ['a', 'b', 'a'],
  ['b', 'a', 'b'],
]) {
  test(`small chunks preserve lazy side effects, live cycle bindings and cached imports: ${order}`, async () => {
    const original = await execute(1, order);
    const combined = await execute(4096, order);
    assert.deepEqual(combined, original);
    assert.deepEqual(combined[0], { events: ['entry'] });
    assert.deepEqual(combined[1].events, ['entry', order[0]]);
    assert.deepEqual(combined[2].events, ['entry', ...order.slice(0, 2)]);
    assert.deepEqual(combined[3].events, combined[2].events);
    assert.equal(combined[1].value, order[0] === 'a' ? 46 : 42);
    assert.equal(combined[2].value, order[1] === 'a' ? 46 : 42);
  });
}
