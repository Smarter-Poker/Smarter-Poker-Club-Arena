import assert from 'node:assert/strict';
import test from 'node:test';
import {
  serviceRoleBootstrapSql,
  assertNativeServiceRoleBoundary,
  serviceBoundaryReceipt,
  createFixtureApplicationOwner,
  assertApplicationOwnerBoundary,
  assertManagedPostgresBoundary,
} from '../../operations/release/fixture/service-role-boundary.mjs';

const boundary = {
  owned_database: true,
  application_owner_flags: true,
  managed_owner_membership: true,
  api_managed_membership_denied: true,
  realtime_bootstrap_superuser: true,
  auth_admin_boundary: true,
  authenticator_boundary: true,
  authenticator_memberships: 3,
  set_only_memberships: 3,
  extra_admin_memberships: 0,
  auth_schema_owner: true,
  auth_schema_migration_access: true,
  public_create_denied: true,
  application_schema_boundary: true,
};

test('bootstrap SQL accepts only the fixture random hex password, never a SQL fragment', () => {
  for (const bad of [
    undefined,
    '',
    'a'.repeat(63),
    'a'.repeat(65),
    "'; GRANT ALL TO PUBLIC; --",
    'g'.repeat(64),
  ]) {
    assert.throws(() => serviceRoleBootstrapSql(bad), /FIXTURE_RANDOM_DATABASE_PASSWORD_REQUIRED/);
  }
  const sql = serviceRoleBootstrapSql('a'.repeat(64));
  assert.match(sql, /supabase_auth_admin LOGIN NOINHERIT CREATEROLE/);
  assert.match(sql, /CREATE SCHEMA auth AUTHORIZATION supabase_admin/);
  assert.ok(!sql.includes('TO supabase_admin WITH ADMIN OPTION'));
});

test('managed native probe rejects a superuser before creating any probe objects', async () => {
  let calls = 0;
  await assert.rejects(
    assertManagedPostgresBoundary({
      query: async () => {
        calls++;
        return { rows: [{ owned_database: true, application_owner_boundary: false }] };
      },
    }),
    /FIXTURE_NON_SUPERUSER_APPLICATION_OWNER_REQUIRED/
  );
  assert.equal(calls, 1);
});

test('managed probe failure rolls back before verifying owned object absence', async () => {
  const calls = [];
  await assert.rejects(
    assertManagedPostgresBoundary({
      query: async (sql) => {
        calls.push(sql);
        if (sql.includes('AS application_owner_boundary'))
          return { rows: [{ owned_database: true, application_owner_boundary: true }] };
        if (sql.includes('AS managed_config')) return { rows: [{ managed_config: true }] };
        if (sql.includes('AS absent')) return { rows: [{ absent: true }] };
        if (sql.startsWith('CREATE SCHEMA')) throw new Error('probe DDL refused');
        return { rows: [] };
      },
    }),
    /probe DDL refused/
  );
  assert.equal(calls.at(-2), 'ROLLBACK');
  assert.match(calls.at(-1), /AS absent/);
});

test('managed native probe refuses a pre-existing object before starting its transaction', async () => {
  const calls = [];
  await assert.rejects(
    assertManagedPostgresBoundary({
      query: async (sql) => {
        calls.push(sql);
        if (sql.includes('AS application_owner_boundary'))
          return { rows: [{ owned_database: true, application_owner_boundary: true }] };
        if (sql.includes('AS managed_config')) return { rows: [{ managed_config: true }] };
        return { rows: [{ absent: false }] };
      },
    }),
    /FIXTURE_MANAGED_PROBE_CLEANUP_REQUIRED/
  );
  assert.ok(!calls.includes('BEGIN'));
});

test('native role proof explicitly excludes full production application privilege parity', async () => {
  const proof = await assertNativeServiceRoleBoundary({
    query: async () => ({ rows: [boundary] }),
  });
  assert.deepEqual(proof, serviceBoundaryReceipt);
  assert.equal(proof.production_application_privilege_parity, false);
});

test('an ordinary or later-created superuser cannot create the fixture application owner', async () => {
  let queries = 0;
  await assert.rejects(
    createFixtureApplicationOwner({
      query: async () => {
        queries++;
        return { rows: [{ owned_bootstrap: false }] };
      },
    }),
    /FIXTURE_INITDB_IDENTITY_REQUIRED/
  );
  assert.equal(queries, 1, 'refusal must occur before privileged DDL');
});

test('application signup refuses a restore owner that is still a superuser', async () => {
  await assert.rejects(
    assertApplicationOwnerBoundary({
      query: async () => ({
        rows: [{ owned_database: true, application_owner_boundary: false }],
      }),
    }),
    /FIXTURE_NON_SUPERUSER_APPLICATION_OWNER_REQUIRED/
  );
});

test('application owner flags alone do not certify complete application privileges', async () => {
  const result = await assertApplicationOwnerBoundary({
    query: async () => ({ rows: [{ owned_database: true, application_owner_boundary: true }] }),
  });
  assert.equal(result.superuser, false);
  assert.equal(result.complete_application_acl_parity, false);
});

for (const [field, bad] of [
  ['owned_database', false],
  ['application_owner_flags', false],
  ['managed_owner_membership', false],
  ['api_managed_membership_denied', false],
  ['realtime_bootstrap_superuser', false],
  ['auth_admin_boundary', false],
  ['authenticator_boundary', false],
  ['authenticator_memberships', 4],
  ['set_only_memberships', 2],
  ['extra_admin_memberships', 1],
  ['auth_schema_owner', false],
  ['auth_schema_migration_access', false],
  ['public_create_denied', false],
  ['application_schema_boundary', false],
]) {
  test(`native role drift refuses the service boundary: ${field}`, async () => {
    await assert.rejects(
      assertNativeServiceRoleBoundary({
        query: async () => ({ rows: [{ ...boundary, [field]: bad }] }),
      }),
      /FIXTURE_NATIVE_SERVICE_ROLE_BOUNDARY_REQUIRED/
    );
  });
}
