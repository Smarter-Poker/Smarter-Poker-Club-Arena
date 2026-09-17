import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { lintBase } from '../../scripts/ci/precommit-lint-base.mjs';

function fixture(run) {
  const dir = mkdtempSync(join(tmpdir(), 'commit-scope-'));
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const file = (name, value) => writeFileSync(join(dir, name), value);
  try {
    git('init', '-q', '-b', 'main'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
    file('common.md', 'base\n'); git('add', '.'); git('commit', '-qm', 'base'); git('branch', 'feature');
    file('evidence.json', '{"retained":true}\n'); git('add', '.'); git('commit', '-qm', 'upstream');
    const main = git('rev-parse', 'HEAD'); git('update-ref', 'refs/remotes/origin/main', main); git('switch', '-q', 'feature');
    file('own.md', 'owned\n'); git('add', '.'); git('commit', '-qm', 'own');
    run({ dir, git, file, main });
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('ordinary commits retain staged lint selection', () => fixture(({ dir }) => assert.equal(lintBase(dir), null)));
test('protected-main integration lints candidate differences without rewriting inherited evidence', () => fixture(({ dir, git, file, main }) => {
  git('merge', '--no-commit', '--no-ff', main);
  file('common.md', 'resolved candidate\n'); git('add', 'common.md');
  const base = lintBase(dir); assert.equal(base, main);
  const selected = git('diff', '--name-only', base).split('\n');
  assert.deepEqual(selected, ['common.md', 'own.md']);
  assert.equal(readFileSync(join(dir, 'evidence.json'), 'utf8'), '{"retained":true}\n');
}));
test('an unprotected incoming branch keeps the normal lint scope', () => fixture(({ dir, git, main }) => {
  git('update-ref', 'refs/remotes/origin/main', `${main}^`);
  git('merge', '--no-commit', '--no-ff', main); assert.equal(lintBase(dir), null);
}));
test('partly staged merge refuses instead of silently committing unreviewed bytes', () => fixture(({ dir, git, file, main }) => {
  git('merge', '--no-commit', '--no-ff', main); file('common.md', 'not staged\n');
  assert.throws(() => lintBase(dir), /unstaged tracked changes/);
}));
test('pre-commit invokes the selector and preserves all existing guard calls', () => {
  const hook = readFileSync(new URL('../../.husky/pre-commit', import.meta.url), 'utf8');
  assert.match(hook, /LINT_BASE="\$\(node scripts\/ci\/precommit-lint-base\.mjs\)"/);
  assert.match(hook, /"\$LS" --diff "\$LINT_BASE"/);
  for (const guard of ['check-canonical-clone', 'guard-shared-clone', 'guard-commit-identity', 'guard-mass-deletion']) assert.ok(hook.includes(`${guard}.sh`));
});
