// Source contracts only. Does not establish PostgreSQL concurrency behavior.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
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

test('proxy admits exactly the actual complete payout statement in both maintained drivers', () => {
  const proxy = read('leaderboard-unknown-ack-proxy-draft.mjs');
  const expected = proxy.match(/const payoutSHA256 = '([0-9a-f]{64})';/)[1];
  for (const driver of [
    read('leaderboard-unknown-ack-draft.sh'),
    buildUnknownAckRepairCandidate(),
  ]) {
    assert.equal(driver.split('DO $ack_payout$').length, 2);
    assert.equal(driver.split('$ack_payout$;').length, 2);
    const query = driver
      .slice(
        driver.indexOf('DO $ack_payout$'),
        driver.indexOf('$ack_payout$;') + '$ack_payout$;'.length
      )
      .trim();
    const digest = (value) => createHash('sha256').update(value).digest('hex');
    assert.equal(digest(query), expected);
    assert.notEqual(
      digest(
        query.replace(
          '90000000-0000-4000-8000-000000000001',
          '90000000-0000-4000-8000-000000000002'
        )
      ),
      expected
    );
  }
  assert.match(proxy, /update\(query\)\.digest\('hex'\) !== payoutSHA256/);
});

// Actual recipient writer leaves nullable journal pre/post fields unset.
test('unknown-ack recipient oracle reconciles actual wallet movement and exact journal identities', () => {
  const source = read('leaderboard-unknown-ack-draft.sh');
  const guard = source.split('DO $guard$')[1].split('$guard$;')[0];
  const durable = source.split('DO $durable$')[1].split('$durable$;')[0];
  assert.doesNotMatch(durable, /pre_to_balance|post_to_balance/);
  assert.match(
    guard,
    /fn_player_home_club\('90000000-0000-4000-8000-000000000004',NULL\) IS DISTINCT FROM '92000000-0000-4000-8000-000000000002'::uuid/
  );
  assert.match(
    guard,
    /EXISTS\(SELECT 1 FROM public\.club_members WHERE chip_balance IS DISTINCT FROM 0\)/
  );
  assert.match(
    durable,
    /NOT\(club_id=club AND user_id=winner\) AND chip_balance IS DISTINCT FROM 0/
  );
  assert.match(guard, /sum\(chip_balance\)[^\n]*IS DISTINCT FROM 0/);
  assert.match(guard, /user_id='90000000-0000-4000-8000-000000000004'\) IS DISTINCT FROM 0/);
  assert.match(durable, /sum\(chip_balance\)[^\n]*IS DISTINCT FROM 10/);
  assert.match(durable, /club_id=club AND user_id=winner\) IS DISTINCT FROM 10/);
  assert.match(
    durable,
    /count\(\*\) FROM public\.chip_ledger WHERE category='leaderboard_payout'\)<>2/
  );
  assert.match(durable, /count\(DISTINCT correlation_id\)/);
  assert.match(
    durable,
    /from_type='promo_wallet' AND from_entity_id=club AND to_type='leaderboard_round' AND to_entity_id=club\s+AND club_id=club AND amount=10 AND pre_from_balance=20 AND post_from_balance=10/
  );
  assert.match(
    durable,
    /from_type='leaderboard_round' AND from_entity_id=club AND to_type='player_wallet' AND to_entity_id=winner\s+AND club_id=club AND amount=10/
  );
  assert.match(
    durable,
    /WHERE key=format\('leaderboard:%s:weekly:%s:%s',club,starts,winner\) AND user_id=winner AND amount=10/
  );
  assert.match(
    durable,
    /related_entity_id=program\s+AND category='leaderboard_payout' AND user_id=winner AND amount=10 AND type='credit'/
  );
  assert.match(durable, /sum\(amount\)[^\n]*to_type='leaderboard_round'\) IS DISTINCT FROM 10/);
  assert.match(durable, /sum\(amount\)[^\n]*from_type='leaderboard_round'\) IS DISTINCT FROM 10/);
});
