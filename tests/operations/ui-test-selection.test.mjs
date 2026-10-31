import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  configOnly,
  presentationOnly,
  runSelection,
  selectionInputs,
  consumedInputs,
  browserSpecs,
} from '../../scripts/ci/ui-test-selection.mjs';
import {
  classifyChangedPaths,
  cssBeatJobInputs,
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

test('chained browser inputs admit their paid regression without unrelated server jobs', () => {
  for (const path of [
    'tests/browser/rabbit-hunt-flow.spec.ts',
    'tests/browser/fixtures/rabbit-flow/main.tsx',
    'tests/browser/fixtures/rabbit-flow/index.html',
    'tests/browser/fixtures/rabbit-flow/assets/card.png',
    'tests/browser/fixtures/future-suite/index.html',
  ]) {
    assert.deepEqual(
      classifyChangedPaths([path]),
      {
        src: true,
        server: false,
        tests: true,
        phase4: false,
        fixture: false,
      },
      path
    );
  }
  for (const path of [
    'tests/browser/rabbit-hunt-flow.spec.ts.md',
    'tests/browser/fixtures/rabbit-flow/README.md',
    'tests/browser/unrelated.spec.ts',
    'tests/browser/fixture-other/index.html',
  ])
    assert.equal(classifyChangedPaths([path]).src, false, path);
});

const browserReaderFixture = (root) => {
  write(
    root,
    '.github/workflows/ci.yml',
    'jobs:\n  css-beats-e2e:\n    steps:\n      - run: npm run test:e2e:parent\n  verdict:\n'
  );
  const scripts = {
    'test:e2e:parent':
      'playwright test --config=playwright.parent.config.ts && npm run next-browser',
    'next-browser':
      'playwright test --config="playwright.future.config.ts" && playwright test --config=playwright.other.config.ts',
  };
  write(root, 'package.json', JSON.stringify({ scripts }));
  write(
    root,
    'playwright.parent.config.ts',
    "export default { testDir: './tests/e2e', testMatch: /tests\\/e2e\\/parent\\.spec\\.ts$/, };\n"
  );
  write(
    root,
    'playwright.future.config.ts',
    "export default { testDir: './tests/browser', testMatch: 'future-boundary.spec.ts', };\n"
  );
  write(
    root,
    'playwright.other.config.ts',
    'export default { testDir: "./tests/future-browser", testMatch: "another.spec.ts", };\n'
  );
  return scripts;
};

test('browser reader follows generic chained scripts and every literal config', () =>
  owned((root) => {
    browserReaderFixture(root);
    const input = cssBeatJobInputs(root);
    assert.equal(typeof input, 'function');
    for (const path of [
      'tests/e2e/parent.spec.ts',
      'tests/browser/future-boundary.spec.ts',
      'tests/browser/nested/future-boundary.spec.ts',
      'tests/future-browser/another.spec.ts',
      'tests/browser/fixtures/new-suite/assets/card.webp',
      'tests/future-browser/fixtures/new-suite/main.tsx',
      'playwright.future.config.ts',
    ])
      assert.equal(input(path), true, path);
    for (const path of [
      'tests/browser/unrelated.spec.ts',
      'tests/future-browser/unrelated.spec.ts',
      'tests/browser/fixtures/new-suite/README.md',
      'tests/browser/fixtures-other/main.tsx',
      'tests/other-fixtures/new-suite/main.tsx',
    ])
      assert.equal(input(path), false, path);
  }));

test('unknown browser chains decline proof and conservatively admit both browser families', () => {
  for (const fault of [
    'cycle',
    'missing-script',
    'missing-config',
    'unsafe-config',
    'unknown-match',
    'dynamic-script',
  ])
    owned((root) => {
      const scripts = browserReaderFixture(root);
      if (fault === 'cycle') scripts['next-browser'] = 'npm run test:e2e:parent';
      if (fault === 'missing-script') scripts['next-browser'] = 'npm run absent';
      if (fault === 'missing-config')
        scripts['next-browser'] = 'playwright test --config=playwright.absent.config.ts';
      if (fault === 'unsafe-config')
        scripts['next-browser'] = 'playwright test --config=../outside.config.ts';
      if (fault === 'dynamic-script') scripts['next-browser'] = 'npm run $BROWSER_SCRIPT';
      if (fault === 'unknown-match')
        write(
          root,
          'playwright.future.config.ts',
          "export default { testDir: './tests/browser', testMatch: computeMatch(), };\n"
        );
      write(root, 'package.json', JSON.stringify({ scripts }));
      assert.equal(cssBeatJobInputs(root), null, fault);
      // Import the actual classifier in this isolated layout to exercise its
      // caller's broad fallback, rather than duplicating the fallback in a test.
      write(
        root,
        'scripts/ci/classify-ci-changes.mjs',
        readFileSync(new URL('../../scripts/ci/classify-ci-changes.mjs', import.meta.url), 'utf8')
      );
      const output = execFileSync(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          `import { classifyChangedPaths as classify } from './scripts/ci/classify-ci-changes.mjs';
       console.log(JSON.stringify([
         'tests/browser/unknown.spec.ts', 'tests/e2e/unknown.spec.ts',
         'playwright.unknown.config.ts', 'tests/browser/fixtures/README.md',
         'tests/unit/unrelated.test.ts'
       ].map(path => classify([path]).src)));`,
        ],
        { cwd: root, encoding: 'utf8', env: gitEnvironmentForCwd() }
      );
      assert.deepEqual(JSON.parse(output), [true, true, true, false, false], fault);
    });
});

test('configuration proof focuses erased types and navigation copy, never runtime rules', () => {
  const path = 'src/config/cashGames.ts';
  const before = 'export type BombInterval = 9 | 15;\nexport const enabled = true;\n';
  assert.equal(configOnly(path, before, before.replace('9 | 15', '12 | 15')), true);
  for (const after of [
    before.replace('true', 'false'),
    before + 'pay();',
    before.replace('type BombInterval = 9 | 15', 'const enum BombInterval { Nine = 9 }'),
  ])
    assert.equal(configOnly(path, before, after), false);
  for (const p of [
    'src/services/cashGames.ts',
    'src/config/cashRakePolicy.ts',
    'src/config/bbjMini.ts',
    'tsconfig.json',
  ])
    assert.equal(configOnly(p, before, before.replace('9 | 15', '12 | 15')), false);
  const navigation =
    "export const items = [{label: 'Overview', path: '/home', description: 'Your activity'}];\n";
  const navPath = 'src/config/clubArenaNavigation.ts';
  assert.equal(configOnly(navPath, navigation, navigation.replace('Overview', 'Home')), true);
  assert.equal(
    configOnly(navPath, navigation, navigation.replace('Your activity', 'Recent activity')),
    true
  );
  for (const after of [
    navigation.replace('/home', '/wallet'),
    navigation.replace('Overview', 'Pay 50'),
    navigation + 'export const role = "owner";',
    navigation.replace('label:', '[label]:'),
  ])
    assert.equal(configOnly(navPath, navigation, after), false);
  assert.equal(
    configOnly('src/config/unknown.ts', navigation, navigation.replace('Overview', 'Home')),
    false
  );
  const enumBefore = 'export const enum Amount { Value = 9 }';
  assert.equal(configOnly(path, enumBefore, enumBefore.replace('9', '12')), false);
  assert.equal(classifyChangedPaths(['scripts/ci/ui-test-selection.mjs']).server, true);
});

test('immutable safe configuration focuses consumers but financial and unknown inputs remain full', () =>
  owned((root) => {
    const git = (...args) =>
      execFileSync('git', args, {
        cwd: root,
        env: gitEnvironmentForCwd(),
        encoding: 'utf8',
      }).trim();
    git('init', '-q');
    git('config', 'user.name', 'Selection Test');
    git('config', 'user.email', 'selection@example.invalid');
    const p = 'src/config/cashGames.ts';
    const other = 'src/config/runtime.ts';
    write(root, other, 'export const amount = 10;\n');
    write(root, p, 'export type Interval = 9 | 15;\nexport const enabled = true;\n');
    git('add', '.');
    git('commit', '-qm', 'base');
    const base = git('rev-parse', 'HEAD');
    write(root, p, 'export type Interval = 12 | 15;\nexport const enabled = true;\n');
    git('add', '.');
    git('commit', '-qm', 'type configuration');
    const head = git('rev-parse', 'HEAD');
    const proof = selectionInputs(root, base, head);
    assert.equal(proof.focused, true);
    assert.deepEqual(proof.changed, [p]);
    write(root, other, 'export const amount = 20;\n');
    assert.equal(selectionInputs(root, base, head).focused, false);
    git('add', other);
    assert.equal(selectionInputs(root, base, head).focused, false);
    write(root, other, 'export const amount = 10;\n');
    git('add', other);
    assert.equal(selectionInputs(root, base, head).focused, true);
    write(root, 'src/config/untracked.ts', 'export const amount = 20;\n');
    assert.equal(selectionInputs(root, base, head).focused, false);
    rmSync(join(root, 'src/config/untracked.ts'));
    const output = join(root, 'compiler-scope');
    runSelection(root, ['scope'], {
      ...process.env,
      CI_BASE_SHA: base,
      CI_HEAD_SHA: head,
      GITHUB_OUTPUT: output,
    });
    assert.match(readFileSync(output, 'utf8'), /presentation_only=true/);
    const note = 'docs/changelog/2026-10-29-config-example.md';
    write(root, note, '# Type configuration\n');
    git('add', note);
    git('commit', '-qm', 'required changelog companion');
    const documented = git('rev-parse', 'HEAD');
    assert.equal(selectionInputs(root, base, documented).focused, true);
    assert.deepEqual(selectionInputs(root, base, documented).changed, [note, p]);
    assert.equal(selectionInputs(root, head, documented).focused, false);
    write(root, p, 'export type Interval = 12 | 15;\nexport const enabled = false;\n');
    assert.equal(selectionInputs(root, base, documented).focused, false);
    git('add', p);
    git('commit', '-qm', 'runtime configuration');
    assert.equal(selectionInputs(root, base, git('rev-parse', 'HEAD')).focused, false);
    write(root, p, 'export type Interval = 12 | 15;\nexport const enabled = true;\n');
    write(root, 'supabase/migrations/financial.sql', 'BEGIN; COMMIT;');
    git('add', '.');
    git('commit', '-qm', 'mixed database input');
    assert.equal(selectionInputs(root, base, git('rev-parse', 'HEAD')).focused, false);
  }));

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
    write(root, '.gitignore', '**/ignored-local.*\n');
    git('add', '.');
    git('commit', '-qm', 'base');
    const base = git('rev-parse', 'HEAD');
    write(root, p, 'export const Control = () => <button>Proceed</button>;');
    git('add', '.');
    git('commit', '-qm', 'copy');
    const head = git('rev-parse', 'HEAD');
    assert.equal(selectionInputs(root, base, head).focused, true);
    for (const file of [
      'public/assets/untracked.png',
      'docs/art/untracked-baseline.json',
      'public/assets/ignored-local.png',
      'docs/art/ignored-local.json',
    ]) {
      write(root, file, 'local detector input');
      if (file.includes('ignored-local')) {
        assert.equal(git('check-ignore', '--', file), file);
        assert.equal(git('ls-files', '--others', '--exclude-standard', '--', file), '');
      }
      const proof = selectionInputs(root, base, head);
      assert.equal(proof.focused, false, file);
      assert.equal(proof.reason, 'Untracked asset or art baseline input', file);
      rmSync(join(root, file));
      assert.equal(selectionInputs(root, base, head).focused, true, file);
    }
    const output = join(root, 'scope-output');
    runSelection(root, ['scope'], {
      ...process.env,
      CI_BASE_SHA: base,
      CI_HEAD_SHA: head,
      GITHUB_OUTPUT: output,
      GITHUB_STEP_SUMMARY: '',
    });
    assert.equal(readFileSync(output, 'utf8'), 'presentation_only=true\n');
    runSelection(root, ['scope'], {
      ...process.env,
      CI_BASE_SHA: '',
      CI_HEAD_SHA: head,
      GITHUB_OUTPUT: output,
      GITHUB_STEP_SUMMARY: '',
    });
    assert.ok(readFileSync(output, 'utf8').endsWith('presentation_only=false\n'));
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
    write(
      root,
      'tests/e2e/a.ts',
      "import './b';import {readFileSync} from 'node:fs';readFileSync('src/components/A.module.css');"
    );
    write(root, 'tests/e2e/b.ts', "import './a';");
    const cache = new Map();
    consumedInputs(root, 'tests/e2e/a.ts', new Set(), cache);
    assert.ok(
      consumedInputs(root, 'tests/e2e/b.ts', new Set(), cache).paths.includes(
        'src/components/A.module.css'
      )
    );
  }));

test('data indexing is not an unknown read, while filesystem aliases and shadowed inputs remain unknown', () =>
  owned((root) => {
    write(
      root,
      'tests/data.test.ts',
      "import {readFileSync} from 'node:fs'; const source=readFileSync('src/Other.ts','utf8'); const [first]=source.split(''); const {length}=source; first[0];"
    );
    assert.equal(consumedInputs(root, 'tests/data.test.ts').unknown, false);
    assert.ok(consumedInputs(root, 'tests/data.test.ts').paths.includes('src/Other.ts'));
    write(
      root,
      'tests/wrapper.test.ts',
      "import {readFileSync} from 'node:fs';import {dirname,resolve} from 'node:path';import {fileURLToPath} from 'node:url';const ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'..');const read=(p:string)=>readFileSync(resolve(ROOT,p),'utf8');read('src/Other.ts');"
    );
    assert.equal(consumedInputs(root, 'tests/wrapper.test.ts').unknown, false);
    assert.ok(consumedInputs(root, 'tests/wrapper.test.ts').paths.includes('src/Other.ts'));
    for (const [name, source] of Object.entries({
      namespace: "import * as fs from 'node:fs';const {readFileSync}=fs;readFileSync('src/A');",
      alias: "import {readFileSync} from 'node:fs';const reader=readFileSync;reader('src/A');",
      computed: "import * as fs from 'node:fs';fs['readFileSync']('src/A');",
      shadow:
        "import {readFileSync} from 'node:fs';const file='src/A';function probe({file}){readFileSync(file)}",
      wrapperNestedRead:
        "import {readFileSync} from 'node:fs';const read=(p:string)=>readFileSync(p,(readFileSync(input),'utf8'));read('src/Other.ts');",
      wrapperComputed:
        "import {readFileSync} from 'node:fs';const read=(p:string)=>readFileSync(p,'utf8');read(input);",
      wrapperEscape:
        "import {readFileSync} from 'node:fs';const read=(p:string)=>readFileSync(p,'utf8');consume(read);",
      wrapperShadow:
        "import {readFileSync} from 'node:fs';const read=(p:string)=>readFileSync(p,'utf8');function probe(read){read('src/Other.ts')}",
    })) {
      const path = `tests/${name}.test.ts`;
      write(root, path, source);
      assert.equal(consumedInputs(root, path).unknown, true, name);
    }
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
      "import {test} from 'vitest';const [first]=['data'];const {length}=first;first[0];test('unrelated must not execute',()=>{throw Error('unrelated executed')});"
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
