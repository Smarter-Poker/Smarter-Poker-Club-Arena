import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  presentationOnly,
  selectionInputs,
  consumedInputs,
  browserSpecs,
} from '../../scripts/ci/ui-test-selection.mjs';
import {
  classifyChangedPaths,
  gitEnvironmentForCwd,
} from '../../scripts/ci/classify-ci-changes.mjs';

const owned = (fn) => {
  const root = mkdtempSync(join(tmpdir(), 'ui-selection-'));
  try {
    fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};
const write = (root, p, s) => {
  mkdirSync(join(root, p, '..'), { recursive: true });
  writeFileSync(join(root, p), s);
};

test('presentation proof rejects executable, global and malformed changes', () => {
  const p = 'src/components/example/Control.tsx';
  const a = 'export const Control = () => <button onClick={pay}>Continue</button>;';
  assert.equal(presentationOnly(p, a, a.replace('Continue', 'Proceed')), true);
  for (const b of [
    a.replace('pay', 'cancel'),
    a.replace('button onClick', 'button disabled onClick'),
    a.replace('pay', '() => pay(2)'),
    a + '\nrunPayment();',
  ])
    assert.equal(presentationOnly(p, a, b), false);
  const css = 'src/components/example/Control.module.css';
  assert.equal(presentationOnly(css, '.button { color: red }', '.button { color: blue }'), true);
  for (const b of [
    'body {color:red}',
    ':global(.button) {color:red}',
    '.x {background:url(/x)}',
    '@keyframes x {from {opacity:0}}',
    '@property --x {syntax: "*";inherits:true}',
    '.x {composes: y from "./other.css"}',
    '.x {',
  ])
    assert.equal(presentationOnly(css, '.x {}', b), false);
  assert.equal(presentationOnly('src/services/PaymentService.ts', a, a), false);
  for (const tag of ['option', 'textarea', 'script', 'style', 'Amount']) {
    assert.equal(
      presentationOnly(
        p,
        `export const X=()=> <${tag}>One</${tag}>;`,
        `export const X=()=> <${tag}>Two</${tag}>;`
      ),
      false
    );
  }
  assert.equal(
    presentationOnly(p, a.replace('Continue', 'Pay 10'), a.replace('Continue', 'Pay 20')),
    false
  );
  assert.equal(
    presentationOnly('src/pages/CashierPage.tsx', a, a.replace('Continue', 'Proceed')),
    false
  );

  assert.equal(classifyChangedPaths(['scripts/ci/ui-test-selection.mjs']).server, true);
});

test('exact Git proof refuses missing inputs, executable companions, deletes and wrong checkout', () =>
  owned((root) => {
    const git = (...a) =>
      execFileSync('git', a, { cwd: root, env: gitEnvironmentForCwd(), encoding: 'utf8' }).trim();
    git('init', '-q');
    git('config', 'user.name', 'Selection Test');
    git('config', 'user.email', 'selection@example.invalid');
    const p = 'src/components/example/Control.tsx';
    write(root, p, 'export const Control = () => <button>Continue</button>;');
    git('add', '.');
    git('commit', '-qm', 'base');
    const base = git('rev-parse', 'HEAD');
    write(root, p, 'export const Control = () => <button>Proceed</button>;');
    git('add', '.');
    git('commit', '-qm', 'copy');
    const head = git('rev-parse', 'HEAD');
    assert.equal(selectionInputs(root, base, head).focused, true);
    assert.equal(selectionInputs(root, undefined, head).focused, false);
    write(root, p, 'export const Control = () => <button onClick={pay}>Proceed</button>;');
    assert.equal(selectionInputs(root, base, head).focused, false);
    git('add', '.');
    git('commit', '-qm', 'handler');
    assert.equal(selectionInputs(root, base, head).focused, false);
    assert.equal(selectionInputs(root, base, git('rev-parse', 'HEAD')).focused, false);
  }));

test('source readers retain computed inputs and imported network helpers; omit only proved unrelated fixtures', () =>
  owned((root) => {
    write(
      root,
      'tests/e2e/fixture.spec.ts',
      "import fs from 'node:fs'; import path from 'node:path'; const css=fs.readFileSync(path.join(process.cwd(),'src/components/A.module.css'),'utf8');"
    );
    write(
      root,
      'tests/e2e/dynamic.spec.ts',
      "import {readFileSync} from 'node:fs'; readFileSync(input);"
    );
    write(root, 'tests/e2e/helper.ts', "export const load=()=>fetch('/bundle.css');");
    write(root, 'tests/e2e/network.spec.ts', "import {load} from './helper'; load();");
    assert.equal(consumedInputs(root, 'tests/e2e/fixture.spec.ts').unknown, false);
    write(
      root,
      'tests/e2e/mutable.spec.ts',
      "import {readFileSync} from 'node:fs';let file='src/A';file='src/B';readFileSync(file);"
    );
    write(
      root,
      'tests/e2e/shadow.spec.ts',
      "import {readFileSync} from 'node:fs';const file='src/A';function probe(file){readFileSync(file)}"
    );
    write(
      root,
      'tests/e2e/unproved-helper.spec.ts',
      "import {readFileSync} from 'node:fs';function join(){return 'src/B'}readFileSync(join('src/A'));"
    );
    for (const p of ['mutable', 'shadow', 'unproved-helper'])
      assert.equal(consumedInputs(root, `tests/e2e/${p}.spec.ts`).unknown, true);

    const specs = [
      'tests/e2e/fixture.spec.ts',
      'tests/e2e/dynamic.spec.ts',
      'tests/e2e/network.spec.ts',
    ];
    assert.deepEqual(browserSpecs(root, ['src/components/B.module.css'], specs), specs.slice(1));
    assert.deepEqual(browserSpecs(root, ['src/components/A.module.css'], specs), specs);
  }));

test('real locked Vitest runs related tests and source contracts, excludes unrelated tests and propagates failure', () =>
  owned((root) => {
    const git = (...a) =>
      execFileSync('git', a, { cwd: root, env: gitEnvironmentForCwd(), encoding: 'utf8' }).trim();
    git('init', '-q');
    git('config', 'user.name', 'Selection Test');
    git('config', 'user.email', 'selection@example.invalid');
    const p = 'src/components/example/Control.tsx';
    write(root, p, 'export const Control = () => <button>Continue</button>;');
    git('add', '.');
    git('commit', '-qm', 'base');
    const base = git('rev-parse', 'HEAD');
    write(root, p, 'export const Control = () => <button>Proceed</button>;');
    git('add', '.');
    git('commit', '-qm', 'copy');
    const head = git('rev-parse', 'HEAD');
    write(
      root,
      'vitest.config.mjs',
      "export default {test:{environment:'node',include:['tests/**/*.test.ts']}};"
    );
    write(
      root,
      'tests/contract.test.ts',
      "import {test,expect} from 'vitest';import {readFileSync} from 'node:fs';test('source contract',()=>expect(readFileSync('src/components/example/Control.tsx','utf8')).toContain('Proceed'));"
    );
    write(
      root,
      'tests/related.test.ts',
      "import {test,expect} from 'vitest';import {Control} from '../src/components/example/Control';test('related import',()=>expect(typeof Control).toBe('function'));"
    );
    write(
      root,
      'tests/unrelated.test.ts',
      "import {test} from 'vitest';test('unrelated must not execute',()=>{throw Error('unrelated executed')});"
    );
    // Dependencies belong to this task; this does not touch a shared installation.
    execFileSync('ln', ['-s', join(process.cwd(), 'node_modules'), join(root, 'node_modules')]);
    const command = [
      join(process.cwd(), 'scripts/ci/ui-test-selection.mjs'),
      'unit',
      '--reporter=verbose',
    ];
    const env = { ...process.env, CI_BASE_SHA: base, CI_HEAD_SHA: head, GITHUB_STEP_SUMMARY: '' };
    const output = execFileSync(process.execPath, command, {
      cwd: root,
      env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    assert.match(output, /source contract/);
    assert.match(output, /related import/);
    assert.doesNotMatch(output, /unrelated must not execute/);
    write(
      root,
      'tests/related.test.ts',
      "import {test,expect} from 'vitest';import {Control} from '../src/components/example/Control';test('related import fails',()=>expect(typeof Control).toBe('number'));"
    );
    assert.throws(() => execFileSync(process.execPath, command, { cwd: root, env, stdio: 'pipe' }));
  }));

test('real Playwright lists only the proved relevant fixture and never accepts an empty selection', () =>
  owned((root) => {
    const git = (...a) =>
      execFileSync('git', a, { cwd: root, env: gitEnvironmentForCwd(), encoding: 'utf8' }).trim();
    git('init', '-q');
    git('config', 'user.name', 'Selection Test');
    git('config', 'user.email', 'selection@example.invalid');
    const p = 'src/components/example/Control.module.css';
    write(root, p, '.button { color: red }');
    git('add', '.');
    git('commit', '-qm', 'base');
    const base = git('rev-parse', 'HEAD');
    write(root, p, '.button { color: blue }');
    git('add', '.');
    git('commit', '-qm', 'style');
    const head = git('rev-parse', 'HEAD');
    write(root, 'playwright.config.ts', "export default {testDir:'./tests/e2e'};");
    write(
      root,
      'tests/e2e/relevant.spec.ts',
      "import {test} from '@playwright/test';import {readFileSync} from 'node:fs';readFileSync('src/components/example/Control.module.css');test('relevant',()=>{});"
    );
    write(
      root,
      'tests/e2e/unrelated.spec.ts',
      "import {test} from '@playwright/test';test('unrelated',()=>{});"
    );
    execFileSync('ln', ['-s', join(process.cwd(), 'node_modules'), join(root, 'node_modules')]);
    const env = { ...process.env, CI_BASE_SHA: base, CI_HEAD_SHA: head, GITHUB_STEP_SUMMARY: '' };
    const command = [
      join(process.cwd(), 'scripts/ci/ui-test-selection.mjs'),
      'browser',
      'tests/e2e/relevant.spec.ts',
      'tests/e2e/unrelated.spec.ts',
      '--list',
      '--reporter=line',
    ];
    const output = execFileSync(process.execPath, command, {
      cwd: root,
      env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    assert.match(output, /relevant.spec.ts/);
    assert.doesNotMatch(output, /unrelated.spec.ts/);
    const fallback = execFileSync(
      process.execPath,
      [...command.slice(0, 2), 'tests/e2e/unrelated.spec.ts', '--list', '--reporter=line'],
      { cwd: root, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
    );
    assert.match(fallback, /unrelated.spec.ts/);
  }));
