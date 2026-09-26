import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isActiveInDispatcher,
  slugAppearsAnywhere,
  diff,
  decide,
} from './check-retired-cron-jobs-match-dispatcher.mjs';

const DISPATCHER_FIXTURE = `
ALL_CRONS = [
    ('/api/cron/auto-settlement',           dict(day_of_week='mon', hour=10, minute=0)),
    ('/cron/video-library-scraper',         dict(minute='*/15')),
]

# Retired 2026-09-16: /api/clawbot/orchestrator is gone. See
# ca_retired_cron_jobs for the registry row.
`;

test('isActiveInDispatcher: true for a path that is a live ALL_CRONS tuple', () => {
  assert.equal(isActiveInDispatcher(DISPATCHER_FIXTURE, '/api/cron/auto-settlement'), true);
});

test('isActiveInDispatcher: false for a path that only appears in a comment', () => {
  assert.equal(isActiveInDispatcher(DISPATCHER_FIXTURE, '/api/clawbot/orchestrator'), false);
});

test('slugAppearsAnywhere: matches on the bare slug when the full path differs', () => {
  assert.equal(slugAppearsAnywhere(DISPATCHER_FIXTURE, '/cron/orchestrator'), false);
  assert.equal(slugAppearsAnywhere(DISPATCHER_FIXTURE, '/cron/video-library-scraper'), true);
});

test('slugAppearsAnywhere: matches the /api/cron/ variant of a /cron/ job_name', () => {
  assert.equal(slugAppearsAnywhere(DISPATCHER_FIXTURE, '/cron/auto-settlement'), true);
});

test('diff: finds a retired job that is live again in the dispatcher', () => {
  const result = diff(
    DISPATCHER_FIXTURE,
    [{ job_name: '/cron/auto-settlement-legacy', dispatcher_path: '/api/cron/auto-settlement' }],
    []
  );
  assert.deepEqual(result.reactivated, ['/cron/auto-settlement-legacy']);
  assert.deepEqual(result.unregistered, []);
});

test('diff: finds a silent job absent from the dispatcher with no retirement row', () => {
  const result = diff(
    DISPATCHER_FIXTURE,
    [],
    [{ job_name: '/cron/clawbot-orchestrator' }, { job_name: '/cron/video-library-scraper' }]
  );
  assert.deepEqual(result.reactivated, []);
  assert.deepEqual(result.unregistered, ['/cron/clawbot-orchestrator']);
});

test('diff: agrees when every retired path is gone and every stale job is still dispatched', () => {
  const result = diff(
    DISPATCHER_FIXTURE,
    [{ job_name: '/cron/clawbot-orchestrator', dispatcher_path: '/api/clawbot/orchestrator' }],
    [{ job_name: '/cron/video-library-scraper' }]
  );
  assert.deepEqual(result.reactivated, []);
  assert.deepEqual(result.unregistered, []);
});

test('decide: fires with a stable identity across both mismatch kinds', () => {
  const mismatch = { reactivated: ['/cron/a'], unregistered: ['/cron/b'] };
  const verdict = decide(mismatch, undefined);
  assert.equal(verdict.action, 'fire');
  assert.equal(verdict.exitCode, 1);
  assert.equal(verdict.payload.target_task_id, '01a09b86-5ba8-7290-8657-1041f13dd3ca');
});

test('decide: reuses the event_key while the same incident keeps firing', () => {
  const mismatch = { reactivated: [], unregistered: ['/cron/b'] };
  const previous = { event_key: 'abc123', status: 'firing', investigation_status: 'investigating' };
  const verdict = decide(mismatch, previous);
  assert.equal(verdict.eventKey, 'abc123');
});

test('decide: opens a new identity once a closed incident recurs', () => {
  const mismatch = { reactivated: [], unregistered: ['/cron/b'] };
  const previous = { event_key: 'abc123', status: 'firing', investigation_status: 'verified_fixed' };
  const verdict = decide(mismatch, previous);
  assert.notEqual(verdict.eventKey, 'abc123');
});

test('decide: resolves a firing incident once the mismatch clears', () => {
  const mismatch = { reactivated: [], unregistered: [] };
  const previous = { event_key: 'abc123', status: 'firing', investigation_status: 'investigating' };
  const verdict = decide(mismatch, previous);
  assert.equal(verdict.action, 'resolve');
  assert.equal(verdict.exitCode, 0);
  assert.equal(verdict.eventKey, 'abc123:resolved');
});

test('decide: no-ops when nothing mismatches and nothing was firing', () => {
  const verdict = decide({ reactivated: [], unregistered: [] }, undefined);
  assert.equal(verdict.action, 'none');
  assert.equal(verdict.exitCode, 0);
});
