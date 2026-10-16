import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runPilotWitness } from './lightning-pilot-witness.mjs';
import { PILOT } from './prepare-lightning-private-pilot.mjs';
const SECRET = 'TEST_SECRET_MUST_NOT_ESCAPE';
const PLAYER = '0097309f-2864-4d09-b02b-56bca012a9c3';
const POOL = '0097309f-0000-4000-8000-000000000002';
const env = {
  PILOT_WITNESS_MODE: 'replay',
  PILOT_CLUSTER_ID: 'babb43f1-368e-406f-a97a-a0d5013648b2',
  PILOT_FROM: '2026-01-01T00:00:00Z',
  PILOT_TO: '2026-01-02T00:00:00Z',
  SP_EMAIL: PILOT.ownerEmail,
  SP_PASS: SECRET,
  SUPABASE_URL: 'https://example.invalid',
  SUPABASE_SERVICE_ROLE_KEY: SECRET,
};
function fixture({ id = PILOT.ownerId, consent = true, cleanupFails = false } = {}) {
  const calls = [],
    signedOut = [];
  const admin = {
    from: () => {
      const q = {
        select: () => q,
        eq: () => q,
        maybeSingle: async () => ({
          data: {
            id: PLAYER,
            club_arena_tos_accepted_at: consent ? '2026-01-01T00:00:00Z' : null,
          },
        }),
      };
      return q;
    },
  };
  const owner = {
    auth: {
      signInWithPassword: async () => ({ data: { user: { id }, session: { user: { id } } } }),
      getUser: async () => ({ data: { user: { id } } }),
      signOut: async (options) => {
        signedOut.push(options);
        return cleanupFails ? { error: true } : {};
      },
    },
  };
  return {
    calls,
    signedOut,
    createClient: (_url, key, options) => {
      calls.push({ key, options });
      return key === SECRET ? admin : owner;
    },
    collectReplayBatch: async (args) => {
      calls.push(args);
      return { status: 'known', verdict: 'batch_passed', checked: 1 };
    },
    chromium: {},
    witnessPlayer: async (args) => {
      calls.push(args);
      return { status: 'observed', cleanup: 'local_session_closed' };
    },
  };
}
test('replay uses verified service owner, supported admin fetch and local cleanup', async () => {
  const f = fixture();
  const r = await runPilotWitness(env, f);
  assert.equal(r.status, 'known');
  assert.equal(r.cleanup, 'local_session_closed');
  assert.equal(typeof f.calls[0].options.global.fetch, 'function');
  assert.deepEqual(f.signedOut, [{ scope: 'local' }]);
  assert.equal(f.calls.at(-1).maxBatch, 100);
  assert.doesNotMatch(JSON.stringify(r), new RegExp(SECRET));
});
test('invalid mode, cluster, cursor and bounds stop before client creation', async () => {
  for (const patch of [
    { PILOT_WITNESS_MODE: 'activate' },
    { PILOT_CLUSTER_ID: PLAYER },
    { PILOT_CURSOR: SECRET },
    { PILOT_BATCH: '1001' },
    { PILOT_TO: env.PILOT_FROM },
  ]) {
    const f = fixture();
    const r = await runPilotWitness({ ...env, ...patch }, f);
    assert.equal(r.status, 'unknown');
    assert.equal(f.calls.length, 0);
    assert.doesNotMatch(JSON.stringify(r), new RegExp(SECRET));
  }
});
test('wrong reporter and cleanup failure never qualify a replay', async () => {
  const wrong = fixture({ id: PLAYER });
  assert.equal((await runPilotWitness(env, wrong)).status, 'unknown');
  assert.equal(wrong.calls.length, 2);
  assert.deepEqual(wrong.signedOut, [{ scope: 'local' }]);
  const cleanup = fixture({ cleanupFails: true });
  assert.equal((await runPilotWitness(env, cleanup)).status, 'unknown');
});
test('player requires explicit pin and previously recorded consent without legal writes', async () => {
  const playerEnv = {
    ...env,
    PILOT_WITNESS_MODE: 'player',
    PILOT_PLAYER_ID: PLAYER,
    PILOT_POOL_SESSION_ID: POOL,
  };
  const f = fixture();
  const r = await runPilotWitness(playerEnv, f);
  assert.equal(r.status, 'observed');
  assert.equal(f.calls.at(-1).pin.playerId, PLAYER);
  assert.equal(f.calls.at(-1).timeoutMs, 240000);
  assert.equal(f.calls.at(-1).acceptTerms, false);
  assert.equal(f.signedOut.length, 0);
  const blocked = fixture({ consent: false });
  assert.equal((await runPilotWitness(playerEnv, blocked)).status, 'unknown');
  assert.equal(blocked.calls.length, 1);
  const missing = fixture();
  assert.equal(
    (await runPilotWitness({ ...playerEnv, PILOT_POOL_SESSION_ID: '' }, missing)).status,
    'unknown'
  );
  assert.equal(missing.calls.length, 0);
});
test('unreadable execution retains unknown and sanitizes exception with local owner cleanup', async () => {
  const f = fixture();
  f.collectReplayBatch = async () => {
    throw new Error(SECRET);
  };
  const r = await runPilotWitness(env, f);
  assert.equal(r.status, 'unknown');
  assert.equal(r.cleanup, 'local_session_closed');
  assert.doesNotMatch(JSON.stringify(r), new RegExp(SECRET));
});
test('manual witness stays bounded, main-only and installs browser only for player', () => {
  const workflow = readFileSync(
    new URL('../../.github/workflows/lightning-pilot-witness.yml', import.meta.url),
    'utf8'
  );
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /accept_player_terms:[\s\S]*?type: boolean\s+default: false/);
  assert.match(workflow, /PILOT_ACCEPT_PLAYER_TERMS: \$\{\{ inputs\.accept_player_terms \}\}/);
  assert.doesNotMatch(workflow, /schedule:|cron:/);
  assert.match(workflow, /if: github.ref == 'refs\/heads\/main'/);
  assert.match(workflow, /timeout-minutes: 15/);
  assert.match(workflow, /if: inputs.mode != 'replay'/);
  assert.match(
    workflow,
    /PILOT_SECOND_POOL_SESSION_ID: \$\{\{ inputs\.second_pool_session_id \}\}/
  );
  assert.match(workflow, /if: always\(\)/);
});

test('only explicit consent for the exact authorized player may reach the normal UI without prior acceptance', async () => {
  const playerEnv = {
    ...env,
    PILOT_WITNESS_MODE: 'player',
    PILOT_PLAYER_ID: PLAYER,
    PILOT_POOL_SESSION_ID: POOL,
    PILOT_ACCEPT_PLAYER_TERMS: 'true',
  };
  const f = fixture({ consent: false });
  assert.equal((await runPilotWitness(playerEnv, f)).status, 'observed');
  assert.equal(f.calls.at(-1).acceptTerms, true);
  for (const patch of [
    { PILOT_WITNESS_MODE: 'replay' },
    { PILOT_PLAYER_ID: POOL },
    { PILOT_ACCEPT_PLAYER_TERMS: 'yes' },
  ]) {
    const blocked = fixture({ consent: false });
    assert.equal((await runPilotWitness({ ...playerEnv, ...patch }, blocked)).status, 'unknown');
    assert.equal(blocked.calls.length, 0);
  }
});

for (const mode of ['cycle', 'recovery'])
  test(`${mode} uses exact existing pins without passing consent opt-in`, async () => {
    const f = fixture();
    const selected = [];
    f.WebSocket = {};
    f.witnessCycle = async (args) => {
      selected.push(args);
      return { status: 'observed', cleanup: 'local_session_closed' };
    };
    f.witnessRecovery = async (args) => {
      selected.push(args);
      return { status: 'observed', cleanup: 'local_sessions_and_browser_closed' };
    };
    const args = {
      ...env,
      PILOT_WITNESS_MODE: mode,
      PILOT_PLAYER_ID: PLAYER,
      PILOT_POOL_SESSION_ID: POOL,
      PILOT_SECOND_POOL_SESSION_ID: '0097309f-0000-4000-8000-000000000003',
    };
    assert.equal((await runPilotWitness(args, f)).status, 'observed');
    assert.equal(selected[0].acceptTerms, undefined);
    if (mode === 'cycle') {
      assert.equal(selected[0].timebank, true);
      assert.equal(selected[0].preaction, true);
    }
    const expectedCleanup =
      mode === 'recovery' ? 'local_sessions_and_browser_closed' : 'local_session_closed';
    assert.equal((await runPilotWitness(args, f)).cleanup, expectedCleanup);
    const badCleanup = fixture();
    badCleanup.chromium = {};
    badCleanup.WebSocket = {};
    badCleanup.witnessCycle = async () => ({ status: 'observed', cleanup: 'unknown' });
    badCleanup.witnessRecovery = async () => ({
      status: 'observed',
      cleanup: 'local_session_closed',
    });
    assert.equal((await runPilotWitness(args, badCleanup)).status, 'unknown');
    assert.equal(selected[0].timeoutMs, 240000);
    if (mode === 'recovery') {
      assert.equal(selected[0].pins[0].poolSessionId, POOL);
      assert.equal(selected[0].pins[1].poolSessionId, args.PILOT_SECOND_POOL_SESSION_ID);
      assert.notEqual(selected[0].pins[0].clusterId, selected[0].pins[1].clusterId);
    }
    for (const patch of [
      { PILOT_ACCEPT_PLAYER_TERMS: 'true' },
      ...(mode === 'recovery'
        ? [
            { PILOT_SECOND_POOL_SESSION_ID: '' },
            { PILOT_SECOND_POOL_SESSION_ID: POOL },
            { PILOT_PLAYER_ID: POOL },
          ]
        : []),
    ]) {
      const blocked = fixture();
      assert.equal((await runPilotWitness({ ...args, ...patch }, blocked)).status, 'unknown');
      assert.equal(blocked.calls.length, 0);
    }
    const unaccepted = fixture({ consent: false });
    assert.equal((await runPilotWitness(args, unaccepted)).status, 'unknown');
    assert.equal(unaccepted.calls.length, 1);
  });
test('manual witness stays within GitHub ten-input limit', () => {
  const workflow = readFileSync(
    new URL('../../.github/workflows/lightning-pilot-witness.yml', import.meta.url),
    'utf8'
  );
  const inputBlock = workflow.slice(
    workflow.indexOf('    inputs:'),
    workflow.indexOf('permissions:')
  );
  assert.equal([...inputBlock.matchAll(/^      [a-z_]+:/gm)].length, 10);
});

test('latency preserves partial observations and real counts without asserting qualification', async () => {
  const args = {
    ...env,
    PILOT_WITNESS_MODE: 'latency',
    PILOT_PLAYER_ID: PLAYER,
    PILOT_POOL_SESSION_ID: POOL,
  };
  const f = fixture();
  let received;
  f.witnessLatencyWorkload = async (a) => {
    received = a;
    return {
      status: 'partial_observed',
      cleanup: 'local_session_and_browser_closed',
      counts: { accepted: 3, refused: 2, unknown: 1 },
      qualification: 'not_asserted',
    };
  };
  const r = await runPilotWitness(args, f);
  assert.equal(r.status, 'partial_observed');
  assert.equal(r.qualification, 'not_asserted');
  assert.deepEqual(r.result.counts, { accepted: 3, refused: 2, unknown: 1 });
  assert.equal(received.acceptTerms, undefined);
  assert.equal(received.timeoutMs, 240000);
  for (const patch of [{ PILOT_ACCEPT_PLAYER_TERMS: 'true' }, { PILOT_PLAYER_ID: POOL }]) {
    const blocked = fixture();
    assert.equal((await runPilotWitness({ ...args, ...patch }, blocked)).status, 'unknown');
    assert.equal(blocked.calls.length, 0);
  }
  for (const result of [
    { status: 'partial_observed', cleanup: 'unknown', counts: { accepted: 3 } },
    { status: 'partial_observed', cleanup: 'local_session_closed', counts: { accepted: 3 } },
    { status: 'unknown', cleanup: 'local_session_and_browser_closed', counts: { accepted: 3 } },
    {
      status: 'partial_observed',
      cleanup: 'local_session_and_browser_closed',
      counts: { accepted: 0 },
    },
  ]) {
    const bad = fixture();
    bad.witnessLatencyWorkload = async () => result;
    assert.equal((await runPilotWitness(args, bad)).status, 'unknown');
  }
  const absent = fixture({ consent: false });
  assert.equal((await runPilotWitness(args, absent)).status, 'unknown');
  assert.equal(absent.calls.length, 1);
});
