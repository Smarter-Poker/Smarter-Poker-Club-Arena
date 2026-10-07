// Source assembly contracts only. Actual isolated migration qualification is required.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  assembleConsolidatedCandidate,
  loadReviewedInputs,
  disposableGuards,
  reviewedInputs,
  reviewedOutputHash,
} from './leaderboard-consolidated-migration-candidate.mjs';
const inputs = loadReviewedInputs();
const digest = (value) => createHash('sha256').update(value).digest('hex');
test('exact five input pins yield one deterministic output pin and ordered unchanged chunks', () => {
  assert.deepEqual(inputs.map(digest), [...reviewedInputs]);
  const output = assembleConsolidatedCandidate(inputs);
  assert.equal(digest(output), reviewedOutputHash);
  assert.equal(output, assembleConsolidatedCandidate(loadReviewedInputs()));
  let cursor = output.indexOf('BEGIN;\n') + 'BEGIN;\n'.length;
  for (let index = 0; index < inputs.length; index += 1) {
    let chunk = inputs[index].replace('\nBEGIN;\n', '\n').slice(0, -'COMMIT;\n'.length);
    if (index !== 0) chunk = chunk.replace(disposableGuards[index], '');
    const next = output.indexOf(chunk, cursor);
    assert.ok(next >= cursor, `Exact section ${index} absent/out of order`);
    cursor = next + chunk.length;
  }
  assert.equal(output.match(/^BEGIN;$/gm)?.length, 1);
  assert.equal(output.match(/^COMMIT;$/gm)?.length, 1);
});
test('only four disposable guard blocks removed; predecessor/security/DDL and history contracts preserved', () => {
  const output = assembleConsolidatedCandidate(inputs);
  assert.equal(
    inputs.filter((value) => value.includes('Disposable bootstrap socket required')).length,
    4
  );
  assert.doesNotMatch(
    output,
    /leaderboard_qualification_bootstrap|Disposable bootstrap socket required/
  );
  assert.match(output, /current_user <> 'postgres'/);
  for (const chunk of inputs) {
    for (const guard of chunk.matchAll(/AND md5\(p\.prosrc\)='[a-f0-9]+'/g))
      assert.ok(output.includes(guard[0]));
    for (const signature of chunk.matchAll(/CREATE (?:OR REPLACE )?FUNCTION public\.[^\n]+/g))
      assert.ok(output.includes(signature[0]));
  }
  assert.match(output, /ENABLE ROW LEVEL SECURITY/);
  assert.match(output, /REVOKE ALL ON public\.leaderboard_complete_captures/);
  assert.match(output, /GRANT EXECUTE ON FUNCTION public\.fn_leaderboard_complete_round_basis/);
  assert.doesNotMatch(
    output,
    /PERFORM public\.fn_snapshot_player_stats\(\)|SELECT public\.fn_snapshot_player_stats\(\)|cron\.schedule|DISABLE TRIGGER/
  );
});
test('drift, missing/duplicated boundaries, disposable guard mutation and reordered inputs refuse', () => {
  for (const change of [
    (values) => values.pop(),
    (values) => values.reverse(),
    (values) => {
      values[0] += '\n';
    },
    (values) => {
      values[1] = values[1].replace('BEGIN;\n', '');
    },
    (values) => {
      values[2] = values[2].replace('COMMIT;\n', 'COMMIT;\nCOMMIT;\n');
    },
    (values) => {
      values[3] = values[3].replace(disposableGuards[3], '');
    },
    (values) => {
      values[4] = values[4].replace('current_user <> session_user', 'current_user = session_user');
    },
  ]) {
    const altered = [...inputs];
    change(altered);
    assert.throws(() => assembleConsolidatedCandidate(altered));
  }
});
test('actual CLI emits only exact assembled SQL and refuses additional arguments', () => {
  const path = fileURLToPath(
    new URL('./leaderboard-consolidated-migration-candidate.mjs', import.meta.url)
  );
  const result = spawnSync(process.execPath, [path], { encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout, assembleConsolidatedCandidate(inputs));
  const refused = spawnSync(process.execPath, [path, 'unexpected'], { encoding: 'utf8' });
  assert.equal(refused.status, 1);
  assert.equal(refused.stdout, '');
  assert.equal(
    refused.stderr,
    'Consolidated candidate refused: reviewed source or boundary changed\n'
  );
});
