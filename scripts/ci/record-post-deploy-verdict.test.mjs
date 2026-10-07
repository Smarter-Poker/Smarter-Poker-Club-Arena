import assert from 'node:assert/strict';
import test from 'node:test';
import { decide, readVerdict, classifyCancelledLanes, FLEET_TASK_ID } from './record-post-deploy-verdict.mjs';

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
          assert.ok(/stood down|no open episode|replaced before it started/.test(out.reason),
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

// ---- 2026-10-07: replaced-before-start and not-owed are non-verdicts ------

// Run 37596381257 attempt 1, exactly as the jobs API returned it on
// 2026-10-07: both browser lanes were cancelled while queued (runner_id 0,
// runner_name "", zero steps) and the seal skipped by design. The pre-fix
// recorder counted all three as unverified and bumped the open episode.
const RECORD_37596381257 = {
  total_count: 6,
  jobs: [
    { name: GATE, conclusion: 'success', runner_id: 1000257640, runner_name: 'GitHub Actions 1000257640', steps: [{}, {}, {}, {}, {}, {}] },
    { name: LANES[0], conclusion: 'success', runner_id: 1000257642, runner_name: 'GitHub Actions 1000257642', steps: [{}] },
    { name: LANES[1], conclusion: 'cancelled', runner_id: 0, runner_name: '', steps: [] },
    { name: LANES[2], conclusion: 'cancelled', runner_id: 0, runner_name: '', steps: [] },
    { name: 'This verification admits its own verdict to the operational inbox', conclusion: null, runner_id: 1000257732, runner_name: 'GitHub Actions 1000257732', steps: [{}] },
    { name: LANES[3], conclusion: 'skipped', runner_id: null, runner_name: null, steps: [] },
  ],
};

function replacedRun(over = {}) {
  const starts = classifyCancelledLanes(RECORD_37596381257, [LANES[1], LANES[2]]);
  return verdict({
    lanes: [
      { name: LANES[0], result: 'success' },
      { name: LANES[1], result: 'cancelled', start: starts[LANES[1]] },
      { name: LANES[2], result: 'cancelled', start: starts[LANES[2]] },
      { name: LANES[3], result: 'skipped', owed: false },
    ],
    ...over,
  });
}

test('a lane cancelled while queued is replaced, read from runner and steps', () => {
  assert.deepEqual(classifyCancelledLanes(RECORD_37596381257, [LANES[1], LANES[2]]), {
    [LANES[1]]: 'replaced',
    [LANES[2]]: 'replaced',
  });
});

test('a cancelled lane that had a runner or a step started, and is never called replaced', () => {
  const ran = structuredClone(RECORD_37596381257);
  ran.jobs[2].runner_id = 1000257700;
  ran.jobs[2].runner_name = 'GitHub Actions 1000257700';
  ran.jobs[3].steps = [{ name: 'Set up job' }];
  assert.deepEqual(classifyCancelledLanes(ran, [LANES[1], LANES[2]]), {
    [LANES[1]]: 'started',
    [LANES[2]]: 'started',
  });
});

test('an unreadable or incomplete job record is COULD NOT TELL, never replaced', () => {
  for (const record of [null, {}, { total_count: 9, jobs: RECORD_37596381257.jobs },
    { total_count: 1, jobs: [{ name: LANES[1], conclusion: 'cancelled', runner_id: 0 }] }]) {
    assert.equal(classifyCancelledLanes(record, [LANES[1]])[LANES[1]], 'unknown');
  }
  const twice = structuredClone(RECORD_37596381257);
  twice.jobs.push(structuredClone(twice.jobs[2]));
  twice.total_count = twice.jobs.length;
  assert.equal(classifyCancelledLanes(twice, [LANES[1]])[LANES[1]], 'unknown');
});

test('a run whose lanes were replaced before they started writes nothing and closes nothing', () => {
  const open = { event_key: 'abc', status: 'firing', investigation_status: 'new' };
  for (const previous of [undefined, open]) {
    const out = decide(replacedRun(), previous);
    assert.equal(out.action, 'none');
    assert.match(out.reason, /replaced before it started/);
  }
});

test('a lane whose start could not be read stays loud and is named could-not-tell', () => {
  const out = decide(verdict({
    lanes: [{ name: LANES[1], result: 'cancelled', start: 'unknown' }, { name: LANES[2], result: 'success' }],
  }));
  assert.equal(out.action, 'fire');
  assert.deepEqual(out.payload.failed_jobs, [LANES[1]]);
  assert.deepEqual(out.payload.could_not_tell_jobs, [LANES[1]]);
});

test('a lane cancelled after it started is still a failure', () => {
  const out = decide(verdict({
    lanes: [{ name: LANES[1], result: 'cancelled', start: 'started' }, { name: LANES[2], result: 'success' }],
  }));
  assert.equal(out.action, 'fire');
  assert.deepEqual(out.payload.failed_jobs, [LANES[1]]);
  assert.deepEqual(out.payload.could_not_tell_jobs, []);
});

test('a seal that was not owed does not fire, and a passing run then closes the open episode', () => {
  const lanes = [
    { name: LANES[0], result: 'success' },
    { name: LANES[1], result: 'success' },
    { name: LANES[2], result: 'success' },
    { name: LANES[3], result: 'skipped', owed: false },
  ];
  assert.equal(decide(verdict({ lanes })).action, 'none');
  const out = decide(verdict({ lanes }), { event_key: 'abc', status: 'firing', investigation_status: 'new' });
  assert.equal(out.action, 'resolve');
  assert.deepEqual(out.payload.not_owed_jobs, [LANES[3]]);
});

test('a seal that WAS owed and skipped is still loud', () => {
  const out = decide(verdict({
    lanes: [{ name: LANES[1], result: 'success' }, { name: LANES[3], result: 'skipped' }],
  }));
  assert.equal(out.action, 'fire');
  assert.deepEqual(out.payload.skipped_jobs, [LANES[3]]);
});

test('not owed never excuses a lane that ran: a failed or cancelled lane stays a failure', () => {
  for (const result of ['failure', 'cancelled']) {
    const out = decide(verdict({ lanes: [{ name: LANES[3], result, owed: false }] }));
    assert.equal(out.action, 'fire');
    assert.deepEqual(out.payload.failed_jobs, [LANES[3]]);
  }
});

test('a real failure beside a replaced lane fires and names both', () => {
  const out = decide(replacedRun({
    lanes: [
      { name: LANES[0], result: 'failure' },
      { name: LANES[1], result: 'cancelled', start: 'replaced' },
    ],
  }));
  assert.equal(out.action, 'fire');
  assert.deepEqual(out.payload.failed_jobs, [LANES[0]]);
  assert.deepEqual(out.payload.replaced_jobs, [LANES[1]]);
});

test('readVerdict marks UNOWED_LANES and refuses a name that is not a lane', () => {
  const env = {
    WORKFLOW_LABEL: 'Post-Deploy E2E',
    ALERT_SOURCE: 'club-arena.post-deploy-e2e',
    ALERT_NAME: 'PostDeployVerificationIncomplete',
    RUN_ID: '37596381257',
    LANES: `success|${LANES[1]}\nskipped|${LANES[3]}`,
  };
  const parsed = readVerdict({ ...env, UNOWED_LANES: `${LANES[3]}\n` });
  assert.equal(parsed.lanes[1].owed, false);
  assert.equal(parsed.lanes[0].owed, undefined);
  assert.equal(readVerdict({ ...env, UNOWED_LANES: '' }).lanes[1].owed, undefined);
  assert.throws(() => readVerdict({ ...env, UNOWED_LANES: 'No Such Lane' }), /names no lane/);
});

// Run 37604057526 (repository_dispatch, engine-triggered) certified client
// dfb8c753 and engine 5f768074 and WROTE the Phase 1 seal, and the pre-fix
// recorder still bumped PostDeployVerificationIncomplete to delivery 116,
// because the SEO lane skips by design outside a publisher event. Parsed from
// the env the workflow now builds, it closes the open episode instead.
test('run 37604057526: a sealed engine certificate closes the episode, its SEO skip not owed', () => {
  const parsed = readVerdict({
    WORKFLOW_LABEL: 'Post-Deploy E2E',
    ALERT_SOURCE: 'club-arena.post-deploy-e2e',
    ALERT_NAME: 'PostDeployVerificationIncomplete',
    RUN_ID: '37604057526',
    HEAD_SHA: 'd1f7fac321a87bf3dfd46a6782d50e7fda4c9ad9',
    GATE_NAME: GATE,
    GATE_RESULT: 'success',
    GATE_SHOULD_RUN: 'true',
    LANES: `skipped|${LANES[0]}\nsuccess|${LANES[1]}\nsuccess|${LANES[2]}\nsuccess|${LANES[3]}\n`,
    UNOWED_LANES: `${LANES[0]}\n`,
  });
  const open = { event_key: 'c49cb80c8d3d', status: 'firing', investigation_status: 'new' };
  const out = decide(parsed, open);
  assert.equal(out.action, 'resolve');
  assert.equal(out.payload.resolves, 'c49cb80c8d3d');
  assert.deepEqual(out.payload.not_owed_jobs, [LANES[0]]);
  // Without the owed flag the same run is (wrongly, before 2026-10-07) loud.
  const preFix = decide(readVerdict({ ...parsedEnvWithout(parsed) }), open);
  assert.equal(preFix.action, 'fire');
});

function parsedEnvWithout(parsed) {
  return {
    WORKFLOW_LABEL: parsed.workflow,
    ALERT_SOURCE: parsed.source,
    ALERT_NAME: parsed.alertName,
    RUN_ID: parsed.runId,
    GATE_NAME: parsed.gate.name,
    GATE_RESULT: parsed.gate.result,
    GATE_SHOULD_RUN: parsed.gate.shouldRun,
    LANES: parsed.lanes.map((lane) => `${lane.result}|${lane.name}`).join('\n'),
  };
}
