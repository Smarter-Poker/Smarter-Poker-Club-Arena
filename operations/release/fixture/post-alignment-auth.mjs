import assert from 'node:assert/strict';
import { fixtureAuth, assertFixtureAuthMigrations } from './auth-fixture.mjs';
import {
  assertApplicationOwnerBoundary,
  assertFixtureAuthPlatformHelpers,
  assertFixtureAuthPlatformWriteDenied,
} from './service-role-boundary.mjs';

// Attach to the existing, positively aligned estate. This module does not
// bootstrap a database, migrate, install roles, restore schema or seed money.
// The caller owns the fresh database client, services and final disposal.
export async function qualifyPostAlignmentAuth({
  db,
  heldBackendPid,
  supervisor,
  authEnvironment,
  secrets,
  roleProof,
  providerProof,
  deadlineMs = 30000,
}) {
  assert.ok(Number.isInteger(deadlineMs) && deadlineMs > 0 && deadlineMs <= 30000);
  assert.ok(Number.isInteger(heldBackendPid) && heldBackendPid > 0);
  assert.ok(
    Number.isInteger(db.processID) && db.processID > 0 && db.processID !== heldBackendPid,
    'FIXTURE_AUTH_FRESH_APPLICATION_CLIENT_REQUIRED'
  );
  assert.equal(roleProof?.scope, 'native-full-role-installer');
  assert.equal(roleProof?.status, 'passed');
  for (const key of [
    'commit_acknowledged',
    'installer_backend_absent',
    'all_driver_clients_closed',
    'graph_assertion',
    'membership_assertion',
  ])
    assert.equal(roleProof[key], true);
  assert.match(roleProof.aligned_catalog_sha256, /^[a-f0-9]{64}$/);
  assert.equal(providerProof?.scope, 'native-five-provider-semantics');
  assert.equal(providerProof?.status, 'passed');
  for (const key of ['dummy_objects_removed', 'all_probe_clients_closed', 'private_http_closed'])
    assert.equal(providerProof[key], true);
  assert.match(providerProof.build_sha256, /^[a-f0-9]{64}$/);
  assert.match(providerProof.catalog_sha256, /^[a-f0-9]{64}$/);
  // Do not accept a caller-selected service identity or arbitrary network DSN.
  const authUrl = new URL(authEnvironment.GOTRUE_DB_DATABASE_URL);
  assert.equal(authUrl.username, 'supabase_auth_admin');
  assert.equal(authUrl.hostname, '127.0.0.1');
  assert.equal(authUrl.pathname, '/club_arena_qualification');

  const deadline = performance.now() + deadlineMs;
  const abort = new AbortController();
  const signal = AbortSignal.any([abort.signal, supervisor.abort.signal]);
  const timer = setTimeout(() => {
    abort.abort();
    supervisor.fail('post-alignment-auth-deadline');
  }, deadlineMs);
  const remaining = () => {
    supervisor.assertHealthy();
    assert.equal(signal.aborted, false, 'FIXTURE_AUTH_DEADLINE');
    const milliseconds = Math.floor(deadline - performance.now());
    assert.ok(milliseconds > 0, 'FIXTURE_AUTH_DEADLINE');
    return milliseconds;
  };
  const query = async (text, values) => {
    const result = await db.query({ text, values, query_timeout: Math.min(5000, remaining()) });
    remaining();
    return result;
  };
  // Boundary helpers execute through the same bounded, owned fresh client.
  const connection = { query };
  try {
    await assertApplicationOwnerBoundary(connection);
    await assertFixtureAuthPlatformHelpers(connection);
    await assertFixtureAuthPlatformWriteDenied(connection);
    assertFixtureAuthMigrations(
      (await query('SELECT version FROM auth.schema_migrations')).rows.map((row) => row.version)
    );
    const identity = (
      await query(`SELECT current_database() AS database,
      pg_postmaster_start_time()::text AS postmaster_started_at,
      pg_backend_pid() AS backend_pid,
      (SELECT count(*)::int FROM auth.users) AS users,
      (SELECT count(*)::int FROM auth.sessions) AS sessions,
      (SELECT count(*)::int FROM auth.mfa_factors) AS factors`)
    ).rows[0];
    assert.equal(identity.database, 'club_arena_qualification');
    assert.equal(identity.backend_pid, db.processID);
    assert.ok(
      typeof identity.postmaster_started_at === 'string' &&
        Number.isFinite(Date.parse(identity.postmaster_started_at))
    );
    assert.deepEqual(
      [identity.users, identity.sessions, identity.factors],
      [0, 0, 0],
      'FIXTURE_AUTH_EMPTY_OWNED_ESTATE_REQUIRED'
    );
    await supervisor.start('auth', '/usr/local/bin/auth', ['serve'], authEnvironment);
    remaining();
    await supervisor.until(async () => {
      remaining();
      let response;
      try {
        response = await fetch('http://127.0.0.1:9999/health', {
          redirect: 'error',
          signal: AbortSignal.any([signal, AbortSignal.timeout(Math.min(1000, remaining()))]),
        });
        return response.ok;
      } catch (error) {
        remaining();
        if (error?.name === 'TimeoutError' || error?.cause?.code === 'ECONNREFUSED') return false;
        throw error;
      } finally {
        await response?.body?.cancel();
      }
    }, remaining());
    const api = fixtureAuth({
      serviceKey: secrets.serviceKey,
      jwtSecret: secrets.jwtSecret,
      signal,
    });
    const users = await api.createUsers();
    remaining();
    users[0] = await api.enrollMfa(users[0]);
    remaining();
    const sessions = (
      await query(
        `SELECT id::text, user_id::text, aal::text
      FROM auth.sessions WHERE id = ANY($1::uuid[]) ORDER BY id`,
        [users.map((user) => user.sessionId)]
      )
    ).rows;
    const expected = users
      .map((user, index) => ({
        id: user.sessionId,
        user_id: user.id,
        aal: index === 0 ? 'aal2' : 'aal1',
      }))
      .sort((left, right) => left.id.localeCompare(right.id));
    assert.deepEqual(sessions, expected, 'FIXTURE_AUTH_PERSISTED_SESSIONS_REQUIRED');
    const factors = (
      await query(`SELECT user_id::text, factor_type::text, status::text
      FROM auth.mfa_factors`)
    ).rows;
    assert.deepEqual(
      factors,
      [{ user_id: users[0].id, factor_type: 'totp', status: 'verified' }],
      'FIXTURE_AUTH_PERSISTED_MFA_REQUIRED'
    );
    const counts = (
      await query(`SELECT (SELECT count(*)::int FROM auth.users) AS users,
      (SELECT count(*)::int FROM auth.sessions) AS sessions`)
    ).rows;
    assert.deepEqual(counts, [{ users: 3, sessions: 3 }]);
    remaining();
    return {
      scope: 'native-post-alignment-auth',
      status: 'observed',
      database: identity.database,
      postmaster_started_at: identity.postmaster_started_at,
      aligned_catalog_sha256: roleProof.aligned_catalog_sha256,
      provider_build_sha256: providerProof.build_sha256,
      provider_catalog_sha256: providerProof.catalog_sha256,
      fresh_application_client: true,
      auth_role: 'supabase_auth_admin',
      genuine_users: 3,
      signed_in_sessions: 3,
      persisted_aal1_sessions: 2,
      persisted_aal2_sessions: 1,
      persisted_verified_totp_factors: 1,
      application_owner_boundary: true,
      auth_helper_boundary: true,
      genuine_migration_set: true,
      retries: 0,
      post_alignment_auth: true,
      post_alignment_services: false,
      full_schema_ready: false,
      production_or_funded: false,
    };
  } finally {
    clearTimeout(timer);
    abort.abort();
  }
}
