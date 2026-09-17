// Run merge-scope regressions in the existing required CI dependency-policy step.
import './precommit-lint-base.test.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  symlinkSync,
  lstatSync,
  rmSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { localDependencyPolicy } from '../../scripts/local-dependency-policy.mjs';

function fixture(
  t,
  manifest = {
    dependencies: { '@native/phone': '^1.0.0' },
    devDependencies: { typescript: '^5.0.0' },
  }
) {
  const root = mkdtempSync(join(tmpdir(), 'ca-local-package-policy-'));
  t.after(() => rmSync(root, { recursive: true }));
  writeFileSync(join(root, 'package.json'), JSON.stringify(manifest));
  writeFileSync(
    join(root, 'package-lock.json'),
    JSON.stringify({
      lockfileVersion: 3,
      packages: {
        '': manifest,
        ...Object.fromEntries(
          Object.keys({ ...manifest.dependencies, ...manifest.devDependencies }).map((name) => [
            `node_modules/${name}`,
            { version: '1.0.0' },
          ])
        ),
      },
    })
  );
  return root;
}
function installFixture(root, name, metadata = { version: '1.0.0' }) {
  const dir = join(root, 'node_modules', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify(metadata));
}

test('Linux refuses the same missing dependencies as Mac', (t) => {
  assert.deepEqual(localDependencyPolicy(fixture(t), 'linux'), {
    mode: 'blocked',
    missing: ['@native/phone', 'typescript'],
  });
});
test('a bare Mac checkout blocks applicable local checks', (t) => {
  assert.deepEqual(localDependencyPolicy(fixture(t), 'darwin'), {
    mode: 'blocked',
    missing: ['@native/phone', 'typescript'],
  });
});
test('having the compiler does not conceal a missing phone package', (t) => {
  const root = fixture(t);
  installFixture(root, 'typescript');
  assert.deepEqual(localDependencyPolicy(root, 'darwin'), {
    mode: 'blocked',
    missing: ['@native/phone'],
  });
});
test('complete declared packages retain local Mac checks', (t) => {
  const root = fixture(t);
  installFixture(root, 'typescript');
  installFixture(root, '@native/phone');
  assert.equal(localDependencyPolicy(root, 'darwin').mode, 'local');
});
test('a gutted package is not mistaken for an installed dependency', (t) => {
  const root = fixture(t);
  installFixture(root, 'typescript', {});
  installFixture(root, '@native/phone');
  assert.deepEqual(localDependencyPolicy(root, 'darwin').missing, ['typescript']);
});
test('a damaged installed manifest is diagnosed without repairing it', (t) => {
  const root = fixture(t);
  installFixture(root, 'typescript');
  const path = join(root, 'node_modules/typescript/package.json');
  writeFileSync(path, '{');
  assert.equal(localDependencyPolicy(root, 'darwin').mode, 'blocked');
  assert.equal(readFileSync(path, 'utf8'), '{');
});
test('platform optional packages do not disable otherwise complete checks', (t) => {
  const root = fixture(t, {
    dependencies: { typescript: '*', optional: '*' },
    optionalDependencies: { optional: '*' },
  });
  installFixture(root, 'typescript');
  assert.equal(localDependencyPolicy(root, 'darwin').mode, 'local');
});
test('unreadable source manifest refuses instead of claiming a CI handoff', (t) => {
  const root = fixture(t);
  writeFileSync(join(root, 'package.json'), '{');
  assert.throws(() => localDependencyPolicy(root, 'darwin'), SyntaxError);
});
test('a shared link and its package bytes stay untouched', (t) => {
  const root = fixture(t);
  const shared = fixture(t);
  installFixture(shared, 'typescript');
  symlinkSync(join(shared, 'node_modules'), join(root, 'node_modules'));
  const before = readFileSync(join(shared, 'node_modules/typescript/package.json'));
  assert.equal(localDependencyPolicy(root, 'darwin').mode, 'blocked');
  assert.ok(lstatSync(join(root, 'node_modules')).isSymbolicLink());
  assert.deepEqual(readFileSync(join(shared, 'node_modules/typescript/package.json')), before);
});
test('the executable accepts only the package root, with no platform bypass flag', (t) => {
  const root = fixture(t);
  const script = fileURLToPath(
    new URL('../../scripts/local-dependency-policy.mjs', import.meta.url)
  );
  assert.equal(
    execFileSync(process.execPath, [script, root], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim(),
    'blocked'
  );
  assert.throws(() => execFileSync(process.execPath, [script, root, '--ci'], { stdio: 'pipe' }));
});

test('an installed but unlocked version blocks local qualification', (t) => {
  const root = fixture(t);
  installFixture(root, 'typescript', { version: '2.0.0' });
  installFixture(root, '@native/phone');
  assert.deepEqual(localDependencyPolicy(root), { mode: 'blocked', missing: ['typescript'] });
});
test('a changed manifest cannot qualify against an old lockfile', (t) => {
  const root = fixture(t);
  installFixture(root, 'typescript');
  installFixture(root, '@native/phone');
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  manifest.devDependencies.typescript = '^6.0.0';
  writeFileSync(join(root, 'package.json'), JSON.stringify(manifest));
  assert.deepEqual(localDependencyPolicy(root).missing, ['typescript']);
});
test('missing or malformed lockfile never claims local qualification', (t) => {
  const root = fixture(t);
  rmSync(join(root, 'package-lock.json'));
  assert.throws(() => localDependencyPolicy(root), /ENOENT/);
  writeFileSync(join(root, 'package-lock.json'), '{}');
  assert.throws(() => localDependencyPolicy(root), /complete npm lockfile/);
});
