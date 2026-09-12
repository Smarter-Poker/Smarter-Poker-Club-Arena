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
  return root;
}
function installFixture(root, name, metadata = { version: '1.0.0' }) {
  const dir = join(root, 'node_modules', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify(metadata));
}

test('Linux retains local enforcement even without a dependency installation', (t) => {
  assert.deepEqual(localDependencyPolicy(fixture(t), 'linux'), { mode: 'local', missing: [] });
});
test('a bare Mac checkout defers its required packages to CI', (t) => {
  assert.deepEqual(localDependencyPolicy(fixture(t), 'darwin'), {
    mode: 'ci',
    missing: ['@native/phone', 'typescript'],
  });
});
test('having the compiler does not conceal a missing phone package', (t) => {
  const root = fixture(t);
  installFixture(root, 'typescript');
  assert.deepEqual(localDependencyPolicy(root, 'darwin'), {
    mode: 'ci',
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
  assert.equal(localDependencyPolicy(root, 'darwin').mode, 'ci');
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
  assert.equal(localDependencyPolicy(root, 'darwin').mode, 'ci');
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
    process.platform === 'darwin' ? 'ci' : 'local'
  );
  assert.throws(() => execFileSync(process.execPath, [script, root, '--ci'], { stdio: 'pipe' }));
});
