import assert from 'node:assert/strict';

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
    CREATE ROLE supabase_admin LOGIN SUPERUSER PASSWORD '${password}';
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
  production_application_privilege_parity: false,
});

/** Native migrated readback, not an assertion about the full application role graph. */
export async function assertNativeServiceRoleBoundary(db) {
  const result = await db.query(`SELECT
    current_database()='club_arena_qualification' AND inet_server_addr() IS NULL
      AND current_user='postgres' AS owned_database,
    (SELECT rolsuper FROM pg_roles WHERE rolname='postgres') AS bootstrap_superuser,
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
