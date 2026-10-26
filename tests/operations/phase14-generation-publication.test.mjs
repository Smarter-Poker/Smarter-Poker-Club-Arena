import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  PHASE14_GENERATION_DOMAINS,
  PHASE14_GENERATION_LEDGER_SCHEMA,
  PHASE14_GENERATION_LEDGER_PATH,
} from '../../server/src/services/horseCorrectiveReview/kernelGenerationLedgerRules.mjs';
const script = fileURLToPath(
  new URL('../../scripts/ci/check-phase14-generation-ledger.mjs', import.meta.url)
);
const env = Object.fromEntries(
  ['PATH', 'HOME', 'TMPDIR', 'LANG', 'TZ']
    .filter((k) => process.env[k])
    .map((k) => [k, process.env[k]])
);
const data = (floor = 0, retired = []) => ({
  schema: PHASE14_GENERATION_LEDGER_SCHEMA,
  domains: Object.fromEntries(
    PHASE14_GENERATION_DOMAINS.map((domain) => [
      domain,
      {
        highestPublishedGeneration: domain === 'nlh-cash' ? floor : 0,
        authorityDigest: domain === 'nlh-cash' && floor ? 'a'.repeat(64) : null,
        retiredGenerations: domain === 'nlh-cash' ? retired : [],
      },
    ])
  ),
});
function fixture() {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'phase14-publication-'));
  const git = (args) =>
    execFileSync('git', ['-C', root, ...args], {
      encoding: 'utf8',
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  git(['init', '-q']);
  writeFileSync(join(root, 'README'), 'unit fixture');
  const commit = () => {
    git(['add', '.']);
    git([
      '-c',
      'user.name=Qualification Test',
      '-c',
      'user.email=qualification@example.invalid',
      'commit',
      '-qm',
      'fixture',
    ]);
    return git(['rev-parse', 'HEAD']);
  };
  const save = (value) => {
    for (const prefix of ['', 'server/release-evidence/']) {
      const path = join(root, prefix, PHASE14_GENERATION_LEDGER_PATH);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify(value) + '\n');
    }
  };
  const run = (base) =>
    spawnSync(process.execPath, [script, base], { cwd: root, env, encoding: 'utf8' }).status;
  return { root, git, commit, save, run };
}
test('publication admits only zero bootstrap then monotonic floors and preserved tombstones', () => {
  const f = fixture();
  try {
    const base = f.commit();
    f.save(data());
    assert.equal(f.run(base), 0);
    f.save(data(3, [1, 2]));
    const published = f.commit();
    f.save(data(3, [1, 2]));
    assert.equal(f.run(published), 0);
    f.save(data(2, [1]));
    assert.equal(f.run(published), 1);
    f.save(data(3, [1]));
    assert.equal(f.run(published), 1);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});
test('unknown base and deletion of an established ledger never masquerade as first bootstrap', () => {
  const f = fixture();
  try {
    f.save(data());
    f.commit();
    for (const prefix of ['', 'server/release-evidence/'])
      rmSync(join(f.root, prefix, PHASE14_GENERATION_LEDGER_PATH));
    const deleted = f.commit();
    f.save(data());
    assert.equal(f.run(deleted), 1);
    assert.equal(f.run('0'.repeat(40)), 1);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});
