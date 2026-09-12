import assert from 'node:assert/strict';
import test from 'node:test';
import {
  serviceRoleBootstrapSql,
  assertNativeServiceRoleBoundary,
  serviceBoundaryReceipt,
  createFixtureApplicationOwner,
} from '../../operations/release/fixture/service-role-boundary.mjs';

const boundary = {
  owned_database: true,
  bootstrap_superuser: true,
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

for (const [field, bad] of [
  ['owned_database', false],
  ['bootstrap_superuser', false],
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
