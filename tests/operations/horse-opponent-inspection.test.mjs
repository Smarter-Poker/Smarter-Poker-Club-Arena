import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  validateSelection,
  summarizeDecision,
  sanitizeInspectionFailure,
} from '../../scripts/ci/inspect-horse-opponent-reads.mjs';
const id = '11111111-1111-4111-8111-111111111111';
const selection = { sourceSha: 'a'.repeat(40), opponentId: id, handKeys: ['b'.repeat(64)] };
test('accepts only a finite closed data selection, with no command or path overrides', () => {
  assert.deepEqual(validateSelection(selection), selection);
  for (const p of [
    { ...selection, command: 'whoami' },
    { ...selection, handKeys: [] },
    { ...selection, handKeys: Array(17).fill('a'.repeat(64)) },
    { ...selection, opponentId: 'x;env' },
    { ...selection, sourceSha: 'main' },
    { ...selection, handKeys: ['../private'] },
  ])
    assert.throws(() => validateSelection(p));
});
test('emits only selected public counters and scalar execution receipts, never private cards or raw frames', () => {
  const secret = 'NEVER_EXPORT_THIS';
  const capture = {
    snapshot: {
      type: 'DECIDE_FAST',
      player: { user_id: id, cards: [secret] },
      gameState: { players: [{ user_id: id, cards: [secret] }], stage: 'preflop' },
      decisionTimeMs: 10,
    },
    decision: { action: 'raise', cards: [secret] },
    observerReads: {
      history: 'own_public_window',
      historyHands: 12,
      learnedThroughMs: 9,
      private: secret,
    },
    readFrame: { json: secret },
  };
  const view = {
    stats: new Map([[id, { hands: 12, vpip: 10, pfr: 8, threeBet: 3, private: secret }]]),
  };
  const execution = {
    executionStatus: 'intended',
    executedAction: 'raise',
    phase11Authority: {
      mode: 'candidate',
      selection: 'candidate',
      verdict: 'usable',
      private: secret,
    },
    private: secret,
  };
  const result = summarizeDecision(
    { handKey: 'b'.repeat(64), sourceRelease: 'a'.repeat(40) },
    capture,
    view,
    id,
    true,
    execution
  );
  assert.equal(result.opponent.hands, 12);
  assert.equal(result.execution.phase11.mode, 'candidate');
  assert.equal(result.independent, true);
  assert.ok(!JSON.stringify(result).includes(secret));
  assert.equal(
    summarizeDecision({}, capture, view, '22222222-2222-4222-8222-222222222222', true),
    null
  );
});
test('runs only from an explicit default-branch dispatch, through pinned provider SSH, without a release route', () => {
  const y = readFileSync(
    new URL('../../.github/workflows/inspect-horse-opponent-reads.yml', import.meta.url),
    'utf8'
  );
  assert.match(y, /workflow_dispatch:/);
  assert.match(y, /github.event_name == 'workflow_dispatch'/);
  assert.match(y, /StrictHostKeyChecking=yes/);
  assert.match(y, /secrets.HETZNER_HOST_KEY/);
  assert.match(y, /flock -n 9/);
  assert.match(y, /docker exec -i/);
  assert.doesNotMatch(y, /schedule:|repository_dispatch:|docker restart|auto-deploy/);
});
test('remote guards explain refusal and never reach journal execution after a failed guard', () => {
  const y = readFileSync(
    new URL('../../.github/workflows/inspect-horse-opponent-reads.yml', import.meta.url),
    'utf8'
  );
  const line = y.split('\n').find((line) => line.trim().startsWith('"test -f '));
  assert.ok(line);
  const command = line
    .trim()
    .slice(1, -3)
    .replaceAll('\\"', '"')
    .replaceAll('\\$', '$')
    .replaceAll('/var/lock/club-arena-engine-up.lock', '/dev/null')
    .replaceAll('$EXPECTED_ENGINE_SHA', selection.sourceSha)
    .replaceAll('$SELECTION_BASE64', 'selection');
  for (const [failure, expected] of [
    ['missing', 'inspection_lock_missing'],
    ['busy', 'inspection_lock_busy'],
    ['image', 'inspection_image_mismatch'],
    ['none', 'journal_reached'],
  ]) {
    const script = `test() { if [ "$1" = -f ]; then [ "$FAILURE" != missing ]; else builtin test "$@"; fi; }
flock() { [ "$FAILURE" != busy ]; }
docker() { if [ "$1" = inspect ]; then if [ "$FAILURE" = image ]; then echo wrong; else echo ${selection.sourceSha}; fi; else echo journal_reached; fi; }
${command}`;
    const result = spawnSync('bash', ['-c', script], {
      encoding: 'utf8',
      env: { ...process.env, FAILURE: failure },
    });
    assert.equal(result.status, failure === 'none' ? 0 : 1, result.stderr);
    assert.ok((result.stdout + result.stderr).includes(expected), result.stdout + result.stderr);
    if (failure !== 'none') assert.ok(!result.stdout.includes('journal_reached'));
  }
});

// Exercise the actual CLI boundary, including errors whose messages contain private text.
test('CLI failures expose a closed stage code without selection or raw exception data', () => {
  const script = new URL('../../scripts/ci/inspect-horse-opponent-reads.mjs', import.meta.url);
  for (const [input, env, reason] of [
    ['PRIVATE_RAW_JSON', {}, 'selection_decode_failed'],
    [JSON.stringify({ ...selection, command: 'PRIVATE_COMMAND' }), {}, 'selection_refused'],
    [JSON.stringify(selection), { GIT_COMMIT_SHA: 'wrong' }, 'serving_identity_refused'],
  ]) {
    const result = spawnSync(
      process.execPath,
      [script.pathname, Buffer.from(input).toString('base64')],
      {
        encoding: 'utf8',
        env: { ...process.env, ...env },
      }
    );
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.deepEqual(JSON.parse(result.stderr), {
      scope: 'selected_horse_opponent_reads',
      status: 'unavailable',
      reason,
    });
  }
});

test('untrusted errors cannot forge diagnostic codes or disclose their payload', () => {
  for (const error of [
    new Error('read_frame_refused'),
    { reason: 'journal_read_failed', cards: 'PRIVATE' },
    null,
    'PRIVATE',
  ]) {
    assert.deepEqual(sanitizeInspectionFailure(error), {
      scope: 'selected_horse_opponent_reads',
      status: 'unavailable',
      reason: 'inspection_unavailable',
    });
  }
});
test('actual CLI reports the failing bounded stage and preserves successful output', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'horse-read-diagnostic-'));
  const script = new URL('../../scripts/ci/inspect-horse-opponent-reads.mjs', import.meta.url)
    .pathname;
  const run = (stage, journal = 'unused-synthetic-directory') =>
    spawnSync(
      process.execPath,
      [script, Buffer.from(JSON.stringify(selection)).toString('base64')],
      {
        cwd,
        encoding: 'utf8',
        env: {
          ...process.env,
          GIT_COMMIT_SHA: selection.sourceSha,
          HORSE_DECISION_JOURNAL_DIR: journal,
          FIXTURE_FAILURE: stage,
        },
      }
    );
  const refused = (result, reason) => {
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.deepEqual(JSON.parse(result.stderr), {
      scope: 'selected_horse_opponent_reads',
      status: 'unavailable',
      reason,
    });
    assert.ok(!result.stderr.includes('PRIVATE'));
  };
  try {
    refused(run(''), 'module_load_failed');
    mkdirSync(join(cwd, 'dist/services/horseDecisionJournal'), { recursive: true });
    mkdirSync(join(cwd, 'dist/engine'), { recursive: true });
    writeFileSync(join(cwd, 'package.json'), '{"type":"module"}');
    const fault = `const fail = s => { if (process.env.FIXTURE_FAILURE === s) throw Error('PRIVATE_CARDS_AND_RAW_RECORD'); };`;
    writeFileSync(
      join(cwd, 'dist/services/horseDecisionJournal/review.js'),
      fault +
        `
      export function readHorseJournalHandRecords() { fail('journal_read_failed'); return [{kind:'decision', sourceRelease:'${selection.sourceSha}', bytes: process.env.FIXTURE_FAILURE === 'inspection_bound' ? 33554433 : 1, body: process.env.FIXTURE_FAILURE === 'record_decode_failed' ? 'PRIVATE_INVALID_JSON' : JSON.stringify({snapshot:{type:'DECIDE_FAST', player:{user_id:'${id}'}, gameState:{players:[{user_id:'${id}'}],actionHistory:[]}},decision:{action:'fold'}})}]; }
      export function reconcileHorseJournalHand() { fail('journal_reconciliation_failed'); return {status:'synthetic'}; }
      export function horseRetainedPlanContext() { fail('retained_plan_refused'); return {kind:process.env.FIXTURE_FAILURE === 'invalid_plan' ? 'invalid' : 'legacy'}; }
    `
    );
    writeFileSync(
      join(cwd, 'dist/engine/HorseDecisionReadFrame.js'),
      fault +
        `export function decodeHorseDecisionReads() { fail('read_frame_refused'); return {stats:new Map()}; }`
    );
    writeFileSync(
      join(cwd, 'dist/engine/HorseDecisionEffects.js'),
      'export function horsePlanHandKey() { return "synthetic"; }'
    );
    writeFileSync(
      join(cwd, 'dist/engine/HorseObserverReadEvidence.js'),
      fault +
        `export function horseObserverReadsWereIndependent() { fail('decision_summary_failed'); return false; }`
    );
    refused(run('', ''), 'journal_configuration_missing');
    for (const reason of [
      'journal_read_failed',
      'inspection_bound',
      'journal_reconciliation_failed',
      'record_decode_failed',
      'retained_plan_refused',
      'read_frame_refused',
      'decision_summary_failed',
    ])
      refused(run(reason), reason);
    refused(run('invalid_plan'), 'retained_plan_refused');
    const success = run('');
    assert.equal(success.status, 0, success.stderr);
    assert.equal(success.stderr, '');
    const result = JSON.parse(success.stdout);
    assert.equal(result.completePopulation, false);
    assert.equal(result.hands.length, 1);
    assert.equal(result.hands[0].decisions[0].action, 'fold');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
