import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runPilotWitness } from './lightning-pilot-witness.mjs';
import { PILOT } from './prepare-lightning-private-pilot.mjs';
const SECRET = 'TEST_SECRET_MUST_NOT_ESCAPE';
const PLAYER = '0097309f-0000-4000-8000-000000000001';
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
  assert.doesNotMatch(workflow, /schedule:|cron:/);
  assert.match(workflow, /if: github.ref == 'refs\/heads\/main'/);
  assert.match(workflow, /timeout-minutes: 15/);
  assert.match(workflow, /if: inputs.mode == 'player'/);
  assert.match(workflow, /if: always\(\)/);
});
