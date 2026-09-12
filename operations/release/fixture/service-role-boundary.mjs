import assert from 'node:assert/strict';

// Realtime's pinned PG17 dump uses GRANTED BY supabase_admin. PostgreSQL
// reserves implicit role administration for the initdb bootstrap identity;
// creating another SUPERUSER with that name is not equivalent.
export async function createFixtureApplicationOwner(db) {
  const identity = await db.query(`SELECT current_database()='postgres'
    AND inet_server_addr() IS NULL AND current_user='supabase_admin'
    AND session_user='supabase_admin'
    AND EXISTS(SELECT 1 FROM pg_roles WHERE rolname=current_user AND oid=10 AND rolsuper)
    AS owned_bootstrap`);
  assert.deepEqual(identity.rows, [{ owned_bootstrap: true }], 'FIXTURE_INITDB_IDENTITY_REQUIRED');
  // This local owner is still privileged for schema restoration. Its later
  // application demotion and effective ACL proof remain a separate gate.
  await db.query('CREATE ROLE postgres LOGIN SUPERUSER CREATEDB CREATEROLE REPLICATION BYPASSRLS');
}

// Local bootstrap only. These credentials are random per disposable fixture,
// never obtained from production. Keep the two native entrypoints identical.
export function serviceRoleBootstrapSql(password) {
  assert.ok(
    typeof password === 'string' && /^[a-f0-9]{64}$/.test(password),
    'FIXTURE_RANDOM_DATABASE_PASSWORD_REQUIRED'
  );
  return `CREATE ROLE anon NOLOGIN NOBYPASSRLS;
    CREATE ROLE authenticated NOLOGIN NOBYPASSRLS;
    CREATE ROLE service_role NOLOGIN BYPASSRLS;
    CREATE ROLE authenticator LOGIN NOINHERIT PASSWORD '${password}';
    GRANT anon, authenticated, service_role TO authenticator;
    CREATE ROLE supabase_auth_admin LOGIN NOINHERIT CREATEROLE PASSWORD '${password}';
    ALTER ROLE supabase_admin PASSWORD '${password}';
    CREATE ROLE dashboard_user NOLOGIN;
    CREATE SCHEMA auth AUTHORIZATION supabase_admin;
    GRANT USAGE, CREATE ON SCHEMA auth TO supabase_auth_admin, dashboard_user;
    GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role, postgres;
    ALTER ROLE supabase_auth_admin SET search_path TO auth;
    GRANT CREATE ON DATABASE club_arena_qualification TO supabase_auth_admin;
    CREATE SCHEMA _realtime AUTHORIZATION supabase_admin;`;
}

export const serviceBoundaryReceipt = Object.freeze({
  auth_admin_inheritance: 'disabled',
  authenticator_membership: 'set-without-inherit',
  auth_schema_owner: 'supabase_admin',
  auth_schema_create: 'auth-admin-only-among-application-callers',
  bootstrap_postgres: 'local-superuser',
  initdb_identity: 'supabase_admin',
  production_application_privilege_parity: false,
});

// This must run after the reviewed application schema and before any signup.
// The source composer owns demotion and grants. The runtime must refuse an
// unchanged privileged restore owner, never silently change its authority.
export async function assertApplicationOwnerBoundary(db) {
  const result = await db.query(`SELECT current_database()='club_arena_qualification'
    AND inet_server_addr() IS NULL AND current_user='postgres' AND session_user='postgres'
    AS owned_database,
    (SELECT rolcanlogin AND rolinherit AND rolbypassrls AND rolcreaterole AND NOT rolsuper
      FROM pg_roles WHERE rolname='postgres') AS application_owner_boundary`);
  assert.deepEqual(
    result.rows,
    [{ owned_database: true, application_owner_boundary: true }],
    'FIXTURE_NON_SUPERUSER_APPLICATION_OWNER_REQUIRED'
  );
  return {
    role: 'postgres',
    superuser: false,
    bypassrls: true,
    inherit: true,
    login: true,
    createrole: true,
    complete_application_acl_parity: false,
  };
}

/** Native migrated readback, not an assertion about the full application role graph. */
export async function assertNativeServiceRoleBoundary(db) {
  const result = await db.query(`SELECT
    current_database()='club_arena_qualification' AND inet_server_addr() IS NULL
      AND current_user='postgres' AS owned_database,
    (SELECT rolsuper FROM pg_roles WHERE rolname='postgres') AS bootstrap_superuser,
    (SELECT oid=10 AND rolcanlogin AND rolsuper AND rolinherit FROM pg_roles WHERE rolname='supabase_admin') AS realtime_bootstrap_superuser,
    (SELECT rolcanlogin AND NOT rolinherit AND NOT rolsuper AND NOT rolbypassrls AND rolcreaterole
      FROM pg_roles WHERE rolname='supabase_auth_admin') AS auth_admin_boundary,
    (SELECT rolcanlogin AND NOT rolinherit AND NOT rolsuper AND NOT rolbypassrls AND NOT rolcreaterole
      FROM pg_roles WHERE rolname='authenticator') AS authenticator_boundary,
    (SELECT count(*)::int FROM pg_auth_members m JOIN pg_roles parent ON parent.oid=m.roleid
      JOIN pg_roles member ON member.oid=m.member
      WHERE member.rolname='authenticator') AS authenticator_memberships,
    (SELECT count(*)::int FROM pg_auth_members m JOIN pg_roles parent ON parent.oid=m.roleid
      JOIN pg_roles member ON member.oid=m.member WHERE member.rolname='authenticator'
        AND parent.rolname IN ('anon','authenticated','service_role')
        AND m.set_option AND NOT m.inherit_option AND NOT m.admin_option) AS set_only_memberships,
    (SELECT count(*)::int FROM pg_auth_members m JOIN pg_roles member ON member.oid=m.member
      WHERE member.rolname IN ('supabase_admin','supabase_auth_admin')) AS extra_admin_memberships,
    (SELECT pg_get_userbyid(nspowner)='supabase_admin' FROM pg_namespace WHERE nspname='auth') AS auth_schema_owner,
    has_schema_privilege('supabase_auth_admin','auth','USAGE')
      AND has_schema_privilege('supabase_auth_admin','auth','CREATE') AS auth_schema_migration_access,
    NOT has_schema_privilege('supabase_auth_admin','public','CREATE') AS public_create_denied,
    (SELECT bool_and(has_schema_privilege(r,'auth','USAGE') AND NOT has_schema_privilege(r,'auth','CREATE'))
      FROM unnest(ARRAY['anon','authenticated','service_role']) r) AS application_schema_boundary`);
  assert.deepEqual(
    result.rows,
    [
      {
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
      },
    ],
    'FIXTURE_NATIVE_SERVICE_ROLE_BOUNDARY_REQUIRED'
  );
  return { ...serviceBoundaryReceipt };
}
