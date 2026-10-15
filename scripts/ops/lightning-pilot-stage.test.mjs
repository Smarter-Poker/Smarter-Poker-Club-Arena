import test from 'node:test';
import assert from 'node:assert/strict';
import {
  STAGE_ACTIONS,
  assertStageReadiness,
  assertStageTarget,
  runPilotStage,
  stageRequestId,
} from './lightning-pilot-stage.mjs';
import { PILOT } from './prepare-lightning-private-pilot.mjs';

const CLUB = 'e14bc9f7-736d-425f-8f2c-e78305ebac1d';
const OP = '3f0a8f8e-5d2b-4c1e-9a7b-2f6d1c0e4b11';
const game6 = {
  id: 'babb43f1-368e-406f-a97a-a0d5013648b2',
  club_id: CLUB,
  name: 'Lightning Pilot NLH 6',
  handedness: 6,
  sb: 0.01,
  bb: 0.02,
  must_move: true,
  closed_at: null,
  ruleset_snapshot: { options: { is_private: true } },
};
const game9 = {
  ...game6,
  id: '3330ff9f-76ec-4487-b0c9-fc8ad8c2fdbb',
  name: 'Lightning Pilot NLH 9',
  handedness: 9,
  sb: 0.02,
  bb: 0.04,
};
const shadowReady = {
  ok: true,
  verdict: 'insufficient_evidence',
  reasons: [
    { code: 'NO_AA_CALIBRATION', severity: 'evidence' },
    { code: 'NO_LATENCY_EVIDENCE', severity: 'evidence' },
    { code: 'WORKER_OFF', severity: 'evidence' },
  ],
};
const env = {
  PILOT_STAGE: 'shadow',
  PILOT_OPERATION_ID: OP,
  PILOT_REASON: 'Lightning Phase 3 Stage 1 shadow calibration on the private pilot',
  SP_EMAIL: PILOT.ownerEmail,
  SP_PASS: 'x',
  SUPABASE_URL: 'https://example.invalid',
  SUPABASE_SERVICE_ROLE_KEY: 'sb_secret_test_fixture',
};

function fakeClients({ readiness = shadowReady, games = [game6, game9], answer, club } = {}) {
  const calls = [];
  const signedOut = [];
  let n = 0;
  const factory = () => {
    const admin = n++ === 0;
    const table = (name) => {
      const q = {
        select: () => q,
        eq: () => q,
        maybeSingle: async () => ({
          data: club ?? { id: CLUB, owner_id: PILOT.ownerId, name: PILOT.name, is_public: false },
        }),
        then: (res, rej) => Promise.resolve({ data: name === 'cash_games' ? games : [] }).then(res, rej),
      };
      return q;
    };
    return admin
      ? {
          from: table,
          rpc: async (name, args) => {
            calls.push({ who: 'service', name, args });
            return { data: { pairs: [] } };
          },
        }
      : {
          auth: {
            signInWithPassword: async () => ({ data: { user: { id: PILOT.ownerId } } }),
            signOut: async (a) => {
              signedOut.push(a);
              return {};
            },
          },
          rpc: async (name, args) => {
            calls.push({ who: 'owner', name, args });
            if (name === 'fn_lightning_rollout_readiness') return { data: readiness };
            return { data: answer ? answer(args) : { ok: true, request_id: args.p_args.request_id } };
          },
        };
  };
  return { factory, calls, signedOut };
}

test('request ids are stable per operation, cluster and action, and distinct otherwise', () => {
  const a = stageRequestId(OP, game6.id, 'enable_lightning');
  assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(a, stageRequestId(OP, game6.id, 'enable_lightning'));
  assert.notEqual(a, stageRequestId(OP, game9.id, 'enable_lightning'));
  assert.notEqual(a, stageRequestId(OP, game6.id, 'set_worker_mode'));
});

test('readiness gate accepts only the evidence each stage exists to produce', () => {
  assert.doesNotThrow(() => assertStageReadiness('shadow', shadowReady));
  assert.doesNotThrow(() => assertStageReadiness('form', { ok: true, verdict: 'go', reasons: [] }));
  for (const bad of [
    null,
    { ok: false, code: 'NOT_AUTHORIZED' },
    { ok: true, verdict: 'no_go', reasons: [] },
    { ok: true, verdict: 'insufficient_evidence' },
    { ok: true, verdict: 'insufficient_evidence', reasons: [{ code: 'OPEN_ALERTS', severity: 'evidence' }] },
    { ok: true, verdict: 'insufficient_evidence', reasons: [{ code: 'NO_AA_CALIBRATION', severity: 'blocking' }] },
  ])
    assert.throws(() => assertStageReadiness('shadow', bad));
  // Form needs the calibration Stage 1 produced.
  assert.throws(() => assertStageReadiness('form', shadowReady));
});

test('only the two named private pilot games are targets', () => {
  assert.equal(assertStageTarget(game6, CLUB).handedness, 6);
  assert.equal(assertStageTarget(game9, CLUB).handedness, 9);
  for (const patch of [
    { club_id: 'fade0000-0000-0000-0000-000000000001' },
    { name: 'NLH 1/2 Action' },
    { handedness: 9 },
    { bb: 0.05 },
    { must_move: false },
    { ruleset_snapshot: { options: { is_private: false } } },
    { closed_at: '2026-10-15T00:00:00Z' },
  ])
    assert.throws(() => assertStageTarget({ ...game6, ...patch }, CLUB));
});

test('shadow stage reads readiness, then issues the four door actions in order on both sizes', async () => {
  const { factory, calls, signedOut } = fakeClients();
  const report = await runPilotStage(env, factory);
  const door = calls.filter((c) => c.name === 'fn_lightning_operator_control');
  assert.equal(door.length, 8);
  for (const [i, game] of [game6, game9].entries()) {
    const mine = door.slice(i * 4, i * 4 + 4);
    assert.deepEqual(
      mine.map((c) => c.args.p_action),
      STAGE_ACTIONS.shadow.map(([a]) => a)
    );
    for (const c of mine) {
      assert.equal(c.who, 'owner');
      assert.equal(c.args.p_cluster_id, game.id);
      assert.equal(c.args.p_reason, env.PILOT_REASON);
      assert.equal(c.args.p_args.request_id, stageRequestId(OP, game.id, c.args.p_action));
    }
  }
  const firstDoor = calls.findIndex((c) => c.name === 'fn_lightning_operator_control');
  const firstReady = calls.findIndex((c) => c.name === 'fn_lightning_rollout_readiness');
  assert.ok(firstReady < firstDoor);
  assert.equal(report.clusters.length, 2);
  assert.deepEqual(signedOut, [{ scope: 'local' }]);
});

test('a no_go readiness stops before any door action', async () => {
  const { factory, calls } = fakeClients({ readiness: { ok: true, verdict: 'no_go', reasons: [] } });
  await assert.rejects(runPilotStage(env, factory), /No Go/);
  assert.equal(calls.filter((c) => c.name === 'fn_lightning_operator_control').length, 0);
});

test('a refused or pending door answer stops the stage at that action', async () => {
  for (const [answer, re] of [
    [() => ({ ok: false, code: 'NOT_AUTHORIZED' }), /Refused: NOT_AUTHORIZED/],
    [() => ({ ok: false, code: 'REQUEST_IN_PROGRESS' }), /Retry The Same Operation ID/],
  ]) {
    const { factory, calls } = fakeClients({ answer });
    await assert.rejects(runPilotStage(env, factory), re);
    assert.equal(calls.filter((c) => c.name === 'fn_lightning_operator_control').length, 1);
  }
});

test('a public club, a missing game or a missing operation id acts on nothing', async () => {
  const pub = fakeClients({
    club: { id: CLUB, owner_id: PILOT.ownerId, name: PILOT.name, is_public: true },
  });
  await assert.rejects(runPilotStage(env, pub.factory), /Public/);
  const missing = fakeClients({ games: [game6] });
  await assert.rejects(runPilotStage(env, missing.factory), /9-Max Game Not Uniquely Found/);
  const noop = fakeClients();
  await assert.rejects(runPilotStage({ ...env, PILOT_OPERATION_ID: '' }, noop.factory), /Operation UUID/);
  for (const f of [pub, missing, noop])
    assert.equal(f.calls.filter((c) => c.name === 'fn_lightning_operator_control').length, 0);
});

test('report stage reads only and needs no operation id', async () => {
  const { factory, calls } = fakeClients();
  const r = await runPilotStage({ ...env, PILOT_STAGE: 'report', PILOT_OPERATION_ID: '' }, factory);
  assert.equal(calls.filter((c) => c.name === 'fn_lightning_operator_control').length, 0);
  assert.ok(calls.some((c) => c.who === 'service' && c.name === 'fn_lightning_shadow_report'));
  assert.equal(r.clusters.length, 2);
});
