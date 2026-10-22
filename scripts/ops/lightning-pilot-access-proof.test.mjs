import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyAccessProof, ACCESS_PROOF_MAX_AGE_MS } from './lightning-pilot-access-proof.mjs';

const outsiderId = '23040e91-e0d0-430d-b18e-f9f67c385d90';
const A = '56d5d6f0-23e9-41b0-b407-852aa1026c2a';
const M = '681eb9e8-e9fd-4026-8ec6-64075b911d33';
const T1 = '64bc1e1b-556d-45bf-92cd-acbd983d56dc';
const T2 = 'f3d17d82-ed02-4784-a572-242e6a56cc1d';
const op = '9fe8fa4f-399d-4c12-b14e-b6bcfa770d3d';
const observedAt = '2026-10-22T16:00:00.000Z';
const run = () => ({
  id: 39803082299,
  path: '.github/workflows/lightning-pilot-stage.yml',
  headBranch: 'main',
  event: 'workflow_dispatch',
  status: 'completed',
  conclusion: 'success',
});
const outsiderBrowser = (id) => ({
  clusterId: id,
  actor: 'outsider',
  browserSocket: { opened: false, closedCode: 1006, observedError: true, messages: 0 },
  authenticated: true,
  discovery: 'hidden',
  entry: 'refused',
});
const outsiderState = (state) => ({
  state,
  browser: [outsiderBrowser(A), outsiderBrowser(M)],
  sockets: [T1, T2].map((tableId) => ({ tableId, outcome: 'refused', status: 403 })),
  joins: [A, M].map((clusterId) => ({ clusterId, ok: null, refused: true })),
  poolStatus: [A, M].map((clusterId) => ({ clusterId, outcome: 'refused' })),
  approved: false,
  funded: false,
});
const proof = () => ({
  stage: 'access',
  operationId: op,
  completedAt: '2026-10-22T15:27:42.628Z',
  serviceSessionCleanup: 'local_signout_confirmed',
  clusters: [{ clusterId: A }, { clusterId: M }],
  access: {
    scope: 'designated_private_pilot_only',
    outsiderId,
    operationId: op,
    verdict: 'passed',
    cleanup: {
      pendingRequest: 'removed_and_absence_verified',
      outsiderSession: 'local_signout_confirmed',
    },
    poolStatusOwner: [A, M].map((clusterId) => ({ clusterId, outcome: 'positive' })),
    browserOwner: [A, M].map((clusterId) => ({
      clusterId,
      actor: 'owner',
      browserSocket: { opened: true },
      authenticated: true,
      discovery: 'visible',
      entry: 'rendered',
    })),
    states: [
      { state: 'owner', tableId: T1, socket: { outcome: 'opened', status: 101 } },
      { state: 'owner', tableId: T2, socket: { outcome: 'opened', status: 101 } },
      outsiderState('nonmember'),
      outsiderState('pending'),
    ],
  },
});
const verify = (over = {}) =>
  verifyAccessProof({
    run: run(),
    proof: proof(),
    outsiderId,
    clusterIds: [A, M],
    observedAt,
    ...over,
  });

test('a fresh passed access stage on main for this outsider and both pilots is PROVED', () => {
  const r = verify();
  assert.equal(r.status, 'known');
  assert.equal(r.verdict, 'PROVED');
  assert.equal(r.data.runId, '39803082299');
  assert.equal(r.data.liveTablesProbed, 2);
});

test('absent or unreadable evidence is never a pass', () => {
  assert.equal(verify({ run: null, proof: null }).verdict, 'ACCESS_PROOF_NOT_SUPPLIED');
  assert.equal(verify({ proof: null }).verdict, 'ACCESS_PROOF_UNREADABLE');
  assert.equal(verify({ run: undefined }).verdict, 'ACCESS_PROOF_UNREADABLE');
});

test('the run must be a successful dispatched access stage on main', () => {
  for (const change of [
    { conclusion: 'failure' },
    { status: 'in_progress' },
    { headBranch: 'feature' },
    { event: 'push' },
    { path: '.github/workflows/other.yml' },
    { id: 'abc' },
  ])
    assert.equal(
      verify({ run: { ...run(), ...change } }).verdict,
      'ACCESS_PROOF_RUN_NOT_A_SUCCESSFUL_MAIN_ACCESS_STAGE'
    );
});

test('a non-access artifact or one carrying an error is refused', () => {
  const p = proof();
  p.stage = 'report';
  assert.equal(verify({ proof: p }).verdict, 'ACCESS_PROOF_NOT_AN_ACCESS_STAGE_RESULT');
  const e = proof();
  e.error = 'Private Pilot Access Proof Failed';
  assert.equal(verify({ proof: e }).verdict, 'ACCESS_PROOF_NOT_AN_ACCESS_STAGE_RESULT');
});

test('stale or future-dated proof is refused', () => {
  const later = new Date(Date.parse(proof().completedAt) + ACCESS_PROOF_MAX_AGE_MS + 1000);
  assert.equal(verify({ observedAt: later.toISOString() }).verdict, 'ACCESS_PROOF_STALE');
  assert.equal(
    verify({ observedAt: '2026-10-22T15:00:00.000Z' }).verdict,
    'ACCESS_PROOF_TIME_UNVERIFIED'
  );
});

test('a failed verdict, another outsider or unverified cleanup is refused', () => {
  const failed = proof();
  failed.access.verdict = 'failed_or_unknown';
  assert.equal(
    verify({ proof: failed }).verdict,
    'ACCESS_PROOF_NOT_PASSED_FOR_DESIGNATED_OUTSIDER'
  );
  assert.equal(
    verify({ outsiderId: '70000000-0000-4000-8000-000000000007' }).verdict,
    'ACCESS_PROOF_NOT_PASSED_FOR_DESIGNATED_OUTSIDER'
  );
  const dirty = proof();
  dirty.access.cleanup.pendingRequest = 'owned_pending_cleanup_unverified';
  assert.equal(verify({ proof: dirty }).verdict, 'ACCESS_PROOF_NOT_PASSED_FOR_DESIGNATED_OUTSIDER');
});

test('a proof that covered only one pilot does not certify the other', () => {
  const p = proof();
  p.clusters = [{ clusterId: A }];
  assert.equal(verify({ proof: p }).verdict, 'ACCESS_PROOF_DOES_NOT_COVER_EVERY_PILOT');
  assert.equal(verify({ clusterIds: [] }).verdict, 'ACCESS_PROOF_DOES_NOT_COVER_EVERY_PILOT');
});

test('every surface is re-checked from the retained observations, not the verdict alone', () => {
  const owner = proof();
  owner.access.browserOwner[1].entry = 'refused';
  assert.equal(verify({ proof: owner }).verdict, 'ACCESS_PROOF_OWNER_POSITIVE_CONTROL_MISSING');
  const visible = proof();
  visible.access.states[2].browser[0].discovery = 'visible';
  assert.equal(verify({ proof: visible }).verdict, 'ACCESS_PROOF_NONMEMBER_REFUSAL_INCOMPLETE');
  const socket = proof();
  socket.access.states[3].sockets[1].status = 101;
  assert.equal(verify({ proof: socket }).verdict, 'ACCESS_PROOF_PENDING_REFUSAL_INCOMPLETE');
  const join = proof();
  join.access.states[2].joins[1] = { clusterId: M, ok: true, refused: false };
  assert.equal(verify({ proof: join }).verdict, 'ACCESS_PROOF_NONMEMBER_REFUSAL_INCOMPLETE');
  const pool = proof();
  pool.access.states[3].poolStatus[0].outcome = 'exposed';
  assert.equal(verify({ proof: pool }).verdict, 'ACCESS_PROOF_PENDING_REFUSAL_INCOMPLETE');
  const approved = proof();
  approved.access.states[3].approved = true;
  assert.equal(verify({ proof: approved }).verdict, 'ACCESS_PROOF_PENDING_REFUSAL_INCOMPLETE');
  const missing = proof();
  missing.access.states.pop();
  assert.equal(verify({ proof: missing }).verdict, 'ACCESS_PROOF_PENDING_REFUSAL_INCOMPLETE');
});
