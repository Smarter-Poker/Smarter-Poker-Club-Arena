import test from 'node:test';
import assert from 'node:assert/strict';
import { availableParallelism } from 'node:os';
import { spawnSync } from 'node:child_process';
import { clientVitestWorkerBudget as budget } from '../../scripts/ci/client-vitest-worker-budget.mjs';

test('requested width uses public VM capacity and clamps smaller private allocations', () => {
  for (const cpus of [1, 2, 4, 8, 16])
    assert.equal(budget({ requested: '8', ci: true, availableCpus: cpus }), Math.min(8, cpus));
  assert.equal(budget({ requested: '4', ci: true, availableCpus: 4 }), 4);
  assert.equal(budget({ requested: '4', ci: true, availableCpus: 2 }), 2);
  assert.equal(budget({ requested: '4', ci: true, availableCpus: 1 }), 1);
  assert.equal(budget({ requested: '999999', ci: true, availableCpus: 4 }), 4);
});

test('local explicit cap remains effective while ordinary local runs stay uncapped', () => {
  assert.equal(budget({ requested: '2', availableCpus: 28 }), 2);
  assert.equal(budget({ requested: undefined, availableCpus: 28 }), undefined);
  assert.equal(budget({ requested: '', availableCpus: 28 }), undefined);
  assert.equal(budget({ availableCpus: undefined }), undefined);
});

test('invalid requests use a conservative allowance bounded by actual CPUs', () => {
  for (const requested of [
    '0',
    '-1',
    '1.5',
    'Infinity',
    'NaN',
    'four',
    ' 4 ',
    '4x',
    '9007199254740992',
    null,
    4,
    true,
  ]) {
    assert.equal(budget({ requested, ci: true, availableCpus: 4 }), 2, String(requested));
    assert.equal(budget({ requested, ci: true, availableCpus: 1 }), 1, String(requested));
  }
});

test('unknown or invalid CPU allowances never claim more than one worker', () => {
  for (const availableCpus of [undefined, null, 0, -1, 1.5, NaN, Infinity, '4', 9007199254740992]) {
    assert.equal(budget({ requested: '4', ci: true, availableCpus }), 1);
    assert.equal(budget({ ci: true, availableCpus }), 1);
  }
});

test('CI without an override preserves its prior shared-host budget within capacity', () => {
  for (const [availableCpus, expected] of [
    [1, 1],
    [2, 2],
    [4, 2],
    [8, 2],
    [16, 4],
    [28, 7],
  ]) {
    assert.equal(budget({ ci: true, availableCpus }), expected);
    assert.equal(budget({ requested: '', ci: true, availableCpus }), expected);
  }
});

test('the real Vitest config enforces the budget without starting any test workers', () => {
  const readConfig = ({ requested, ci }) => {
    const env = { ...process.env };
    delete env.VITEST_MAX_THREADS;
    delete env.CI;
    if (requested !== undefined) env.VITEST_MAX_THREADS = requested;
    if (ci) env.CI = 'true';
    const child = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
      import { loadConfigFromFile } from 'vite';
      const result = await loadConfigFromFile({ command: 'serve', mode: 'test' }, 'vitest.config.ts');
      console.log(JSON.stringify({ workers: result.config.test.maxWorkers ?? null }));
    `,
      ],
      { cwd: process.cwd(), env, encoding: 'utf8' }
    );
    assert.equal(child.status, 0, child.stderr);
    return JSON.parse(child.stdout.trim()).workers;
  };
  const cpus = availableParallelism();
  assert.equal(readConfig({ requested: String(cpus + 100), ci: true }), cpus);
  assert.equal(readConfig({ requested: '2', ci: true }), Math.min(2, cpus));
  assert.equal(readConfig({ requested: '8', ci: true }), Math.min(8, cpus));
  assert.equal(readConfig({ requested: undefined, ci: false }), null);
});
