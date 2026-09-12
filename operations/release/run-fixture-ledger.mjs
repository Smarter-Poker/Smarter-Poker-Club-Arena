import {
  scope,
  validate,
  durable,
  missionHandState,
  recordMissionHandCleaned,
} from './run-fixture-state.mjs';
function need(ok) {
  if (!ok) throw new Error('EXACT_RUN_FIXTURE_OWNERSHIP_REQUIRED');
}
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fixtureResources } from './fixture-cleanup.mjs';
import { cleanupMissionFixtureHand, missionFixtureHandId } from './mission-fixture-hand.mjs';
import { supabaseServerHeaders } from '../../scripts/ci/supabase-auth-headers.mjs';

export async function reserveRunFixture(account, env = process.env) {
  const current = scope(env);
  const record = { version: 1, run: current.run, attempt: current.attempt, ...account };
  validate(record, current);
  await durable(current.directory, `${record.user_id}.intent.json`, record);
  if (record.label === 'missions') {
    // Both durable intents precede Auth creation, hence also the later hand insert.
    await durable(current.directory, `${record.user_id}.hand-intent.json`, {
      version: 1,
      run: current.run,
      attempt: current.attempt,
      user_id: record.user_id,
      email: record.email,
      hand_id: missionFixtureHandId(record.user_id),
      table_id: null,
      tournament_id: null,
      has_human: false,
      players: [],
      actions: [],
    });
  }
}
export async function recordRunFixtureCreated(userId, env = process.env) {
  const current = scope(env);
  const record = JSON.parse(
    await readFile(path.join(current.directory, `${userId}.intent.json`), 'utf8')
  );
  validate(record, current);
  await durable(current.directory, `${userId}.created.json`, record);
}
export async function cleanupRunFixtures({ environment = process.env, fetchImpl = fetch } = {}) {
  const current = scope(environment);
  let names;
  try {
    names = await readdir(current.directory);
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const accounts = [];
  for (const name of names.filter((name) => name.endsWith('.intent.json'))) {
    const record = JSON.parse(await readFile(path.join(current.directory, name), 'utf8'));
    validate(record, current);
    need(name === `${record.user_id}.intent.json`);
    accounts.push(record);
  }
  need(accounts.length <= 16);
  need(environment.SUPABASE_URL && environment.SUPABASE_SERVICE_ROLE_KEY);
  async function request(route, options = {}) {
    const response = await fetchImpl(environment.SUPABASE_URL.replace(/\/$/, '') + route, {
      ...options,
      redirect: 'error',
      signal: AbortSignal.timeout(20000),
      headers: supabaseServerHeaders(environment.SUPABASE_SERVICE_ROLE_KEY, {
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
      }),
    });
    if (response.status === 404 && route.startsWith('/auth/')) return null;
    need(response.ok);
    return response.status === 204 ? null : response.json();
  }
  const evidence = [];
  const failures = [];
  for (const account of accounts) {
    try {
      const found = await request(`/auth/v1/admin/users/${account.user_id}`);
      const user = found?.user ?? found;
      if (user) need(user.id === account.user_id && user.email === account.email);
      else {
        // A lost create response may still commit. Absence alone cannot resolve it.
        const created = JSON.parse(
          await readFile(path.join(current.directory, `${account.user_id}.created.json`), 'utf8')
        );
        need(JSON.stringify(created) === JSON.stringify(account));
      }
      const handState =
        account.label === 'missions' ? await missionHandState(account.user_id, environment) : null;
      const hand = handState
        ? await cleanupMissionFixtureHand(account, request, handState.resolved)
        : null;
      if (hand) await recordMissionHandCleaned(account.user_id, environment);
      if (user) {
        const result = await request('/rest/v1/rpc/cleanup_reserved_certification_account', {
          method: 'POST',
          body: JSON.stringify({ p_user_id: account.user_id }),
        });
        need(result?.success === true);
      }
      need((await request(`/auth/v1/admin/users/${account.user_id}`)) === null);
      for (const [table, column] of fixtureResources) {
        const rows = await request(
          `/rest/v1/${table}?${new URLSearchParams({ select: column, [column]: `eq.${account.user_id}`, limit: '1' })}`
        );
        need(Array.isArray(rows) && rows.length === 0);
      }
      evidence.push({
        user_id: account.user_id,
        email: account.email,
        hand,
        auth_absent: true,
        resource_checks: fixtureResources.length,
      });
    } catch (error) {
      failures.push(error);
    }
  }
  await durable(current.directory, `cleanup-${randomUUID()}.json`, {
    version: 1,
    run: current.run,
    attempt: current.attempt,
    accounts: evidence,
    complete: failures.length === 0,
    failed_accounts: failures.length,
  });
  if (failures.length)
    throw new AggregateError(failures, failures.map((error) => error.message).join('; '));
  return evidence;
}
