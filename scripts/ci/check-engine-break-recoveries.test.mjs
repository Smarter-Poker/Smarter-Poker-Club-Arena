// Regression for the 2026-09-28 engine break recovery that never followed its
// fault, and for the ways the fix could stop running unseen. Runs with node --test.
import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  ALERT_NAME,
  decide,
  FLEET_TASK_ID,
  OVERDUE_SQL,
  OWNER_ACCOUNT,
  OWNED_FROM,
  run,
  RUN_EVIDENCE,
  SETTLE,
  SOURCE,
  UNKNOWN,
} from './check-engine-break-recoveries.mjs';

const OTHER = '22222222-2222-4222-8222-222222222222';
const fault = (route, hour) => ({
  route,
  fault_key: `break-failed:${hour}`,
  notices: ['n1'],
  sent_at: 'x',
  passed_at: 'y',
});
const owner = [fault(OWNER_ACCOUNT, '20261001T0400')];

test('an overdue fault fires one incident that is itself addressed to the fleet', () => {
  const v = decide(owner, undefined);
  assert.deepEqual(
    [v.action, v.exitCode, v.payload.target_task_id, v.payload.overdue],
    ['fire', 1, FLEET_TASK_ID, 1]
  );
  assert.equal(v.payload.owned_from, OWNED_FROM);
  assert.equal(v.payload.faults[0].fault_key, 'break-failed:20261001T0400');
});

test('a firing episode keeps its identity as faults join it', () => {
  const first = decide(owner, undefined);
  const later = decide([...owner, fault(OTHER, '20261001T0500')], {
    status: 'firing',
    event_key: first.eventKey,
  });
  assert.equal(later.eventKey, first.eventKey);
  assert.equal(
    decide([], { status: 'firing', event_key: later.eventKey }).eventKey,
    `${first.eventKey}:resolved`
  );
});

test('after a recovery, different faults open a new episode', () => {
  const first = decide(owner, undefined);
  const next = decide([fault(OWNER_ACCOUNT, '20261002T0100')], {
    status: 'resolved',
    event_key: `${first.eventKey}:resolved`,
    investigation_status: 'new',
  });
  assert.equal(next.action, 'fire');
  assert.notEqual(next.eventKey, first.eventKey);
});

test('a recurrence after the lane closed the incident opens a new one instead of bumping the closed row', () => {
  const first = decide(owner, undefined);
  for (const closed of ['verified_fixed', 'historical']) {
    const again = decide(owner, {
      status: 'firing',
      event_key: first.eventKey,
      investigation_status: closed,
    });
    assert.equal(again.action, 'fire');
    assert.notEqual(again.eventKey, first.eventKey);
  }
  assert.equal(
    decide([], { status: 'firing', event_key: first.eventKey, investigation_status: 'historical' })
      .action,
    'none'
  );
});

test('nothing overdue resolves a firing incident on the same key, addressed to the fleet', () => {
  const v = decide([], { status: 'firing', event_key: 'abc' });
  assert.deepEqual(
    [v.action, v.exitCode, v.eventKey, v.payload.target_task_id, v.payload.resolves],
    ['resolve', 0, 'abc:resolved', FLEET_TASK_ID, 'abc']
  );
  assert.equal(decide([], { status: 'resolved', event_key: 'abc:resolved' }).action, 'none');
  assert.equal(decide([], undefined).action, 'none');
});

test('a long list is capped in the payload but always counted', () => {
  const many = Array.from({ length: 150 }, (_, i) =>
    fault(OWNER_ACCOUNT, `20261001T${String(i).padStart(4, '0')}`)
  );
  const v = decide(many, undefined);
  assert.equal(v.payload.overdue, 150);
  assert.equal(v.payload.faults.length, 100);
});

/** A database that answers each query in turn and remembers what it was asked. */
const fakeDb = (answers) => {
  const asked = [];
  return {
    asked,
    async query(text, params = []) {
      asked.push({ text, params });
      const next = answers.shift();
      if (next instanceof Error) throw next;
      return { rows: next ?? [] };
    },
  };
};
const quiet = async (fn) => {
  const [log, error] = [console.log, console.error];
  const lines = [];
  console.log = (...a) => lines.push(a.join(' '));
  console.error = (...a) => lines.push(a.join(' '));
  try {
    return { result: await fn(), lines };
  } finally {
    [console.log, console.error] = [log, error];
  }
};

test('run records the incident through the operational inbox and re-reads it', async () => {
  const db = fakeDb([
    [],
    [{ n: 1 }],
    [fault(OTHER, '20261001T0400'), ...owner],
    [],
    [{ id: '901' }],
    [{ n: 1 }],
  ]);
  const { result, lines } = await quiet(() => run(db));
  assert.equal(result, 1);
  assert.deepEqual(db.asked[1].params, [RUN_EVIDENCE]);
  assert.deepEqual(db.asked[2].params, [OWNED_FROM, SETTLE, FLEET_TASK_ID, OWNER_ACCOUNT]);
  assert.deepEqual(db.asked[3].params, [SOURCE, ALERT_NAME]);
  const record = db.asked[4];
  assert.match(record.text, /public\.fn_record_operational_alert\(/);
  assert.deepEqual(record.params.slice(0, 5), [
    SOURCE,
    record.params[1],
    ALERT_NAME,
    'firing',
    'warning',
  ]);
  assert.equal(JSON.parse(record.params[5]).target_task_id, FLEET_TASK_ID);
  assert.deepEqual(db.asked[5].params, [SOURCE, record.params[1], FLEET_TASK_ID]);
  // A public log names the owner account in words and never prints another account's id.
  assert.ok(lines.some((l) => l.includes('notified to the owner account')));
  assert.ok(lines.some((l) => l.includes('notified to another recipient')));
  assert.ok(!lines.some((l) => l.includes(OTHER) || l.includes(OWNER_ACCOUNT)));
});

test('run records the recovery on the same key once nothing is overdue', async () => {
  const db = fakeDb([
    [],
    [{ n: 1 }],
    [],
    [{ event_key: 'abc', status: 'firing', investigation_status: 'new' }],
    [{ id: 7 }],
    [{ n: 1 }],
  ]);
  const { result } = await quiet(() => run(db));
  assert.equal(result, 0);
  assert.deepEqual(db.asked[4].params.slice(0, 5), [
    SOURCE,
    'abc:resolved',
    ALERT_NAME,
    'resolved',
    'info',
  ]);
});

test('a store that returns no receipt, or does not keep the row, is COULD NOT TELL, not a recorded incident', async () => {
  await assert.rejects(
    quiet(() => run(fakeDb([[], [{ n: 1 }], owner, [], [{ id: null }]]))),
    /returned no receipt/
  );
  await assert.rejects(
    quiet(() => run(fakeDb([[], [{ n: 1 }], owner, [], [{ id: 5 }], [{ n: 0 }]]))),
    /did not keep/
  );
});

test('the probe may shorten the settle; the job never does', async () => {
  const db = fakeDb([[], [{ n: 1 }], [], []]);
  await quiet(() => run(db, { settle: '0 seconds' }));
  assert.equal(db.asked[2].params[1], '0 seconds');
  const script = fileURLToPath(new URL('./check-engine-break-recoveries.mjs', import.meta.url));
  const { readFileSync } = await import('node:fs');
  assert.match(readFileSync(script, 'utf8'), /process\.exitCode = await run\(db\);/);
});

test('with no succeeded run of the scorecard job in its log, the audit cannot tell and says so', async () => {
  const db = fakeDb([[], [{ n: 0 }]]);
  await assert.rejects(
    quiet(() => run(db)),
    /no succeeded run of the break scorecard job/
  );
  assert.equal(db.asked.length, 2);
});

test("the hourly job's pass is read from pg_cron's run log, read once, and the owner's route is the task", () => {
  // Inlined into the per-row lookup, the log (305,503 rows in production on
  // 2026-09-29) timed out at two minutes; read once it took under a second.
  assert.match(OVERDUE_SQL, /runs AS MATERIALIZED \(/);
  assert.match(OVERDUE_SQL, /kept AS MATERIALIZED \(/);
  assert.match(OVERDUE_SQL, /FROM cron\.job_run_details d/);
  // A row recorded during the run, never one written after it ended.
  assert.match(OVERDUE_SQL, /s\.recorded_at <= r\.end_time\)/);
  // For the owner account only a resolved receipt for the task counts.
  assert.match(
    OVERDUE_SQL,
    /WHEN f\.route = \$4::uuid\s+THEN EXISTS \(SELECT 1 FROM public\.operational_notification_destinations/
  );
});

test('no database answer is COULD NOT TELL (exit 3), never clean or a plain failure', () => {
  const script = fileURLToPath(new URL('./check-engine-break-recoveries.mjs', import.meta.url));
  const env = { ...process.env };
  delete env.DATABASE_URL;
  const r = spawnSync(process.execPath, [script], { env, encoding: 'utf8' });
  assert.equal(r.status, UNKNOWN);
  assert.match(r.stderr, /COULD NOT TELL/);
});
