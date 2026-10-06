#!/usr/bin/env node

import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { supabaseServerHeaders } from './supabase-auth-headers.mjs';
import { retryTransient } from './transient-retry.mjs';
import { awaitPlatformThaw, describeThaw, freezeBudgetMs } from './platform-freeze-window.mjs';

const ACCOUNT_PREFIX = 'ca-customization-cert-postdeploy-';
const ACCOUNT_SUFFIX = '@example.invalid';
const LEGACY_DIRECT_PREFIX = 'club-create-cert-';
const LEGACY_DIRECT_SUFFIX = '@smarter-poker.invalid';
const FREE_AVATAR = '/avatars/table/free_samurai@2x.webp';
const DEFAULT_E2E_CLUB_ID = 'a41434bb-8d0c-400a-8f0d-e8b3d65afed4';
export const DEFAULT_E2E_TEMPLATE_CLUB_ID = '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3';
const PROFILE_ATTEMPTS = 24;
const STALE_ACCOUNT_AGE_MS = 40 * 60_000;
const STALE_ACCOUNT_LIMIT = 20;
const FRESH_SCHEDULE_CLAIM_RETRY_DELAYS_MS = Object.freeze([
  2_000, 4_000, 8_000, 16_000, 30_000, 60_000, 120_000, 90_000,
]);
// The exact names the guarded certification-retirement coordinator accepts.
// re-checks them, but this side refuses first so an unrecognized club is never
// even offered to it.
const CERTIFICATION_CLUB_NAME_PREFIXES = ['Crest Cert ', 'Preset Crest Cert '];

/**
 * How many separate freezes one cleanup may sit through. Section 13 schedules
 * exactly one break an hour, and the September 17 owner update allows a
 * corrected release one extra certified recovery window - so two is every
 * freeze this job can legitimately meet, and a third refusal is a defect
 * rather than the schedule.
 */
const PLATFORM_FREEZE_MAX_WAITS = 2;

/**
 * Wait for the freeze to END. Never a tick count: 0 of the 435 breaks measured
 * between 2026-09-16 and 2026-09-30 finished inside the 370s this loop used to
 * allow. `scripts/ci/platform-freeze-window.mjs` carries the whole measurement
 * and derives the budget from the break row itself.
 */
async function waitOutPlatformFreeze(configuration, fetchImpl, wait) {
  let breakRow = null;
  try {
    const rows = await serviceRequest(
      configuration,
      '/rest/v1/engine_maintenance_break' +
        '?select=phase,break_started_at,break_ends_at,enforce_freeze&limit=1',
      {},
      fetchImpl
    );
    breakRow = Array.isArray(rows) ? rows[0] || null : null;
  } catch (error) {
    // 10.86 rule 2: unreadable is not empty. Fall back to the ceiling the
    // database itself enforces, and say that is what happened.
    console.log(
      `[production-e2e-account] the maintenance break row could not be read (${error.message}); ` +
        "sizing the wait from the database's own 15 minute freeze ceiling."
    );
  }
  const result = await awaitPlatformThaw({
    isFrozen: async () =>
      (await serviceRequest(
        configuration,
        '/rest/v1/rpc/fn_platform_frozen',
        { method: 'POST', body: '{}' },
        fetchImpl
      )) === true,
    budgetMs: freezeBudgetMs(breakRow, Date.now()),
    sleep: wait,
  });
  console.log(`[production-e2e-account] ${describeThaw(result)}`);
  return result;
}

function headers(key, hasBody = false) {
  return supabaseServerHeaders(key, {
    Accept: 'application/json',
    ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
  });
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
  return (
    (email.startsWith(ACCOUNT_PREFIX) && email.endsWith(ACCOUNT_SUFFIX)) ||
    (email.startsWith(LEGACY_DIRECT_PREFIX) && email.endsWith(LEGACY_DIRECT_SUFFIX))
  );
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
    // status/code/body ride on the error so a caller can tell a slow database
    // (retry) from a guard speaking (refuse) without parsing the message.
    throw Object.assign(
      new Error(
        `Supabase service request ${init.method || 'GET'} ${path} failed (${response.status}): ` +
          JSON.stringify(body).slice(0, 400)
      ),
      {
        status: response.status,
        code: body && typeof body === 'object' ? body.code : undefined,
        body,
      }
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
  for (let freezesWaited = 0; ; ) {
    result = await serviceRequest(
      configuration,
      '/rest/v1/rpc/cleanup_reserved_certification_account',
      { method: 'POST', body: JSON.stringify({ p_user_id: account.id }) },
      fetchImpl
    );
    if (result?.success === true || result?.reason === 'auth_soft_delete_required') break;
    if (result?.reason !== 'platform_is_frozen') {
      throw new Error(
        `Guarded test-account sweep refused ${account.id}: ${String(result?.reason || 'unknown')}`
      );
    }
    if (freezesWaited >= PLATFORM_FREEZE_MAX_WAITS) {
      throw new Error(
        `Guarded test-account sweep refused ${account.id}: platform_is_frozen across ` +
          `${freezesWaited} complete freezes, which is more than section 13 schedules.`
      );
    }
    freezesWaited += 1;
    console.log('[production-e2e-account] the platform freeze is active; waiting for the thaw.');
    const thaw = await waitOutPlatformFreeze(configuration, fetchImpl, wait);
    if (thaw.outcome !== 'thawed') {
      throw new Error(
        `Guarded test-account sweep refused ${account.id}: platform_is_frozen; ` +
          describeThaw(thaw)
      );
    }
  }
  if (result?.reason === 'auth_soft_delete_required') {
    if (result.user_id !== account.id || result.email !== account.email) {
      throw new Error('Reserved ledger actor retirement did not match the owned fixture.');
    }
    // Use GoTrue's supported transaction: retain the UUID, clear credentials
    // and revoke only this disposable identity's sessions/refresh tokens.
    // An unknown response retains the fixture record; the next cleanup reads
    // the durable terminal state before deciding whether any action remains.
    await serviceRequest(
      configuration,
      `/auth/v1/admin/users/${encodeURIComponent(account.id)}`,
      { method: 'DELETE', body: JSON.stringify({ should_soft_delete: true }) },
      fetchImpl
    );
    result = await serviceRequest(
      configuration,
      '/rest/v1/rpc/cleanup_reserved_certification_account',
      { method: 'POST', body: JSON.stringify({ p_user_id: account.id }) },
      fetchImpl
    );
    if (result?.success !== true || result?.disposition !== 'retained_ledger_actor') {
      throw new Error(`Reserved ledger actor ${account.id} retirement is not verified.`);
    }
  }
  const verification = await fetchImpl(
    `${configuration.supabaseUrl}/auth/v1/admin/users/${encodeURIComponent(account.id)}`,
    { headers: headers(configuration.serviceRoleKey) }
  );
  const retained = result?.disposition === 'retained_ledger_actor';
  if (retained) {
    const body = await responseBody(verification);
    const user = body?.user || body;
    if (verification.status !== 200 || user?.id !== account.id || !user?.deleted_at) {
      throw new Error(`Reserved ledger actor ${account.id} Auth retirement is not verified.`);
    }
  } else if (verification.status !== 404) {
    const body = await responseBody(verification);
    throw new Error(
      `Reserved account ${account.id} remains after cleanup (${verification.status}): ` +
        JSON.stringify(body).slice(0, 300)
    );
  }
  if (!record && existsSync(path)) unlinkSync(path);
  console.log(
    retained
      ? '[production-e2e-account] reserved ledger actor retained; Auth retirement verified.'
      : '[production-e2e-account] reserved account hard-deleted and absence verified.'
  );
  return true;
}

/**
 * Give only the short-lived reserved certification identity enough authority
 * to open staff-only Club Arena surfaces. The account is created immediately
 * before this call and must have no membership yet: refusing an existing row
 * keeps this helper from ever changing a real player's role or balance.
 * cleanup_reserved_certification_account removes this zero-balance fixture
 * with the identity at the end of the post-deploy job.
 */
export async function prepareProductionE2EStaffMembership({
  environment = process.env,
  fetchImpl = fetch,
  requireStandalone = false,
} = {}) {
  const path = fixturePath(environment);
  const account = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
  if (!account?.id || !reserved(account.email || '')) {
    throw new Error('Refusing to prepare staff access outside the reserved post-deploy namespace.');
  }

  const configuration = requireEnvironment(environment);
  const anonKey = environment.SUPABASE_ANON_KEY || environment.VITE_SUPABASE_ANON_KEY || '';
  if (!anonKey) throw new Error('SUPABASE_ANON_KEY or VITE_SUPABASE_ANON_KEY is required.');
  const clubId = environment.E2E_CLUB_ID || DEFAULT_E2E_CLUB_ID;
  if (requireStandalone) {
    const clubs = await serviceRequest(
      configuration,
      `/rest/v1/clubs?id=eq.${encodeURIComponent(clubId)}&select=id,union_id,status`,
      {},
      fetchImpl
    );
    if (
      !Array.isArray(clubs) ||
      clubs.length !== 1 ||
      clubs[0].id !== clubId ||
      clubs[0].union_id !== null ||
      clubs[0].status !== 'active'
    ) {
      throw new Error('Template certification requires one active standalone club.');
    }
  }
  const query = new URLSearchParams({
    select: 'club_id,user_id,role,status,chip_balance',
    club_id: `eq.${clubId}`,
    user_id: `eq.${account.id}`,
  });
  const existing = await serviceRequest(
    configuration,
    `/rest/v1/club_members?${query.toString()}`,
    {},
    fetchImpl
  );
  if (!Array.isArray(existing)) {
    throw new Error('Reserved staff membership preflight returned a non-array body.');
  }
  if (existing.length > 0) {
    throw new Error(
      'Refusing to change an existing Club Arena membership for staff certification.'
    );
  }

  // Membership creation itself must go through the public join contract. The
  // database correctly rejects even service-role inserts that bypass it.
  const authResponse = await fetchImpl(
    `${configuration.supabaseUrl}/auth/v1/token?grant_type=password`,
    {
      method: 'POST',
      headers: { apikey: anonKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: account.email, password: account.password }),
    }
  );
  const session = await responseBody(authResponse);
  if (!authResponse.ok || !session?.access_token) {
    throw new Error(`Reserved staff authentication failed (${authResponse.status}).`);
  }
  const joinResponse = await fetchImpl(`${configuration.supabaseUrl}/rest/v1/rpc/fn_join_club`, {
    method: 'POST',
    headers: {
      apikey: anonKey,
      Authorization: `Bearer ${session.access_token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ p_club_id: clubId }),
  });
  const joinResult = await responseBody(joinResponse);
  if (!joinResponse.ok || joinResult?.error) {
    throw new Error(`Reserved staff public join failed (${joinResponse.status}).`);
  }

  const joined = await serviceRequest(
    configuration,
    `/rest/v1/club_members?${query.toString()}`,
    {},
    fetchImpl
  );
  const joinedRow = Array.isArray(joined) ? joined[0] : null;
  if (joined?.length !== 1 || Number(joinedRow?.chip_balance) !== 0) {
    throw new Error('Reserved staff public join did not create one zero-balance membership.');
  }

  const created = await serviceRequest(
    configuration,
    `/rest/v1/club_members?club_id=eq.${encodeURIComponent(clubId)}&user_id=eq.${encodeURIComponent(account.id)}&select=club_id,user_id,role,status,chip_balance`,
    {
      method: 'PATCH',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify({ role: 'admin', status: 'active', is_active: true }),
    },
    fetchImpl
  );
  const row = Array.isArray(created) ? created[0] : null;
  if (
    created?.length !== 1 ||
    row?.club_id !== clubId ||
    row?.user_id !== account.id ||
    row?.role !== 'admin' ||
    row?.status !== 'active' ||
    Number(row?.chip_balance) !== 0
  ) {
    throw new Error('Reserved staff membership was not created exactly as requested.');
  }
  console.log('[production-e2e-account] isolated zero-balance staff membership verified.');
  return row;
}

/** Reuse the same reserved, zero-balance public-join fixture in a standalone
 * club. A union member club correctly refuses this creation route regardless
 * of its local admin membership; never weaken that gate or mint a test club. */
export function prepareProductionE2ETemplateMembership({
  environment = process.env,
  fetchImpl = fetch,
} = {}) {
  return prepareProductionE2EStaffMembership({
    environment: {
      ...environment,
      E2E_CLUB_ID: environment.E2E_TEMPLATE_CLUB_ID || DEFAULT_E2E_TEMPLATE_CLUB_ID,
    },
    fetchImpl,
    requireStandalone: true,
  });
}

export async function cleanupStaleProductionE2EAccounts({
  environment = process.env,
  fetchImpl = fetch,
  now = Date.now(),
  wait = (milliseconds) => new Promise((done) => setTimeout(done, milliseconds)),
} = {}) {
  const configuration = requireEnvironment(environment);
  const cutoff = new Date(now - STALE_ACCOUNT_AGE_MS).toISOString();
  const accounts = await serviceRequest(
    configuration,
    '/rest/v1/rpc/fn_ca_stale_certification_accounts',
    { method: 'POST', body: JSON.stringify({ p_before: cutoff }) },
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
    // A certification run that died between creating its fixture clubs and
    // retiring them leaves an identity that still owns a club, and the guarded
    // account sweep refuses exactly that (CERTIFICATION_RETIREMENT_HAS_AUTHORITY_
    // OR_CUSTODY). Refusing is right; wedging every later certificate on it is
    // not. Retire the clubs this identity owns through the same guarded door the
    // run itself uses, THEN sweep the identity. A club that is not a recognized
    // fixture still throws here and is never retired.
    await retireProductionCreateClubFixtures({
      environment,
      fetchImpl,
      wait,
      record: account,
      reason: 'stale-cert-recovery',
    });
    await cleanupProductionE2EAccount({ environment, fetchImpl, wait, record: account });
  }
  if (accounts.length) {
    console.log(`[production-e2e-account] recovered ${accounts.length} stale account(s).`);
  }
  return accounts.length;
}

/**
 * Retire one certification club through the sanctioned door, surviving a slow
 * database. The door is idempotent (a club that is already gone answers
 * `success: true, already_gone: true`) and runs as one transaction, so a
 * statement timeout rolled it back and a replay is safe. Transient failures
 * are retried with backoff; a `success: false` refusal is definitive.
 */
const IDLE_ENGINE_RELEASE_TIMEOUT_MS = 180_000;
const IDLE_ENGINE_RELEASE_POLL_MS = 5_000;

/**
 * A brand-new club's opening cash tables are live, so the engine can take a
 * lease on an empty Main table (a horse-seating wake or a viewer) and keep it
 * while the table stays open. The fixture-only cleanup door refuses any table
 * that carries an engine lease, which is right: it never deletes a table out
 * from under an engine. Run 37099058184 left a fixture behind exactly that way.
 *
 * Close only EMPTY leased cash tables of this fixture through the owner's own
 * product door (fn_close_managed_game refuses a table with a seated player and
 * moves no chips), then wait for the engine to hand the lease back, which it
 * does when it observes the closure. The cleanup door then re-proves zero
 * activity under its own locks. Bounded; if a lease outlives the wait, the door
 * refuses as before and the run fails visibly.
 */
async function releaseIdleFixtureTableEngines({
  client,
  clubId,
  wait = (milliseconds) => new Promise((done) => setTimeout(done, milliseconds)),
  now = () => Date.now(),
}) {
  const leasedTables = async () =>
    (
      await client.query(
        `SELECT l.table_id::text AS table_id, t.status
           FROM public.engine_table_leases l
           JOIN public.tables t ON t.id=l.table_id
          WHERE t.club_id=$1::uuid AND t.tournament_id IS NULL
          ORDER BY l.table_id`,
        [clubId]
      )
    ).rows || [];
  const leased = await leasedTables();
  if (!leased.length) return 0;

  const owner = (
    await client.query('SELECT owner_id::text AS owner_id FROM public.clubs WHERE id=$1::uuid', [
      clubId,
    ])
  ).rows?.[0]?.owner_id;
  if (!owner) return 0;

  for (const { table_id: tableId, status } of leased) {
    if (['closed', 'completed', 'cancelled', 'finished'].includes(String(status).toLowerCase())) {
      continue;
    }
    await client.query('BEGIN');
    try {
      await client.query("SET LOCAL statement_timeout = '30s'");
      await client.query("SET LOCAL lock_timeout = '15s'");
      await client.query(
        `SELECT set_config('request.jwt.claims', $1::text, true),
                set_config('request.jwt.claim.sub', $2::text, true)`,
        [JSON.stringify({ sub: owner, role: 'authenticated' }), owner]
      );
      const closed = (
        await client.query("SELECT public.fn_close_managed_game('table', $1::uuid) AS result", [
          tableId,
        ])
      ).rows?.[0]?.result;
      await client.query('COMMIT');
      console.log(
        `[production-e2e-account] closed idle leased fixture table ${tableId}: ${JSON.stringify(closed)}`
      );
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // Preserve the original error.
      }
      throw error;
    }
  }

  const deadline = now() + IDLE_ENGINE_RELEASE_TIMEOUT_MS;
  let remaining = await leasedTables();
  while (remaining.length && now() < deadline) {
    await wait(IDLE_ENGINE_RELEASE_POLL_MS);
    remaining = await leasedTables();
  }
  console.log(
    `[production-e2e-account] ${leased.length} fixture table lease(s) found; ` +
      `${remaining.length} remain after closing idle tables.`
  );
  return leased.length;
}

export async function retireCertificationClubWithRetry({
  configuration,
  clubId,
  reason,
  fetchImpl = fetch,
  wait = (milliseconds) => new Promise((done) => setTimeout(done, milliseconds)),
  environment = process.env,
  databaseClientFactory,
}) {
  const retire = async () => {
    const databaseUrl = environment.DATABASE_URL || '';
    if (!databaseUrl) {
      return serviceRequest(
        configuration,
        '/rest/v1/rpc/fn_ca_retire_welcome_certification_club',
        { method: 'POST', body: JSON.stringify({ p_club_id: clubId, p_reason: reason }) },
        fetchImpl
      );
    }

    // The production service_role is intentionally capped at eight seconds.
    // A full welcome fixture owns tables, schedules and seeded treasuries, so
    // its guarded all-or-nothing retirement can legitimately take longer.
    // Function-local settings cannot extend a timer which Postgres armed when
    // the outer statement began.  The certificate therefore uses its existing
    // database credential and sends the larger bounded budget as a separate
    // statement before invoking the same service-role-only retirement door.
    const client = databaseClientFactory
      ? await databaseClientFactory(databaseUrl)
      : new (await import('pg')).Client({
          connectionString: databaseUrl,
          application_name: 'club-create-certification-retirement',
        });
    await client.connect();
    const runDoor = async () => {
      try {
        await client.query('BEGIN');
        await client.query("SET LOCAL statement_timeout = '120s'");
        await client.query("SET LOCAL lock_timeout = '15s'");
        await client.query("SET LOCAL request.jwt.claim.role = 'service_role'");
        // Retained child rows of a retired club are intentionally immutable,
        // so open the narrowly-scoped maintenance gate for this service-role
        // transaction. The cleanup RPC still proves the reserved account,
        // fixture name, zero activity and protected IDs.
        await client.query("SET LOCAL app.club_retirement_maintenance = 'on'");
        const response = await client.query(
          'SELECT public.fn_ca_retire_welcome_certification_club($1::uuid,$2::text) AS result',
          [clubId, reason]
        );
        await client.query('COMMIT');
        return response.rows?.[0]?.result;
      } catch (error) {
        try {
          await client.query('ROLLBACK');
        } catch {
          // Preserve the original error. The idempotent guarded door plus the
          // caller's readback determines whether an unknown result committed.
        }
        throw error;
      }
    };
    try {
      try {
        return await runDoor();
      } catch (error) {
        // An engine lease on an empty opening table is the one "activity" a
        // never-played fixture can carry. Hand it back through the owner's
        // close door, then let the cleanup door re-prove zero activity once.
        if (
          error?.code !== '55000' ||
          !String(error?.message || '').includes('WELCOME_CERTIFICATION_FIXTURE_HAS_ACTIVITY')
        ) {
          throw error;
        }
        const released = await releaseIdleFixtureTableEngines({ client, clubId, wait });
        if (!released) throw error;
        return await runDoor();
      }
    } finally {
      await client.end();
    }
  };
  const retirementFailureMessage = (error) => String(error?.body?.message || error?.message || '');
  const hasFreshUnmaterializedScheduleClaim = async () => {
    const items = await serviceRequest(
      configuration,
      `/rest/v1/club_welcome_package_items?club_id=eq.${encodeURIComponent(clubId)}` +
        '&retired_at=is.null&entity_kind=eq.tournament_schedule&select=entity_id&limit=10',
      {},
      fetchImpl
    );
    const scheduleIds = Array.isArray(items)
      ? items.map((item) => item.entity_id).filter(Boolean)
      : [];
    if (scheduleIds.length !== 1) return false;
    const scheduleFilter = scheduleIds.map((id) => encodeURIComponent(id)).join(',');
    const claims = await serviceRequest(
      configuration,
      `/rest/v1/tournament_schedule_spawns?schedule_id=in.(${scheduleFilter})` +
        '&tournament_id=is.null&select=id,created_at&order=created_at&limit=10',
      {},
      fetchImpl
    );
    const freshAfter = Date.now() - 5 * 60_000;
    return (
      Array.isArray(claims) &&
      claims.some(
        (claim) =>
          claim?.created_at &&
          Number.isFinite(Date.parse(claim.created_at)) &&
          Date.parse(claim.created_at) > freshAfter
      )
    );
  };
  let result;
  let freshClaimAttempt = 0;
  try {
    for (;;) {
      try {
        result = await retryTransient(retire, {
          wait,
          label: `retirement of certification club ${clubId}`,
        });
        break;
      } catch (error) {
        const freshClaimRefusal =
          error?.code === '55000' &&
          retirementFailureMessage(error) === 'WELCOME_CERTIFICATION_TOURNAMENT_LINEAGE_REFUSED';
        const retryDelay = FRESH_SCHEDULE_CLAIM_RETRY_DELAYS_MS[freshClaimAttempt];
        if (
          !freshClaimRefusal ||
          retryDelay === undefined ||
          !(await hasFreshUnmaterializedScheduleClaim())
        ) {
          throw error;
        }
        freshClaimAttempt += 1;
        console.warn(
          `[production-e2e-account] certification club ${clubId} has a fresh ` +
            `unmaterialized schedule claim; retry ${freshClaimAttempt} of ` +
            `${FRESH_SCHEDULE_CLAIM_RETRY_DELAYS_MS.length} in ${retryDelay} ms.`
        );
        await wait(retryDelay);
      }
    }
  } catch (error) {
    if (
      error?.code === '55000' &&
      [
        'WELCOME_CERTIFICATION_HAS_NONPACKAGE_GAMES',
        'WELCOME_CERTIFICATION_TOURNAMENT_LINEAGE_REFUSED',
      ].includes(retirementFailureMessage(error))
    ) {
      try {
        const items = await serviceRequest(
          configuration,
          `/rest/v1/club_welcome_package_items?club_id=eq.${encodeURIComponent(clubId)}` +
            '&retired_at=is.null&select=slot_key,entity_kind,entity_id,initial_table_id,retired_at' +
            '&order=slot_key&limit=500',
          {},
          fetchImpl
        );
        const cashGameIds = Array.isArray(items)
          ? items
              .filter((item) => item.entity_kind === 'cash_game')
              .map((item) => item.entity_id)
              .filter(Boolean)
          : [];
        const clusterFilter = cashGameIds.map((id) => encodeURIComponent(id)).join(',');
        const scheduleIds = Array.isArray(items)
          ? items
              .filter((item) => item.entity_kind === 'tournament_schedule')
              .map((item) => item.entity_id)
              .filter(Boolean)
          : [];
        const scheduleFilter = scheduleIds.map((id) => encodeURIComponent(id)).join(',');
        const [
          cashGames,
          schedules,
          clubTables,
          clusterTables,
          clubTournaments,
          scheduleTournaments,
          scheduleSpawns,
        ] = await Promise.all([
          serviceRequest(
            configuration,
            `/rest/v1/cash_games?club_id=eq.${encodeURIComponent(clubId)}` +
              '&select=id,club_id,created_by,cluster_mode,enabled,state,created_at,updated_at' +
              '&order=id&limit=500',
            {},
            fetchImpl
          ),
          serviceRequest(
            configuration,
            `/rest/v1/tournament_schedules?club_id=eq.${encodeURIComponent(clubId)}` +
              '&select=id,club_id,active,created_at,updated_at&order=id&limit=500',
            {},
            fetchImpl
          ),
          serviceRequest(
            configuration,
            `/rest/v1/tables?club_id=eq.${encodeURIComponent(clubId)}` +
              '&select=id,cluster_id,club_id,union_id,tournament_id,game_type,created_by,role,main_index,lifecycle,status,current_players,is_deleted,created_at,updated_at' +
              '&order=id&limit=500',
            {},
            fetchImpl
          ),
          serviceRequest(
            configuration,
            `/rest/v1/tables?cluster_id=in.(${clusterFilter})` +
              '&select=id,cluster_id,club_id,union_id,tournament_id,game_type,created_by,role,main_index,lifecycle,status,current_players,is_deleted,created_at,updated_at' +
              '&order=id&limit=500',
            {},
            fetchImpl
          ),
          serviceRequest(
            configuration,
            `/rest/v1/tournaments?club_id=eq.${encodeURIComponent(clubId)}` +
              '&select=id,club_id,union_id,schedule_id,status,started_at,created_at,updated_at' +
              '&order=id&limit=500',
            {},
            fetchImpl
          ),
          scheduleIds.length
            ? serviceRequest(
                configuration,
                `/rest/v1/tournaments?schedule_id=in.(${scheduleFilter})` +
                  '&select=id,club_id,union_id,schedule_id,status,started_at,created_at,updated_at' +
                  '&order=id&limit=500',
                {},
                fetchImpl
              )
            : Promise.resolve([]),
          scheduleIds.length
            ? serviceRequest(
                configuration,
                `/rest/v1/tournament_schedule_spawns?schedule_id=in.(${scheduleFilter})` +
                  '&select=id,schedule_id,spawn_key,tournament_id,created_at&order=id&limit=500',
                {},
                fetchImpl
              )
            : Promise.resolve([]),
        ]);
        const spawnTournamentIds = Array.isArray(scheduleSpawns)
          ? scheduleSpawns.map((spawn) => spawn.tournament_id).filter(Boolean)
          : [];
        const spawnTournamentFilter = spawnTournamentIds
          .map((id) => encodeURIComponent(id))
          .join(',');
        const spawnTournaments = spawnTournamentIds.length
          ? await serviceRequest(
              configuration,
              `/rest/v1/tournaments?id=in.(${spawnTournamentFilter})` +
                '&select=id,club_id,union_id,schedule_id,status,started_at,created_at,updated_at' +
                '&order=id&limit=500',
              {},
              fetchImpl
            )
          : [];
        console.error(
          '[production-e2e-account] reserved fixture graph diagnostic: ' +
            JSON.stringify({
              observedAfterRefusalAt: new Date().toISOString(),
              clubId,
              items,
              cashGames,
              schedules,
              clubTables,
              clusterTables,
              clubTournaments,
              scheduleTournaments,
              scheduleSpawns,
              spawnTournaments,
            })
        );
      } catch (diagnosticError) {
        console.error(
          `[production-e2e-account] reserved fixture graph diagnostic unavailable: ${diagnosticError.message}`
        );
      }
    }
    throw error;
  }
  if (result?.success === false) {
    throw new Error(`Certification club ${clubId} retirement was refused: ${result.error}`);
  }
  return result;
}

/**
 * Retire only clubs owned by a reserved Create A Club certificate identity.
 * The account namespace and club-name prefix are both mandatory so this door
 * can never be pointed at a player or a pre-existing club by mistake.
 *
 * Without `record` it reads the current job's fixture file. A stale-account
 * recovery passes the stale identity's own `record` explicitly; every guard
 * below applies to it unchanged.
 */
export async function retireProductionCreateClubFixtures({
  environment = process.env,
  fetchImpl = fetch,
  wait,
  record,
  reason = 'ui-cert-cleanup',
  databaseClientFactory,
} = {}) {
  const path = fixturePath(environment);
  const account = record || (existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null);
  if (!account) {
    console.log(
      '[production-e2e-account] no fixture record exists; Create Club retirement is a no-op.'
    );
    return 0;
  }
  if (!account?.id || !reserved(account.email || '')) {
    throw new Error('Refusing to retire clubs outside the reserved post-deploy namespace.');
  }
  const configuration = requireEnvironment(environment);
  const query = new URLSearchParams({
    select: 'id,name,owner_id',
    owner_id: `eq.${account.id}`,
  });
  const clubs = await serviceRequest(
    configuration,
    `/rest/v1/clubs?${query.toString()}`,
    {},
    fetchImpl
  );
  if (!Array.isArray(clubs))
    throw new Error('Create Club fixture query returned a non-array body.');
  // Validate EVERY owned club before retiring ANY, so one unrecognized club
  // refuses the whole batch instead of leaving it half retired.
  for (const club of clubs) {
    const name = String(club.name || '');
    if (
      club.owner_id !== account.id ||
      !CERTIFICATION_CLUB_NAME_PREFIXES.some((prefix) => name.startsWith(prefix))
    ) {
      throw new Error(`Refusing to retire unrecognized club ${String(club.id || 'unknown')}.`);
    }
  }
  for (const club of clubs) {
    await retireCertificationClubWithRetry({
      configuration,
      clubId: club.id,
      reason,
      fetchImpl,
      wait,
      environment,
      databaseClientFactory,
    });
  }
  const remaining = await serviceRequest(
    configuration,
    `/rest/v1/clubs?${query.toString()}`,
    {},
    fetchImpl
  );
  if (!Array.isArray(remaining) || remaining.length) {
    throw new Error(
      `Certification left ${Array.isArray(remaining) ? remaining.length : 'an unreadable number of'} owned club fixture(s) behind.`
    );
  }
  console.log(
    `[production-e2e-account] retired and verified ${clubs.length} Create Club fixture(s).`
  );
  return clubs.length;
}

export async function createProductionE2EAccount({
  environment = process.env,
  fetchImpl = fetch,
  wait = (milliseconds) => new Promise((done) => setTimeout(done, milliseconds)),
} = {}) {
  const configuration = requireEnvironment(environment);
  if (!environment.GITHUB_ENV) throw new Error('GITHUB_ENV is required to share the account.');
  // The browser and live-table lanes run concurrently. Age and zero custody
  // do not establish that another lane has finished (or stopped after timeout).
  // Creation owns only its new identity; setup-failure and workflow always()
  // cleanup retire that exact record. Recover interrupted runs explicitly after
  // verifying their terminal ownership, never by sweeping during another create.
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
  if (command === 'prepare-staff') return prepareProductionE2EStaffMembership();
  if (command === 'prepare-template-staff') return prepareProductionE2ETemplateMembership();
  if (command === 'retire-create-clubs') return retireProductionCreateClubFixtures();
  if (command === 'cleanup') return cleanupProductionE2EAccount();
  throw new Error(
    'Usage: production-e2e-account.mjs <create|prepare-staff|prepare-template-staff|retire-create-clubs|cleanup>'
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(
      `[production-e2e-account] FAILED: ${error instanceof Error ? error.message : error}`
    );
    process.exitCode = 1;
  });
}
