import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  verifyOriginalFeatureArtifact,
  authenticateFeatureArtifacts,
} from '../../server/scripts/feature-ablation-artifact-custody.mjs';
test('original archive permits exact files and refuses changed bytes or foreign members', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'feature-custody-'));
  try {
    const original = join(dir, 'original'),
      local = join(dir, 'local');
    mkdirSync(original);
    mkdirSync(local);
    for (const d of [original, local]) {
      writeFileSync(join(d, 'attempt.json'), '{}\n');
      writeFileSync(join(d, 'raw-pairs.jsonl.gz'), 'original synthetic bytes');
    }
    const zip = join(dir, 'original.zip');
    execFileSync('zip', ['-q', zip, 'attempt.json', 'raw-pairs.jsonl.gz'], { cwd: original });
    await verifyOriginalFeatureArtifact(zip, local);
    writeFileSync(join(local, 'raw-pairs.jsonl.gz'), 'substituted scientific bytes');
    await assert.rejects(verifyOriginalFeatureArtifact(zip, local), /original_bytes_changed/);
    writeFileSync(join(local, 'foreign.json'), '{}');
    await assert.rejects(verifyOriginalFeatureArtifact(zip, local), /members_changed/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('artifact inventory follows transferred repository and requires its immutable workflow identity', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'feature-provider-'));
  const prior = process.env;
  process.env = {
    ...prior,
    GITHUB_REPOSITORY: 'Smarter-Software-PIQ/Smarter-Poker-Club-Arena',
    GITHUB_REPOSITORY_ID: '1132369872',
    GITHUB_TOKEN: 'structural-fixture-not-a-credential',
    RUNNER_TEMP: directory,
  };
  const urls = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    urls.push(url);
    return { ok: true, json: async () => ({ artifacts: [] }) };
  });
  try {
    await authenticateFeatureArtifacts(directory, 'combo_draw_pressure', '123');
    assert.deepEqual(urls, [
      'https://api.github.com/repos/Smarter-Software-PIQ/Smarter-Poker-Club-Arena/actions/runs/123/artifacts?per_page=100&page=1',
    ]);
    for (const id of [undefined, '', '1132369873']) {
      if (id === undefined) delete process.env.GITHUB_REPOSITORY_ID;
      else process.env.GITHUB_REPOSITORY_ID = id;
      await assert.rejects(
        authenticateFeatureArtifacts(directory, 'combo_draw_pressure', '123'),
        /artifact_provider_unavailable/
      );
      assert.equal(urls.length, 1);
    }
    process.env.GITHUB_REPOSITORY_ID = '1132369872';
    for (const repository of [
      'Smarter-Poker/Smarter-Poker-Club-Arena',
      'foreign/Smarter-Poker-Club-Arena',
    ]) {
      process.env.GITHUB_REPOSITORY = repository;
      await assert.rejects(
        authenticateFeatureArtifacts(directory, 'combo_draw_pressure', '123'),
        /artifact_provider_unavailable/
      );
      assert.equal(urls.length, 1);
    }
  } finally {
    process.env = prior;
    rmSync(directory, { recursive: true, force: true });
  }
});
