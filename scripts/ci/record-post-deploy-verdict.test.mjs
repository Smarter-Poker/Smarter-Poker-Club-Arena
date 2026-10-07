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

// A true repeat - the SAME run observed twice, by a re-run of this job or a
// second reporter invocation inside one run - must still bump delivery_count
// rather than mint a row, which is what the identity hash being stable for
// identical inputs already gives us. What it must NOT do is adopt the key of
// whatever row happened to be newest: that is what absorbed 20 distinct
// verifications onto row 240356 (intake record 2026-10-06T01:05:24Z).
test('a true repeat of the same occurrence reuses its own key, so delivery_count bumps and no row is minted', () => {
  const repeat = { lanes: [{ name: LANES[1], result: 'failure' }] };
  const first = decide(verdict(repeat));
  const openFiring = { event_key: first.eventKey, status: 'firing', investigation_status: 'investigating' };
  const second = decide(verdict(repeat), openFiring);
  assert.equal(second.eventKey, first.eventKey);
  assert.equal(second.action, 'fire');
});

test('a recurrence after the fleet closed the episode is a NEW incident, never a bump of a closed row', () => {
  const closed = { event_key: 'kept', status: 'firing', investigation_status: 'verified_fixed' };
  const out = decide(verdict({ lanes: [{ name: LANES[1], result: 'failure' }] }), closed);
  assert.notEqual(out.eventKey, 'kept');
  assert.match(out.eventKey, /^[0-9a-f]{64}$/);
});

// This test used to pass vacuously. Every call below omitted `previous`, and
// production NEVER omits it: the reporter reads the newest row for
// (source, alertname) first, and on this path that row is always an open firing
// one, because no lane closes rows. So the suite proved identity separation in
// the one case that never happens and stayed green while the collapse ran. Each
// case now carries the open firing row production actually hands decide().
test('identity separates two occurrences: a different run id or head sha is a different incident', () => {
  const broken = { lanes: [{ name: LANES[1], result: 'failure' }] };
  const open = (key) => ({ event_key: key, status: 'firing', investigation_status: 'investigating' });
  const a = decide(verdict(broken)).eventKey;
  const b = decide(verdict({ ...broken, runId: '37365802796' }), open(a)).eventKey;
  const c = decide(verdict({ ...broken, headSha: '6e65308af3af3bd3d4ba6a9d6f0b6ab36b6ad9f1' }), open(a)).eventKey;
  assert.notEqual(a, b);
  assert.notEqual(a, c);
  assert.notEqual(b, c);
  assert.equal(a, decide(verdict(broken), open('something-else-entirely')).eventKey); // stable for the same inputs
});

// THE REGRESSION. This is public.operational_alert_events row 240356 exactly.
// Between 2026-10-06T00:07:48Z and 02:58:19Z that ONE row reached
// delivery_count 20 while its payload still named only run 37391734160 / head
// 9e8d17e5: a store read for sixteen distinct post-deploy run ids returned that
// single row, so attribution for nineteen production verification outcomes -
// including run 37389347702, the only conclusion=failure in forty runs - was
// permanently unrecoverable. Cause: decide() computed a correct per-occurrence
// identity and then threw it away for previous.event_key whenever a prior firing
// row was open, which on this path is always.
// Against the pre-fix code every key below is 'absorbed' and this test fails.
test('THE REGRESSION: distinct occurrences never collapse onto the open row, however long it stays open', () => {
  const absorbed = { event_key: 'absorbed', status: 'firing', investigation_status: 'investigating' };
  const occurrences = [
    { runId: '37391734160', headSha: '9e8d17e5fd45d91ea04a2f1e040ac2b39c2a20c9' },
    { runId: '37389347702', headSha: 'cd0207f1a4b9c8d7e6f5a4b3c2d1e0f9a8b7c6d5' },
    { runId: '37405864054', headSha: '33dda8823f1e2d3c4b5a69788796a5b4c3d2e1f0' },
    { runId: '37401882461', headSha: '22efa9962b1c3d4e5f6a7b8c9d0e1f2a3b4c5d6e' },
  ];
  const keys = occurrences.map((o) => decide(verdict({
    ...o,
    gate: { name: GATE, result: 'failure', shouldRun: '' },
    lanes: LANES.map((name) => ({ name, result: 'skipped' })),
  }), absorbed).eventKey);
  for (const key of keys) {
    assert.notEqual(key, 'absorbed', 'a distinct occurrence must never adopt the open row\'s key');
    assert.match(key, /^[0-9a-f]{64}$/);
  }
  assert.equal(new Set(keys).size, occurrences.length, 'four distinct occurrences must hold four distinct identities');
});

// THE INVARIANT, enforced where the key is minted: on the fire path the event
// key is a function of the verdict ALONE. No shape of `previous` - open or
// closed, firing or resolved, foreign key or absent - can change it. An
// identity that can be overridden by unrelated store state is how a reporter
// loses custody of its own events.
test('THE INVARIANT: no shape of previous can change the key a firing verdict mints', () => {
  const broken = {
    gate: { name: GATE, result: 'failure', shouldRun: '' },
    lanes: LANES.map((name) => ({ name, result: 'skipped' })),
  };
  const expected = decide(verdict(broken)).eventKey;
  const statuses = ['firing', 'resolved'];
  const investigations = ['new', 'investigating', 'verified_fixed', 'historical'];
  for (const event_key of ['absorbed', expected, '', 'kept']) {
    for (const status of statuses) {
      for (const investigation_status of investigations) {
        const out = decide(verdict(broken), { event_key, status, investigation_status });
        assert.equal(out.action, 'fire');
        assert.equal(out.eventKey, expected,
          `previous {${event_key}/${status}/${investigation_status}} must not move the key`);
      }
    }
  }
  assert.equal(decide(verdict(broken), undefined).eventKey, expected);
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
