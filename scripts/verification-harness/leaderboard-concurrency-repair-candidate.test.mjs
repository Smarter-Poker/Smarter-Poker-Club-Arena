// Source contracts only. Does not establish PostgreSQL concurrency behavior.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { buildConcurrencyRepairCandidate } from './leaderboard-concurrency-repair-candidate.mjs';
import { buildCompleteConcurrencyFixture } from './leaderboard-complete-concurrency-fixture-candidate.mjs';
import { buildUnknownAckRepairCandidate } from './leaderboard-unknown-ack-repair-candidate.mjs';
const read = (name) => readFileSync(new URL(`./${name}`, import.meta.url), 'utf8');
test('complete companion preserves original financial setup and prepares immutable captures before sole COMMIT', () => {
  const source = read('leaderboard-isolated-concurrency-fixture-draft.sql');
  const output = buildCompleteConcurrencyFixture();
  const start = output.indexOf('DO $complete_captures$');
  const end = output.indexOf('SET CONSTRAINTS ALL IMMEDIATE;', start);
  assert.ok(start > 0 && end > start);
  assert.equal(output.slice(0, start) + output.slice(end), source);
  assert.equal(output.match(/^COMMIT;$/gm)?.length, 1);
  assert.doesNotMatch(output, /DELETE FROM|DISABLE TRIGGER/);
  assert.throws(() => buildCompleteConcurrencyFixture(source + '\n'));
});
test('round-lock barrier requires actual funding and advisory waiters with exact blocking ownership', () => {
  const output = buildConcurrencyRepairCandidate();
  assert.ok(output.includes("wait_event='advisory'"));
  assert.ok(output.includes('f.pid=ANY(pg_blocking_pids(a.pid))'));
  assert.ok(output.includes('h.pid=ANY(pg_blocking_pids(a.pid))'));
  assert.ok(output.includes('if [[ "$count" == \'1|1\' ]]'));
  assert.ok(output.includes('(map(.already_settled) | sort) == [false,true]'));
  assert.ok(output.includes("basis_version='complete_capture_v2')<>2"));
  assert.doesNotMatch(output, /WITH RECURSIVE blocked AS|2ba8db49240eac826b2f3efe0e262648/);
  const baseline = read('leaderboard-isolated-concurrency-draft.sh');
  const boundary = (text) =>
    text.slice(
      text.indexOf('process_start() {'),
      text.indexOf('trap cleanup_children EXIT') + 'trap cleanup_children EXIT'.length
    );
  assert.equal(boundary(output), boundary(baseline));
  assert.ok(output.includes('readonly fixture="$scratch/repair-bootstrap.sql"'));
  assert.ok(output.includes('! -L "$fixture"'));
  assert.ok(output.includes('stat -c'));
  assert.doesNotMatch(
    output,
    /sed '\$d'|cat "\$scratch\/concurrency-authorization|node "\$here\/leaderboard-complete-concurrency|concurrency-candidate-fixture\.sql/
  );
});
test('both generated drivers parse and lint without executing a container', () => {
  for (const output of [buildConcurrencyRepairCandidate(), buildUnknownAckRepairCandidate()]) {
    assert.equal(spawnSync('bash', ['-n'], { input: output, encoding: 'utf8' }).status, 0);
    const lint = spawnSync('shellcheck', ['-s', 'bash', '-'], { input: output, encoding: 'utf8' });
    assert.equal(lint.status, 0, lint.stdout + lint.stderr);
  }
});
test('unknown actual COMMIT quarantine, durable journal readback, client ownership and same-identity retry preserved', () => {
  const output = buildUnknownAckRepairCandidate();
  const baseline = read('leaderboard-unknown-ack-draft.sh');
  const boundary = (text) =>
    text.slice(
      text.indexOf('cleanup_node_source() {'),
      text.indexOf('trap cleanup EXIT') + 'trap cleanup EXIT'.length
    );
  assert.equal(boundary(output), boundary(baseline));
  for (const marker of [
    'COMMIT_FORWARDED_ACK_QUARANTINED',
    'same_identity_retry',
    'await_owned "$client"',
    'sum(total_paid)',
    'count(DISTINCT correlation_id)',
    'leaderboard_round_basis_receipts',
  ])
    assert.ok(output.includes(marker));
  assert.throws(() => buildUnknownAckRepairCandidate(baseline + '\n'));
  assert.throws(() =>
    buildConcurrencyRepairCandidate(read('leaderboard-isolated-concurrency-draft.sh') + '\n')
  );
});

test('unknown-ack executable uses the reviewed glibc image and still checks actual target compatibility', () => {
  const baseline = read('leaderboard-unknown-ack-draft.sh');
  assert.ok(
    baseline.includes(
      'node@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392'
    )
  );
  assert.doesNotMatch(baseline, /0a7108bf6c7bf5de/);
  assert.ok(baseline.includes('"$isolated_node" --version'));
  assert.ok(
    baseline.indexOf('"$isolated_node" --version') <
      baseline.indexOf("diagnostic_stage='quarantine'")
  );
  for (const marker of [
    '--network none',
    'leaderboard.unknownack.owner=',
    'cleanup_node_source',
    'false|none',
  ])
    assert.ok(baseline.includes(marker));
});
