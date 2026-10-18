import test from 'node:test';
import { readFileSync } from 'node:fs';
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

test('the workflow keeps off as a string choice under GitHub YAML boolean parsing', () => {
  const workflow = readFileSync(
    new URL('../../.github/workflows/lightning-pilot-stage.yml', import.meta.url),
    'utf8'
  );
  assert.match(workflow, /options:\s*\[[^\]]*['"]off['"][^\]]*\]/);
});

const OP = '3f0a8f8e-5d2b-4c1e-9a7b-2f6d1c0e4b11';
const game6 = {
  id: 'babb43f1-368e-406f-a97a-a0d5013648b2',
  club_id: CLUB,
  name: 'Lightning Pilot NLH Action 6',
  template_name: 'action',
  variant: 'nlh',
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
  name: 'Lightning Pilot NLH Madness 6',
  template_name: 'madness',
  handedness: 6,
  sb: 0.02,
  bb: 0.04,
};
const shadowReady = {
  ok: true,
  verdict: 'insufficient_evidence',
  reasons: [
    { code: 'NO_AA_CALIBRATION', severity: 'evidence' },
    { code: 'NO_LATENCY_EVIDENCE', severity: 'evidence' },
    { code: 'WORKER_SHADOW_ONLY', severity: 'evidence' },
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

function fakeClients({
  readiness = shadowReady,
  games = [game6, game9],
  answer,
  club,
  signals = [],
} = {}) {
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
        then: (res, rej) =>
          Promise.resolve({ data: name === 'cash_games' ? games : [] }).then(res, rej),
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
            if (name === 'fn_lightning_operator_cluster')
              return {
                data: { ok: true, cluster_id: args.p_cluster_id, integrity_signals: signals },
              };
            if (name === 'fn_lightning_operator_signal_review')
              return { data: { ok: true, signal_id: args.p_signal_id, status: args.p_status } };
            if (name === 'fn_lightning_rollout_readiness') return { data: readiness };
            return {
              data: answer ? answer(args) : { ok: true, request_id: args.p_args.request_id },
            };
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
    {
      ok: true,
      verdict: 'insufficient_evidence',
      reasons: [{ code: 'OPEN_ALERTS', severity: 'evidence' }],
    },
    {
      ok: true,
      verdict: 'insufficient_evidence',
      reasons: [{ code: 'NO_AA_CALIBRATION', severity: 'blocking' }],
    },
  ])
    assert.throws(() => assertStageReadiness('shadow', bad));
  // Form needs the calibration Stage 1 produced.
  assert.throws(() => assertStageReadiness('form', shadowReady));
});

test('only the two named private pilot games are targets', () => {
  assert.equal(assertStageTarget(game6, CLUB).handedness, 6);
  assert.equal(assertStageTarget(game9, CLUB).handedness, 6);
  // The replaced nine-seat Madness is no longer a stage target.
  assert.throws(() =>
    assertStageTarget({ ...game9, name: 'Lightning Pilot NLH Madness 9', handedness: 9 }, CLUB)
  );
  for (const patch of [
    { club_id: 'fade0000-0000-0000-0000-000000000001' },
    { name: 'NLH 1/2 Action' },
    { handedness: 9 },
    { bb: 0.05 },
    { template_name: 'classic' },
    { variant: 'plo4' },
    { must_move: false },
    { ruleset_snapshot: { options: { is_private: false } } },
    { closed_at: '2026-10-15T00:00:00Z' },
  ])
    assert.throws(() => assertStageTarget({ ...game6, ...patch }, CLUB));
});

test('shadow stage prepares every size, reads readiness on every size, then enables', async () => {
  const { factory, calls, signedOut } = fakeClients();
  const report = await runPilotStage(env, factory);
  const door = calls.filter((c) => c.name === 'fn_lightning_operator_control');
  assert.equal(door.length, 8);
  const seq = calls
    .filter(
      (c) =>
        c.name === 'fn_lightning_operator_control' || c.name === 'fn_lightning_rollout_readiness'
    )
    .map(
      (c) =>
        `${c.name === 'fn_lightning_rollout_readiness' ? 'ready' : c.args.p_action}:${c.args.p_cluster_id === game6.id ? 6 : 9}`
    );
  assert.deepEqual(seq.slice(0, 8), [
    'set_flag:6',
    'set_matcher_version:6',
    'set_worker_mode:6',
    'set_flag:9',
    'set_matcher_version:9',
    'set_worker_mode:9',
    'ready:6',
    'ready:9',
  ]);
  assert.deepEqual(seq.slice(8, 10), ['enable_lightning:6', 'enable_lightning:9']);
  for (const c of door) {
    assert.equal(c.who, 'owner');
    assert.equal(c.args.p_reason, env.PILOT_REASON);
    assert.equal(
      c.args.p_args.request_id,
      stageRequestId(OP, c.args.p_cluster_id, c.args.p_action)
    );
  }
  assert.deepEqual(
    door.filter((c) => c.args.p_cluster_id === game6.id).map((c) => c.args.p_action),
    STAGE_ACTIONS.shadow.map(([a]) => a)
  );
  assert.equal(report.clusters.length, 2);
  assert.deepEqual(signedOut, [{ scope: 'local' }]);
});

test('a no_go readiness after preparation stops before any enable', async () => {
  const { factory, calls } = fakeClients({
    readiness: { ok: true, verdict: 'no_go', reasons: [] },
  });
  await assert.rejects(runPilotStage(env, factory), /No Go/);
  const door = calls.filter((c) => c.name === 'fn_lightning_operator_control');
  assert.equal(door.filter((c) => c.args.p_action === 'enable_lightning').length, 0);
  assert.ok(
    door.every((c) =>
      ['set_flag', 'set_matcher_version', 'set_worker_mode'].includes(c.args.p_action)
    )
  );
});

test('a worker still off after preparation is not accepted for Stage 1', () => {
  assert.throws(() =>
    assertStageReadiness('shadow', {
      ok: true,
      verdict: 'insufficient_evidence',
      reasons: [{ code: 'WORKER_OFF', severity: 'evidence' }],
    })
  );
});

test('form gates on readiness before switching the worker', async () => {
  const { factory, calls } = fakeClients({ readiness: shadowReady });
  await assert.rejects(
    runPilotStage({ ...env, PILOT_STAGE: 'form' }, factory),
    /Does Not Accept: NO_AA_CALIBRATION/
  );
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
  await assert.rejects(runPilotStage(env, missing.factory), /Madness 6 Game Not Uniquely Found/);
  const noop = fakeClients();
  await assert.rejects(
    runPilotStage({ ...env, PILOT_OPERATION_ID: '' }, noop.factory),
    /Operation UUID/
  );
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

test('one explicit rehearsal control uses the audited door without enabling or forming', async () => {
  for (const action of [
    'pause',
    'resume',
    'disable_joins',
    'enable_joins',
    'freeze',
    'unfreeze',
    'rollback_matcher_version',
  ]) {
    const f = fakeClients({ readiness: { ok: true, verdict: 'no_go', reasons: [] } });
    const r = await runPilotStage(
      { ...env, PILOT_STAGE: 'control', PILOT_CONTROL_ACTION: action },
      f.factory
    );
    const calls = f.calls.filter((c) => c.name === 'fn_lightning_operator_control');
    assert.equal(calls.length, 2);
    assert.ok(calls.every((c) => c.args.p_action === action));
    assert.equal(r.clusters.length, 2);
    assert.deepEqual(f.signedOut, [{ scope: 'local' }]);
  }
});
test('a control dispatch refuses activation, unknown actions and missing reason before login', async () => {
  for (const action of ['enable_lightning', 'set_worker_mode', 'drain', 'unknown', '']) {
    const f = fakeClients();
    await assert.rejects(
      runPilotStage({ ...env, PILOT_STAGE: 'control', PILOT_CONTROL_ACTION: action }, f.factory)
    );
    assert.equal(f.calls.length, 0);
  }
});

test('explicit signal review uses the authenticated review door after scoped readback', async () => {
  const signal = {
    evidence: { latest_window_end: '2026-10-15T20:20:00Z' },
    id: 1,
    pattern_type: 'TIMING_CORRELATION',
    source: 'engine',
    severity: 'high',
    status: 'open',
  };
  const f = fakeClients({
    signals: [signal],
    games: [{ ...game6, cluster_mode: 'must_move', lightning_enabled: false }],
  });
  const r = await runPilotStage(
    { ...env, PILOT_STAGE: 'review', PILOT_TARGETS: '6', PILOT_SIGNAL_ID: '1' },
    f.factory
  );
  const reviews = f.calls.filter((c) => c.name === 'fn_lightning_operator_signal_review');
  assert.equal(reviews.length, 1);
  assert.equal(reviews[0].who, 'owner');
  assert.equal(reviews[0].args.p_status, 'reviewed');
  assert.match(reviews[0].args.p_note, new RegExp(OP));
  assert.equal(r.clusters[0].signalBefore.id, 1);
  assert.equal(f.calls.filter((c) => c.name === 'fn_lightning_operator_control').length, 0);
  assert.ok(
    f.calls.findIndex((c) => c.name === 'fn_lightning_operator_cluster') <
      f.calls.findIndex((c) => c.name === 'fn_lightning_operator_signal_review')
  );
});
test('review refuses another finding, missing evidence and ambiguous target before a write', async () => {
  for (const patch of [
    {},
    { id: 1, pattern_type: 'CHIP_FLOW', source: 'scan', severity: 'high', status: 'open' },
    {
      id: 1,
      pattern_type: 'TIMING_CORRELATION',
      source: 'engine',
      severity: 'high',
      status: 'cleared',
    },
  ]) {
    const f = fakeClients({ signals: [patch] });
    await assert.rejects(
      runPilotStage(
        { ...env, PILOT_STAGE: 'review', PILOT_TARGETS: '6', PILOT_SIGNAL_ID: '1' },
        f.factory
      )
    );
    assert.equal(f.calls.filter((c) => c.name === 'fn_lightning_operator_signal_review').length, 0);
  }
  const f = fakeClients();
  await assert.rejects(
    runPilotStage(
      { ...env, PILOT_STAGE: 'review', PILOT_TARGETS: '6,9', PILOT_SIGNAL_ID: '1' },
      f.factory
    )
  );
  assert.equal(f.calls.length, 0);
});

test('off is one explicit worker-off action and remains available on no_go', async () => {
  const f = fakeClients({ readiness: { ok: true, verdict: 'no_go', reasons: [] } });
  await runPilotStage({ ...env, PILOT_STAGE: 'off' }, f.factory);
  const calls = f.calls.filter((c) => c.name === 'fn_lightning_operator_control');
  assert.equal(calls.length, 2);
  assert.ok(
    calls.every((c) => c.args.p_action === 'set_worker_mode' && c.args.p_args.mode === 'off')
  );
});

test('access dispatch reaches the observer with the validated private targets and stable operation', async () => {
  const f = fakeClients();
  let captured;
  const r = await runPilotStage({ ...env, PILOT_STAGE: 'access' }, f.factory, async (args) => {
    captured = args;
    return { verdict: 'passed', scope: 'test_only' };
  });
  assert.equal(captured.acceptOutsiderTerms, false);
  assert.deepEqual(captured.games, [game6, game9]);
  assert.equal(captured.operationId, OP);
  assert.equal(captured.requestId, stageRequestId(OP, CLUB, 'pending_access_proof'));
  assert.equal(r.access.verdict, 'passed');
  assert.equal(f.calls.filter((c) => c.name === 'fn_lightning_operator_control').length, 0);
  assert.deepEqual(f.signedOut, [{ scope: 'local' }]);
});

test('consent opt-in reaches access only and workflow defaults false', async () => {
  const workflow = readFileSync(
    new URL('../../.github/workflows/lightning-pilot-stage.yml', import.meta.url),
    'utf8'
  );
  assert.match(workflow, /accept_outsider_terms:[\s\S]*?type: boolean\s+default: false/);
  assert.match(workflow, /PILOT_ACCEPT_OUTSIDER_TERMS: \$\{\{ inputs\.accept_outsider_terms \}\}/);
  const f = fakeClients();
  let captured;
  await runPilotStage(
    { ...env, PILOT_STAGE: 'access', PILOT_ACCEPT_OUTSIDER_TERMS: 'true' },
    f.factory,
    async (args) => {
      captured = args;
      return { verdict: 'passed' };
    }
  );
  assert.equal(captured.acceptOutsiderTerms, true);
  for (const patch of [
    { PILOT_STAGE: 'form', PILOT_ACCEPT_OUTSIDER_TERMS: 'true' },
    { PILOT_STAGE: 'access', PILOT_ACCEPT_OUTSIDER_TERMS: 'yes' },
  ]) {
    await assert.rejects(runPilotStage({ ...env, ...patch }, f.factory), /Explicit Access Stage/);
  }
});

test('targets are chosen by template, and the old 6 and 9 inputs still name Action and Madness', async () => {
  for (const [targets, expected] of [
    [undefined, ['action', 'madness']],
    ['madness', ['madness']],
    ['9', ['madness']],
    ['6,9', ['action', 'madness']],
    ['action,6', ['action']],
  ]) {
    const c = fakeClients();
    const report = await runPilotStage(
      { ...env, PILOT_STAGE: 'report', PILOT_TARGETS: targets },
      c.factory
    );
    assert.deepEqual(
      report.clusters.map((x) => [x.template, x.handedness]),
      expected.map((t) => [t, 6])
    );
  }
  await assert.rejects(
    runPilotStage(
      { ...env, PILOT_STAGE: 'report', PILOT_TARGETS: 'classic' },
      fakeClients().factory
    ),
    /No Pilot Target Selected/
  );
});

const measuredSignal = {
  id: 8,
  pattern_type: 'TIMING_CORRELATION',
  source: 'engine',
  severity: 'high',
  status: 'open',
  player_a: '07db1c71-d567-46dd-8f92-e922b6d470ae',
  player_b: '285055c6-96a7-4a60-9033-51f83f49dbcb',
  evidence: {
    latest_window_end: '2026-10-17T19:27:00+00:00',
    correlation_method: 'pooled_paired_hand_moments',
    correlation_hands: 32,
    latency_corr: 0.7681,
    hands_together: 39,
    fast_follows: 6,
  },
};
const measuredGame = {
  ...game6,
  id: '56d5d6f0-23e9-41b0-b407-852aa1026c2a',
  cluster_mode: 'lightning',
  lightning_enabled: true,
};
test('the separately investigated measured finding can be reviewed without clearing it or changing play', async () => {
  const f = fakeClients({ signals: [measuredSignal], games: [measuredGame] });
  await runPilotStage(
    { ...env, PILOT_STAGE: 'review', PILOT_TARGETS: 'action', PILOT_SIGNAL_ID: '8' },
    f.factory
  );
  const writes = f.calls.filter((c) => c.name === 'fn_lightning_operator_signal_review');
  assert.equal(writes.length, 1);
  assert.equal(writes[0].args.p_status, 'reviewed');
  assert.equal(f.calls.filter((c) => c.name === 'fn_lightning_operator_control').length, 0);
});
test('measured review refuses changed evidence, another pair, another cluster and an uninvestigated ID', async () => {
  for (const [signal, game, id] of [
    [
      { ...measuredSignal, evidence: { ...measuredSignal.evidence, correlation_hands: 33 } },
      measuredGame,
      '8',
    ],
    [
      { ...measuredSignal, evidence: { ...measuredSignal.evidence, latency_corr: 0.8 } },
      measuredGame,
      '8',
    ],
    [{ ...measuredSignal, player_a: OP }, measuredGame, '8'],
    [measuredSignal, game6, '8'],
    [{ ...measuredSignal, id: 9 }, measuredGame, '9'],
  ]) {
    const f = fakeClients({ signals: [signal], games: [game] });
    await assert.rejects(
      runPilotStage(
        { ...env, PILOT_STAGE: 'review', PILOT_TARGETS: 'action', PILOT_SIGNAL_ID: id },
        f.factory
      )
    );
    assert.equal(f.calls.filter((c) => c.name === 'fn_lightning_operator_signal_review').length, 0);
  }
});
