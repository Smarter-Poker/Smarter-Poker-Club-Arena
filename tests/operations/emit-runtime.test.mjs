import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { HEAP_FLAGS, MAX_BATCH_BYTES, planBatches } from '../../server/scripts/emit-runtime.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const emitter = path.join(root, 'server/scripts/emit-runtime.mjs');
const compiler = path.join(root, 'server/node_modules/typescript/bin/tsc');
function fixture(run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-emit-'));
  try {
    fs.mkdirSync(path.join(dir, 'src'));
    fs.writeFileSync(
      path.join(dir, 'tsconfig.runtime.json'),
      JSON.stringify({
        compilerOptions: {
          target: 'ES2022',
          module: 'ESNext',
          moduleResolution: 'bundler',
          rootDir: './src',
          outDir: './dist',
          declaration: false,
          declarationMap: false,
          sourceMap: true,
          strict: true,
          skipLibCheck: true,
          types: [],
        },
        include: ['src/**/*'],
      })
    );
    fs.writeFileSync(
      path.join(dir, 'tsconfig.emit.json'),
      JSON.stringify({
        extends: './tsconfig.runtime.json',
        compilerOptions: { noCheck: true, noResolve: true, types: [] },
      })
    );
    run(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
function invoke(dir, args = ['--project', 'tsconfig.emit.json'], flags = HEAP_FLAGS) {
  return spawnSync(process.execPath, [...flags, emitter, ...args], {
    cwd: dir,
    encoding: 'utf8',
    timeout: 60000,
  });
}
function outputs(dir) {
  return Object.fromEntries(
    fs
      .readdirSync(dir, { recursive: true })
      .sort()
      .filter((file) => fs.statSync(path.join(dir, file)).isFile())
      .map((file) => [file, fs.readFileSync(path.join(dir, file), 'utf8')])
  );
}

test('root partition is complete, deterministic and bounded by bytes and count', () => {
  const files = Array.from({ length: 130 }, (_, i) => `source-${String(i).padStart(3, '0')}.ts`);
  const batches = planBatches([...files].reverse(), () => 1);
  assert.deepEqual(
    batches.map((batch) => batch.length),
    [64, 64, 2]
  );
  assert.deepEqual(batches.flat(), files);
  assert.deepEqual(
    planBatches(['a', 'b', 'c'], () => MAX_BATCH_BYTES / 2),
    [['a', 'b'], ['c']]
  );
  for (const roots of [[], ['a', 'a']]) assert.throws(() => planBatches(roots));
  for (const size of [-1, NaN, MAX_BATCH_BYTES + 1])
    assert.throws(() => planBatches(['a'], () => size));
});

test('real sequential TypeScript emission equals a separately checked multi-batch runtime', () =>
  fixture((dir) => {
    fs.writeFileSync(
      path.join(dir, 'src/000-types.ts'),
      'export interface Data { count: number }\n'
    );
    for (let i = 1; i <= 65; i += 1) {
      fs.writeFileSync(
        path.join(dir, `src/${String(i).padStart(3, '0')}-module.ts`),
        `import type { Data } from './000-types.js';\nexport const value${i}: Data = { count: ${i} };\n`
      );
    }
    const checked = spawnSync(process.execPath, [compiler, '--project', 'tsconfig.runtime.json'], {
      cwd: dir,
      encoding: 'utf8',
      timeout: 60000,
    });
    assert.equal(checked.status, 0, checked.stdout + checked.stderr);
    const expected = outputs(path.join(dir, 'dist'));
    fs.rmSync(path.join(dir, 'dist'), { recursive: true });
    const actual = invoke(dir);
    assert.equal(actual.status, 0, actual.stdout + actual.stderr);
    assert.match(actual.stdout, /"runtimeEmitComplete":true,"roots":66,"batches":2/);
    assert.deepEqual(outputs(path.join(dir, 'dist')), expected);
  }));

test('syntax failure stops the owning emission before later batches', () =>
  fixture((dir) => {
    fs.writeFileSync(path.join(dir, 'src/000-invalid.ts'), 'export const broken = ;');
    for (let i = 1; i <= 65; i += 1) {
      fs.writeFileSync(
        path.join(dir, `src/${String(i).padStart(3, '0')}-later.ts`),
        'export const valid = 1;'
      );
    }
    const result = invoke(dir);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Expression expected/);
    assert.doesNotMatch(result.stdout, /runtimeEmitComplete/);
    assert.equal(fs.existsSync(path.join(dir, 'dist/065-later.js')), false);
  }));

test('changed heap, unknown batch and project drift are refused', () =>
  fixture((dir) => {
    fs.writeFileSync(path.join(dir, 'src/index.ts'), 'export const value = 1;');
    assert.notEqual(invoke(dir, undefined, ['--max-old-space-size=768']).status, 0);
    assert.notEqual(invoke(dir, ['--batch-index', '999']).status, 0);
    assert.notEqual(invoke(dir, ['--project', 'tsconfig.runtime.json']).status, 0);
    const config = JSON.parse(fs.readFileSync(path.join(dir, 'tsconfig.emit.json'), 'utf8'));
    config.compilerOptions.noResolve = false;
    fs.writeFileSync(path.join(dir, 'tsconfig.emit.json'), JSON.stringify(config));
    assert.notEqual(invoke(dir).status, 0);
    assert.equal(fs.existsSync(path.join(dir, 'dist')), false);
  }));
