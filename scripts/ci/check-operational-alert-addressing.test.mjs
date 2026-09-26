// Regression for the 2026-09-26 unaddressed-alert incident. Runs with node --test.
import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { decide, FLEET_TASK_ID, UNKNOWN } from './check-operational-alert-addressing.mjs';

const workers = [{ source: 'workers.scraper-watchdog', rows: '2', first_id: '901', oldest: '2026-09-26 12:00:03+00' }];

test('an unaddressed alert fires one incident that is itself addressed to the fleet', () => {
  const v = decide(workers, undefined);
  assert.equal(v.action, 'fire');
  assert.equal(v.exitCode, 1);
  assert.equal(v.payload.target_task_id, FLEET_TASK_ID);
  assert.deepEqual(v.payload.sources, { 'workers.scraper-watchdog': 2 });
});

test('a firing episode keeps its identity while the window slides to new rows', () => {
  const first = decide(workers, undefined);
  const later = [{ source: 'workers.scraper', rows: '1', first_id: '950', oldest: '2026-09-26 13:30:00+00' }];
  const second = decide(later, { status: 'firing', event_key: first.eventKey });
  assert.equal(second.action, 'fire');
  assert.equal(second.eventKey, first.eventKey);
  assert.equal(decide([], { status: 'firing', event_key: second.eventKey }).eventKey, `${first.eventKey}:resolved`);
});

test('after a recovery, a fault from different rows opens a new episode', () => {
  const first = decide(workers, undefined);
  const other = decide([{ source: 'alertmanager', rows: '3', first_id: '999', oldest: 'x' }],
    { status: 'resolved', event_key: `${first.eventKey}:resolved`, investigation_status: 'new' });
  assert.equal(other.action, 'fire');
  assert.notEqual(other.eventKey, first.eventKey);
});

test('a recurrence after the lane closed the incident opens a new one instead of bumping the closed row', () => {
  const first = decide(workers, undefined);
  for (const closed of ['verified_fixed', 'historical']) {
    const again = decide(workers, { status: 'firing', event_key: first.eventKey, investigation_status: closed });
    assert.equal(again.action, 'fire');
    assert.notEqual(again.eventKey, first.eventKey);
  }
  assert.equal(decide([], { status: 'firing', event_key: first.eventKey, investigation_status: 'verified_fixed' }).action, 'none');
});

test('a clean window resolves a firing incident through the same route', () => {
  const v = decide([], { status: 'firing', event_key: 'abc' });
  assert.deepEqual([v.action, v.exitCode, v.eventKey, v.payload.target_task_id], ['resolve', 0, 'abc:resolved', FLEET_TASK_ID]);
});

test('a clean window with nothing firing records nothing', () => {
  assert.equal(decide([], { status: 'resolved', event_key: 'abc:resolved' }).action, 'none');
  assert.equal(decide([], undefined).action, 'none');
});

test('no database answer is COULD NOT TELL (exit 3), never clean or a plain failure', () => {
  const script = fileURLToPath(new URL('./check-operational-alert-addressing.mjs', import.meta.url));
  const env = { ...process.env }; delete env.DATABASE_URL;
  const run = spawnSync(process.execPath, [script], { env, encoding: 'utf8' });
  assert.equal(run.status, UNKNOWN);
  assert.match(run.stderr, /COULD NOT TELL/);
});
