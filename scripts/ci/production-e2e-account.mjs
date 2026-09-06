#!/usr/bin/env node

import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const ACCOUNT_PREFIX = 'ca-customization-cert-postdeploy-';
const ACCOUNT_SUFFIX = '@example.invalid';
const FREE_AVATAR = '/avatars/table/free_samurai@2x.webp';
const PROFILE_ATTEMPTS = 24;
const STALE_ACCOUNT_AGE_MS = 40 * 60_000;
const STALE_ACCOUNT_LIMIT = 20;

function headers(key, hasBody = false) {
  return {
    apikey: key,
    ...(key.startsWith('sb_secret_') ? {} : { Authorization: `Bearer ${key}` }),
    Accept: 'application/json',
    ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
  };
}

function requireEnvironment(environment) {
  const supabaseUrl = (environment.SUPABASE_URL || '').replace(/\/$/, '');
  const serviceRoleKey = environment.SUPABASE_SERVICE_ROLE_KEY || '';
  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.');
  }
  return { supabaseUrl, serviceRoleKey };
}

function fixturePath(environment) {
  return (
    environment.E2E_TEST_ACCOUNT_FILE ||
    join(environment.RUNNER_TEMP || process.cwd(), 'club-arena-production-e2e-account.json')
  );
}

function reserved(email) {
  return email.startsWith(ACCOUNT_PREFIX) && email.endsWith(ACCOUNT_SUFFIX);
}

async function responseBody(response) {
  const text = await response.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function serviceRequest(configuration, path, init = {}, fetchImpl = fetch) {
  const response = await fetchImpl(`${configuration.supabaseUrl}${path}`, {
    ...init,
    headers: {
      ...headers(configuration.serviceRoleKey, Boolean(init.body)),
      ...(init.headers || {}),
    },
  });
  const body = await responseBody(response);
  if (!response.ok) {
    throw new Error(
      `Supabase service request ${init.method || 'GET'} ${path} failed (${response.status}): ` +
        JSON.stringify(body).slice(0, 400)
    );
  }
  return body;
}

async function waitForProfile(configuration, userId, fetchImpl, wait) {
  for (let attempt = 0; attempt < PROFILE_ATTEMPTS; attempt += 1) {
    const rows = await serviceRequest(
      configuration,
      `/rest/v1/profiles?select=id&id=eq.${encodeURIComponent(userId)}`,
      {},
      fetchImpl
    );
    if (Array.isArray(rows) && rows.some((row) => row.id === userId)) return;
    await wait(250);
  }
  throw new Error(`Temporary production E2E account ${userId} never received a profile row.`);
}

async function normalizeProfile(configuration, userId, fetchImpl) {
  await serviceRequest(
    configuration,
    `/rest/v1/profiles?id=eq.${encodeURIComponent(userId)}`,
    {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ arena_avatar_url: FREE_AVATAR }),
    },
    fetchImpl
  );
  const rows = await serviceRequest(
    configuration,
    `/rest/v1/profiles?select=id,arena_avatar_url&id=eq.${encodeURIComponent(userId)}`,
    {},
    fetchImpl
  );
  if (!Array.isArray(rows) || rows.length !== 1 || rows[0].arena_avatar_url !== FREE_AVATAR) {
    throw new Error(`Temporary production E2E account ${userId} was not normalized.`);
  }
}

export async function cleanupProductionE2EAccount({
  environment = process.env,
  fetchImpl = fetch,
  wait = (milliseconds) => new Promise((done) => setTimeout(done, milliseconds)),
  record,
} = {}) {
  const path = fixturePath(environment);
  const account = record || (existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null);
  if (!account) {
    console.log('[production-e2e-account] no fixture record exists; cleanup is a no-op.');
    return false;
  }
  if (!account.id || !reserved(account.email || '')) {
    throw new Error('Refusing to clean an account outside the reserved post-deploy namespace.');
  }

  const configuration = requireEnvironment(environment);
  let result;
  for (let attempt = 0; attempt < 37; attempt += 1) {
    result = await serviceRequest(
      configuration,
      '/rest/v1/rpc/cleanup_reserved_certification_account',
      { method: 'POST', body: JSON.stringify({ p_user_id: account.id }) },
      fetchImpl
    );
    if (result?.success === true) break;
    if (result?.reason !== 'platform_is_frozen' || attempt === 36) {
      throw new Error(
        `Guarded test-account sweep refused ${account.id}: ${String(result?.reason || 'unknown')}`
      );
    }
    console.log('[production-e2e-account] platform freeze is active; cleanup will retry.');
    await wait(10_000);
  }
  const verification = await fetchImpl(
    `${configuration.supabaseUrl}/auth/v1/admin/users/${encodeURIComponent(account.id)}`,
    { headers: headers(configuration.serviceRoleKey) }
  );
  if (verification.status !== 404) {
    const body = await responseBody(verification);
    throw new Error(
      `Reserved account ${account.id} remains after cleanup (${verification.status}): ` +
        JSON.stringify(body).slice(0, 300)
    );
  }
  if (!record && existsSync(path)) unlinkSync(path);
  console.log('[production-e2e-account] reserved account hard-deleted and absence verified.');
  return true;
}

export async function cleanupStaleProductionE2EAccounts({
  environment = process.env,
  fetchImpl = fetch,
  now = Date.now(),
} = {}) {
  const configuration = requireEnvironment(environment);
  const cutoff = new Date(now - STALE_ACCOUNT_AGE_MS).toISOString();
  const query = new URLSearchParams({
    select: 'id,email,created_at',
    email: `like.${ACCOUNT_PREFIX}*${ACCOUNT_SUFFIX}`,
    created_at: `lte.${cutoff}`,
    order: 'created_at.asc',
    limit: String(STALE_ACCOUNT_LIMIT + 1),
  });
  const accounts = await serviceRequest(
    configuration,
    `/rest/v1/profiles?${query.toString()}`,
    {},
    fetchImpl
  );
  if (!Array.isArray(accounts)) throw new Error('Stale account query returned a non-array body.');
  if (accounts.length > STALE_ACCOUNT_LIMIT) {
    throw new Error(`Refusing to clean more than ${STALE_ACCOUNT_LIMIT} stale accounts at once.`);
  }
  for (const account of accounts) {
    if (
      !account.id ||
      !reserved(account.email || '') ||
      !account.created_at ||
      Date.parse(account.created_at) > Date.parse(cutoff)
    ) {
      throw new Error('Refusing an invalid stale post-deploy account candidate.');
    }
    await cleanupProductionE2EAccount({ environment, fetchImpl, record: account });
  }
  if (accounts.length) {
    console.log(`[production-e2e-account] recovered ${accounts.length} stale account(s).`);
  }
  return accounts.length;
}

export async function createProductionE2EAccount({
  environment = process.env,
  fetchImpl = fetch,
  wait = (milliseconds) => new Promise((done) => setTimeout(done, milliseconds)),
} = {}) {
  const configuration = requireEnvironment(environment);
  if (!environment.GITHUB_ENV) throw new Error('GITHUB_ENV is required to share the account.');
  await cleanupStaleProductionE2EAccounts({ environment, fetchImpl });
  const suffix = `${Date.now()}-${randomUUID()}`;
  const email = `${ACCOUNT_PREFIX}${suffix}${ACCOUNT_SUFFIX}`;
  const password = `Ca!${randomUUID()}aA7`;
  const alias = `PostDeploy${suffix.slice(-8)}`;
  let account;

  try {
    const created = await serviceRequest(
      configuration,
      '/auth/v1/admin/users',
      {
        method: 'POST',
        body: JSON.stringify({
          email,
          password,
          email_confirm: true,
          user_metadata: {
            username: alias,
            poker_alias: alias,
            display_name: 'Post-Deploy Certification',
            full_name: 'Post-Deploy Certification',
          },
        }),
      },
      fetchImpl
    );
    const id = String(created?.id || created?.user?.id || '');
    if (!id) throw new Error('Supabase Auth created no user id for the post-deploy account.');
    account = { id, email, password, createdAt: new Date().toISOString() };
    await waitForProfile(configuration, id, fetchImpl, wait);
    await normalizeProfile(configuration, id, fetchImpl);

    const path = fixturePath(environment);
    writeFileSync(path, `${JSON.stringify(account)}\n`, { mode: 0o600 });
    process.stdout.write(`::add-mask::${email}\n::add-mask::${password}\n`);
    appendFileSync(
      environment.GITHUB_ENV,
      `SP_EMAIL=${email}\nSP_PASS=${password}\nE2E_TEST_ACCOUNT_FILE=${path}\n`
    );
    console.log('[production-e2e-account] isolated account created and normalized.');
    return account;
  } catch (error) {
    if (account) {
      try {
        await cleanupProductionE2EAccount({ environment, fetchImpl, wait, record: account });
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          `Post-deploy account setup failed and cleanup was incomplete for ${account.id}.`
        );
      }
    }
    throw error;
  }
}

async function main() {
  const command = process.argv[2];
  if (command === 'create') return createProductionE2EAccount();
  if (command === 'cleanup') return cleanupProductionE2EAccount();
  throw new Error('Usage: production-e2e-account.mjs <create|cleanup>');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(
      `[production-e2e-account] FAILED: ${error instanceof Error ? error.message : error}`
    );
    process.exitCode = 1;
  });
}
