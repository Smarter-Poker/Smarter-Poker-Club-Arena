import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { verifyOriginalFeatureArtifact } from '../../server/scripts/feature-ablation-artifact-custody.mjs';
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
