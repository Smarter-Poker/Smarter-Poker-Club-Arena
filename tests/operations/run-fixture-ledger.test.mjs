import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  reserveRunFixture,
  recordRunFixtureCreated,
  cleanupRunFixtures,
} from '../../operations/release/run-fixture-ledger.mjs';
import {
  missionFixtureHandId,
  cleanupMissionFixtureHand,
} from '../../operations/release/mission-fixture-hand.mjs';
import { insertMissionFixtureNotification } from '../../operations/release/mission-fixture-notification.mjs';

async function setup(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'run-fixture-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const env = {
    RUNNER_TEMP: directory,
    GITHUB_RUN_ID: '12345',
    GITHUB_RUN_ATTEMPT: '1',
    SUPABASE_URL: 'https://fixture.invalid',
    SUPABASE_SERVICE_ROLE_KEY: 'synthetic-test-only',
  };
  const account = {
    user_id: randomUUID(),
    email: `ca-customization-cert-missions-${randomUUID()}@example.invalid`,
    label: 'missions',
  };
  let auth = { ...account, id: account.user_id };
  let hand = {
    id: missionFixtureHandId(account.user_id),
    table_id: null,
    tournament_id: null,
    has_human: false,
    players: [],
    actions: [],
    daily_mission_events: [{ user_id: account.user_id, amounts: { hands_played: 1 } }],
  };
  const writes = [];
  const fetchImpl = async (url, options = {}) => {
    const parsed = new URL(url),
      route = parsed.pathname;
    if (route.startsWith('/auth/'))
      return new Response(JSON.stringify(auth), { status: auth ? 200 : 404 });
    if (options.method === 'DELETE') {
      writes.push({ url, options });
      hand = null;
      return new Response(null, { status: 204 });
    }
    if (options.method === 'POST') {
      writes.push({ url, options });
      auth = null;
      return Response.json({ success: true });
    }
    return Response.json(route === '/rest/v1/hand_history' ? (hand ? [hand] : []) : []);
  };
  return {
    env,
    account,
    fetchImpl,
    writes,
    setAuth: (value) => {
      auth = value;
    },
    setHand: (value) => {
      hand = value;
    },
  };
}

test('separate cleanup process recovers durable ownership after worker is killed', async (t) => {
  const state = await setup(t);
  const module = new URL('../../operations/release/run-fixture-ledger.mjs', import.meta.url).href;
  const child = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import {reserveRunFixture,recordRunFixtureCreated} from ${JSON.stringify(module)}; const a=JSON.parse(process.env.FIXTURE_ACCOUNT); await reserveRunFixture(a); await recordRunFixtureCreated(a.user_id); console.log('durable'); setInterval(()=>{},1000);`,
    ],
    {
      env: { ...process.env, ...state.env, FIXTURE_ACCOUNT: JSON.stringify(state.account) },
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  );
  t.after(() => child.kill('SIGKILL'));
  await once(child.stdout, 'data');
  child.kill('SIGKILL');
  await once(child, 'close');
  const result = await cleanupRunFixtures({ environment: state.env, fetchImpl: state.fetchImpl });
  assert.equal(result.length, 1);
  assert.equal(result[0].hand.absent, true);
  assert.equal(state.writes.length, 2);
  const predicate = new URL(state.writes[0].url).searchParams;
  assert.equal(predicate.get('id'), `eq.${missionFixtureHandId(state.account.user_id)}`);
  assert.equal(
    JSON.parse(predicate.get('daily_mission_events').slice(3))[0].user_id,
    state.account.user_id
  );
  assert.equal(JSON.parse(state.writes[1].options.body).p_user_id, state.account.user_id);
  // Idempotent post-cleanup absence does not create or delete anything again.
  await cleanupRunFixtures({ environment: state.env, fetchImpl: state.fetchImpl });
  assert.equal(state.writes.length, 2);
});

test('another run or attempt cannot sweep this run', async (t) => {
  const state = await setup(t);
  await reserveRunFixture(state.account, state.env);
  for (const change of [{ GITHUB_RUN_ID: '12346' }, { GITHUB_RUN_ATTEMPT: '2' }]) {
    assert.deepEqual(
      await cleanupRunFixtures({
        environment: { ...state.env, ...change },
        fetchImpl: state.fetchImpl,
      }),
      []
    );
  }
  assert.equal(state.writes.length, 0);
});

test('lost create response with absent auth remains unresolved', async (t) => {
  const state = await setup(t);
  await reserveRunFixture(state.account, state.env);
  state.setAuth(null);
  await assert.rejects(cleanupRunFixtures({ environment: state.env, fetchImpl: state.fetchImpl }));
  assert.equal(state.writes.length, 0);
});

test('live real-account marker mismatch refuses every write', async (t) => {
  const state = await setup(t);
  await reserveRunFixture(state.account, state.env);
  state.setAuth({ id: state.account.user_id, email: 'real@example.com' });
  await assert.rejects(cleanupRunFixtures({ environment: state.env, fetchImpl: state.fetchImpl }));
  assert.equal(state.writes.length, 0);
});

test('real or foreign hand is never deleted and owner is preserved', async (t) => {
  for (const patch of [
    { table_id: randomUUID() },
    { has_human: true },
    { daily_mission_events: [{ user_id: randomUUID() }] },
  ]) {
    const state = await setup(t);
    await reserveRunFixture(state.account, state.env);
    state.setHand({
      id: missionFixtureHandId(state.account.user_id),
      table_id: null,
      tournament_id: null,
      has_human: false,
      players: [],
      actions: [],
      daily_mission_events: [{ user_id: state.account.user_id }],
      ...patch,
    });
    await assert.rejects(
      cleanupRunFixtures({ environment: state.env, fetchImpl: state.fetchImpl }),
      /HAND_OWNERSHIP/
    );
    assert.equal(state.writes.length, 0);
  }
});

test('conditional hand deletion must prove final absence', async () => {
  const account = {
    user_id: randomUUID(),
    email: 'ca-customization-cert-missions-owned@example.invalid',
  };
  const row = {
    id: missionFixtureHandId(account.user_id),
    table_id: null,
    tournament_id: null,
    has_human: false,
    players: [],
    actions: [],
    daily_mission_events: [{ user_id: account.user_id }],
  };
  await assert.rejects(
    cleanupMissionFixtureHand(account, async (route) =>
      route.startsWith('/auth/') ? { id: account.user_id, email: account.email } : [row]
    ),
    /ABSENCE_REQUIRED/
  );
});

test('fixture notification inserts one exact owner and never calls global enqueue', async () => {
  const account = {
    user_id: randomUUID(),
    email: 'ca-customization-cert-missions-owned@example.invalid',
  };
  const writes = [];
  let enabled = true;
  const request = async (route, options = {}) => {
    assert.ok(!route.includes('/rpc/'));
    if (route.startsWith('/auth/')) return { id: account.user_id, email: account.email };
    if (route.includes('preferences'))
      return [{ user_id: account.user_id, daily_mission_reminders: enabled }];
    const row = JSON.parse(options.body);
    writes.push(row);
    assert.equal(row.user_id, account.user_id);
    assert.equal(options.headers.Prefer, 'resolution=ignore-duplicates,return=representation');
    return writes.length === 1 ? [row] : [];
  };
  assert.equal(await insertMissionFixtureNotification(account, '2026-09-11', request), 1);
  assert.equal(await insertMissionFixtureNotification(account, '2026-09-11', request), 0);
  assert.equal(writes[0].id, writes[1].id);
  enabled = false;
  assert.equal(await insertMissionFixtureNotification(account, '2026-09-11', request), 0);
  assert.equal(writes.length, 2);
});

test('ambiguous hand creation cannot be cleared by an empty read', async (t) => {
  const { recordMissionHandStarted } =
    await import('../../operations/release/run-fixture-state.mjs');
  const state = await setup(t);
  await reserveRunFixture(state.account, state.env);
  await recordRunFixtureCreated(state.account.user_id, state.env);
  await recordMissionHandStarted(state.account.user_id, state.env);
  state.setHand(null);
  await assert.rejects(
    cleanupRunFixtures({ environment: state.env, fetchImpl: state.fetchImpl }),
    /CREATE_UNRESOLVED/
  );
  assert.equal(state.writes.length, 0);
});

test('lost hand response with exact committed row is reconciled and remains idempotent', async (t) => {
  const { recordMissionHandStarted } =
    await import('../../operations/release/run-fixture-state.mjs');
  const state = await setup(t);
  await reserveRunFixture(state.account, state.env);
  await recordRunFixtureCreated(state.account.user_id, state.env);
  await recordMissionHandStarted(state.account.user_id, state.env);
  await cleanupRunFixtures({ environment: state.env, fetchImpl: state.fetchImpl });
  await cleanupRunFixtures({ environment: state.env, fetchImpl: state.fetchImpl });
  assert.equal(state.writes.length, 2);
});
