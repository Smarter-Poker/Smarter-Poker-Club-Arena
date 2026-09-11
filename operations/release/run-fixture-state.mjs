import { mkdir, open, readFile } from 'node:fs/promises';
import path from 'node:path';
import { missionFixtureHandId } from './mission-fixture-hand.mjs';
function need(ok) {
  if (!ok) throw new Error('EXACT_RUN_FIXTURE_OWNERSHIP_REQUIRED');
}
export function scope(env) {
  const run = env.GITHUB_RUN_ID || env.E2E_FIXTURE_RUN_ID;
  const attempt = env.GITHUB_RUN_ATTEMPT || '1';
  need(/^[a-zA-Z0-9_-]{1,80}$/.test(run || '') && /^[1-9][0-9]*$/.test(attempt));
  need(env.RUNNER_TEMP || env.E2E_FIXTURE_DIRECTORY);
  return {
    run,
    attempt,
    directory: path.join(
      env.RUNNER_TEMP || env.E2E_FIXTURE_DIRECTORY,
      'exact-run-fixtures',
      run,
      attempt
    ),
  };
}
export function validate(record, current) {
  need(record.version === 1 && record.run === current.run && record.attempt === current.attempt);
  need(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(record.user_id)
  );
  need(/^ca-customization-cert-[a-z0-9-]+@example\.invalid$/.test(record.email));
  need(/^[a-z][a-z0-9-]{0,39}$/.test(record.label));
}
export async function durable(directory, name, value) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const file = await open(path.join(directory, name), 'wx', 0o600);
  try {
    await file.writeFile(JSON.stringify(value));
    await file.sync();
  } finally {
    await file.close();
  }
  const dir = await open(directory, 'r');
  try {
    await dir.sync();
  } finally {
    await dir.close();
  }
}

export async function missionHandState(userId, env = process.env) {
  const current = scope(env);
  const account = JSON.parse(
    await readFile(path.join(current.directory, `${userId}.intent.json`), 'utf8')
  );
  validate(account, current);
  need(account.user_id === userId && account.label === 'missions');
  const intent = JSON.parse(
    await readFile(path.join(current.directory, `${userId}.hand-intent.json`), 'utf8')
  );
  need(
    intent.version === 1 &&
      intent.run === current.run &&
      intent.attempt === current.attempt &&
      intent.user_id === account.user_id &&
      intent.email === account.email &&
      intent.hand_id === missionFixtureHandId(userId) &&
      intent.table_id === null &&
      intent.tournament_id === null &&
      intent.has_human === false &&
      JSON.stringify(intent.players) === '[]' &&
      JSON.stringify(intent.actions) === '[]'
  );
  async function marker(kind) {
    try {
      const value = JSON.parse(
        await readFile(path.join(current.directory, `${userId}.hand-${kind}.json`), 'utf8')
      );
      need(JSON.stringify(value) === JSON.stringify(intent));
      return true;
    } catch (error) {
      if (error.code === 'ENOENT') return false;
      throw error;
    }
  }
  const started = await marker('started'),
    created = await marker('created'),
    cleaned = await marker('cleaned');
  need(!created || started);
  return { intent, resolved: !started || created || cleaned };
}
export async function recordMissionHandStarted(userId, env = process.env) {
  const state = await missionHandState(userId, env);
  await durable(scope(env).directory, `${userId}.hand-started.json`, state.intent);
}
export async function recordMissionHandCreated(userId, env = process.env) {
  const state = await missionHandState(userId, env);
  need(!state.resolved);
  await durable(scope(env).directory, `${userId}.hand-created.json`, state.intent);
}

export async function recordMissionHandCleaned(userId, env = process.env) {
  const state = await missionHandState(userId, env);
  try {
    await durable(scope(env).directory, `${userId}.hand-cleaned.json`, state.intent);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    await missionHandState(userId, env);
  }
}
