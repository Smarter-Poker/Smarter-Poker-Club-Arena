import assert from 'node:assert/strict';
import test from 'node:test';
import { decide, readVerdict, FLEET_TASK_ID } from './record-post-deploy-verdict.mjs';

const LANES = [
  'The Live SEO Contract Holds',
  'Client browser verification',
  'Live-table and engine verification',
  'Seal certified Phase 1 customization cutover',
];
const GATE = 'Confirm The Hetzner Web Publish Reached Production';

function verdict(over = {}) {
  return {
    workflow: 'Post-Deploy E2E',
    source: 'club-arena.post-deploy-e2e',
    alertName: 'PostDeployVerificationIncomplete',
    runId: '37368847647',
    runAttempt: '1',
    runUrl: 'https://github.com/Smarter-Poker/Smarter-Poker-Club-Arena/actions/runs/37368847647',
    headSha: '6953271dc1072aced0929424743473b8ea4d3f25',
    gate: { name: GATE, result: 'success', shouldRun: 'true' },
    lanes: LANES.map((name) => ({ name, result: 'success' })),
    ...over,
  };
}

// THE REGRESSION. This is run 37368847647 of 2026-10-05T20:17:49Z exactly: the
// gate failed at "Read The Origin Job Verdict" and every lane below it was
// skipped, never run. Against the pre-fix code there was no writer on this path
// at all and the store received nothing; four such runs cleared themselves in
// 69 minutes with nobody told. It must fire, it must be critical, and it must
// say that nothing was verified.
test('the 2026-10-05 shape fires: gate failed, every lane skipped, nothing verified', () => {
  const out = decide(verdict({
    gate: { name: GATE, result: 'failure', shouldRun: '' },
    lanes: LANES.map((name) => ({ name, result: 'skipped' })),
  }));
  assert.equal(out.action, 'fire');
  assert.equal(out.severity, 'critical');
  assert.equal(out.payload.nothing_verified, true);
  assert.deepEqual(out.payload.failed_jobs, [GATE]);
  assert.deepEqual(out.payload.skipped_jobs, LANES.slice().sort());
  assert.equal(out.payload.target_task_id, FLEET_TASK_ID);
  assert.equal(out.payload.run_id, '37368847647');
  assert.equal(out.payload.head_sha, '6953271dc1072aced0929424743473b8ea4d3f25');
  assert.match(out.eventKey, /^[0-9a-f]{64}$/);
});

// if: failure() would have missed this: no job FAILED, they were skipped.
test('an all-skipped verification still admits, so if: failure() cannot be the gate', () => {
  const out = decide(verdict({
    gate: { name: GATE, result: 'failure', shouldRun: '' },
    lanes: LANES.map((name) => ({ name, result: 'skipped' })),
  }));
  assert.equal(out.action, 'fire');
  assert.equal(out.payload.failed_jobs.length, 1);
  assert.ok(out.payload.skipped_jobs.length > 0);
});

test('a cancelled lane is not a pass', () => {
  const out = decide(verdict({
    lanes: [{ name: LANES[1], result: 'cancelled' }, { name: LANES[2], result: 'success' }],
  }));
  assert.equal(out.action, 'fire');
  assert.equal(out.severity, 'warning');
  assert.deepEqual(out.payload.failed_jobs, [LANES[1]]);
});

test('a downstream failure under a passing gate is warning, not critical', () => {
  const out = decide(verdict({
    lanes: [{ name: LANES[2], result: 'failure' }, { name: LANES[1], result: 'success' }],
  }));
  assert.equal(out.action, 'fire');
  assert.equal(out.severity, 'warning');
  assert.equal(out.payload.nothing_verified, false);
});

// The supersede case the always() gate must not alarm on: the publisher stood
// down because the origin already serves a newer bundle, so the gate SUCCEEDS,
// never writes should_run, and every lane skips by design.
test('a superseded publisher stand-down records nothing', () => {
  const out = decide(verdict({
    gate: { name: GATE, result: 'success', shouldRun: '' },
    lanes: LANES.map((name) => ({ name, result: 'skipped' })),
  }));
  assert.equal(out.action, 'none');
  assert.match(out.reason, /stood down/);
});

test('a fully green run with no open episode records nothing, so success cannot inflate the backlog', () => {
  assert.equal(decide(verdict()).action, 'none');
  assert.equal(decide(verdict(), { event_key: 'abc', status: 'resolved', investigation_status: 'new' }).action, 'none');
});

test('a green run closes an episode the fleet still has open', () => {
  const out = decide(verdict(), { event_key: 'abc', status: 'firing', investigation_status: 'new' });
  assert.equal(out.action, 'resolve');
  assert.equal(out.severity, 'info');
  assert.equal(out.eventKey, 'abc:resolved');
  assert.equal(out.payload.resolves, 'abc');
});

test('a green run does not re-close an episode the fleet already closed', () => {
  for (const investigation_status of ['verified_fixed', 'historical']) {
    assert.equal(decide(verdict(), { event_key: 'abc', status: 'firing', investigation_status }).action, 'none');
  }
});

test('an open firing episode keeps its identity, so a repeat bumps delivery_count instead of minting a row', () => {
  const previous = { event_key: 'kept', status: 'firing', investigation_status: 'investigating' };
  const out = decide(verdict({ lanes: [{ name: LANES[1], result: 'failure' }] }), previous);
  assert.equal(out.eventKey, 'kept');
});

test('a recurrence after the fleet closed the episode is a NEW incident, never a bump of a closed row', () => {
  const closed = { event_key: 'kept', status: 'firing', investigation_status: 'verified_fixed' };
  const out = decide(verdict({ lanes: [{ name: LANES[1], result: 'failure' }] }), closed);
  assert.notEqual(out.eventKey, 'kept');
  assert.match(out.eventKey, /^[0-9a-f]{64}$/);
});

test('identity separates two occurrences: a different run id or head sha is a different incident', () => {
  const broken = { lanes: [{ name: LANES[1], result: 'failure' }] };
  const a = decide(verdict(broken)).eventKey;
  const b = decide(verdict({ ...broken, runId: '37365802796' })).eventKey;
  const c = decide(verdict({ ...broken, headSha: '6e65308af3af3bd3d4ba6a9d6f0b6ab36b6ad9f1' })).eventKey;
  assert.notEqual(a, b);
  assert.notEqual(a, c);
  assert.equal(a, decide(verdict(broken)).eventKey); // and it is stable for the same inputs
});

// THE INVARIANT. There is no completed verification whose verdict goes
// unrecorded: every outcome either admits a row or is one of exactly two
// explicitly justified silences — nothing to verify, or nothing to close.
test('no verdict is ever silently dropped', () => {
  const results = ['success', 'failure', 'cancelled', 'skipped'];
  for (const gateResult of results) {
    for (const shouldRun of ['true', '']) {
      for (const laneResult of results) {
        const out = decide(verdict({
          gate: { name: GATE, result: gateResult, shouldRun },
          lanes: LANES.map((name) => ({ name, result: laneResult })),
        }));
        assert.ok(['fire', 'resolve', 'none'].includes(out.action));
        if (out.action === 'none') {
          assert.ok(/stood down|no open episode/.test(out.reason),
            `silence must be justified, got ${out.reason} for gate=${gateResult}/${shouldRun} lane=${laneResult}`);
          assert.ok(gateResult === 'success',
            `a gate that did not succeed must never be silent (gate=${gateResult}/${shouldRun} lane=${laneResult})`);
        } else {
          assert.equal(out.payload.target_task_id, FLEET_TASK_ID);
        }
      }
    }
  }
});

test('readVerdict refuses a verdict it cannot address or identify', () => {
  const base = {
    WORKFLOW_LABEL: 'Post-Deploy E2E',
    ALERT_SOURCE: 'club-arena.post-deploy-e2e',
    ALERT_NAME: 'PostDeployVerificationIncomplete',
    RUN_ID: '37368847647',
  };
  assert.throws(() => readVerdict({}), /WORKFLOW_LABEL is missing/);
  assert.throws(() => readVerdict({ ...base, ALERT_SOURCE: '' }), /ALERT_SOURCE is missing/);
  assert.throws(() => readVerdict({ ...base, ALERT_NAME: '  ' }), /ALERT_NAME is missing/);
  assert.throws(() => readVerdict({ ...base, RUN_ID: '' }), /RUN_ID is missing/);
  assert.throws(() => readVerdict({ ...base, LANES: 'success' }), /not result\|name/);
});

test('readVerdict parses the real workflow env, lane names with spaces and all', () => {
  const parsed = readVerdict({
    WORKFLOW_LABEL: 'Post-Deploy E2E',
    ALERT_SOURCE: 'club-arena.post-deploy-e2e',
    ALERT_NAME: 'PostDeployVerificationIncomplete',
    RUN_ID: '37368847647',
    RUN_ATTEMPT: '1',
    RUN_URL: 'https://github.com/Smarter-Poker/Smarter-Poker-Club-Arena/actions/runs/37368847647',
    HEAD_SHA: '6953271dc1072aced0929424743473b8ea4d3f25',
    GATE_NAME: GATE,
    GATE_RESULT: 'failure',
    GATE_SHOULD_RUN: '',
    LANES: `\nskipped|${LANES[0]}\nskipped|${LANES[1]}\nskipped|${LANES[2]}\nskipped|${LANES[3]}\n`,
  });
  assert.equal(parsed.gate.result, 'failure');
  assert.equal(parsed.gate.name, GATE);
  assert.equal(parsed.lanes.length, 4);
  assert.deepEqual(parsed.lanes.map((l) => l.name), LANES);
  assert.ok(parsed.lanes.every((l) => l.result === 'skipped'));
  // and the parsed env drives the same verdict as the hand-built one
  const out = decide(parsed);
  assert.equal(out.action, 'fire');
  assert.equal(out.severity, 'critical');
  assert.equal(out.payload.nothing_verified, true);
});

test('a workflow with one job and no gate parses with gate null', () => {
  const parsed = readVerdict({
    WORKFLOW_LABEL: 'Deploy Club Arena monitoring',
    ALERT_SOURCE: 'club-arena.deploy-monitoring',
    ALERT_NAME: 'MonitoringDeployFailed',
    RUN_ID: '37161251923',
    LANES: 'failure|deploy',
  });
  assert.equal(parsed.gate, null);
  assert.equal(decide(parsed).action, 'fire');
});

// deploy-monitoring.yml is the same hole with one job: a red monitoring deploy
// was only ever a red check run, so the live-vs-repo alertmanager comparison
// could fail and the store would not know.
test('the monitoring deploy reports through the same route', () => {
  const out = decide({
    workflow: 'Deploy Club Arena monitoring',
    source: 'club-arena.deploy-monitoring',
    alertName: 'MonitoringDeployFailed',
    runId: '37161251923',
    headSha: '6ebbc8ce4d1c2b1a7f8e6d5c4b3a29180f7e6d5c',
    gate: null,
    lanes: [{ name: 'deploy', result: 'failure' }],
  });
  assert.equal(out.action, 'fire');
  assert.equal(out.severity, 'warning');
  assert.deepEqual(out.payload.failed_jobs, ['deploy']);
  assert.equal(out.payload.target_task_id, FLEET_TASK_ID);
});
