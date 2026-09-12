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
  // Match the managed application's role from the first connection. Service
  // bootstrap remains on the separate initdb identity, never this owner.
  await db.query(`CREATE ROLE postgres LOGIN NOSUPERUSER INHERIT CREATEDB CREATEROLE REPLICATION BYPASSRLS;
    CREATE ROLE supabase_privileged_role NOLOGIN NOSUPERUSER INHERIT;
    GRANT supabase_privileged_role TO postgres WITH ADMIN FALSE, INHERIT TRUE, SET TRUE;`);
}

// These are server configuration, not application grants. Supautils intercepts
// the supported managed operations without making postgres a superuser.
export const managedPostgresArguments = Object.freeze([
  '-c',
  'session_preload_libraries=supautils',
  '-c',
  'supautils.superuser=supabase_admin',
  // Supautils 3.4.3 registers this compatibility name afterward using the
  // same C storage. Its default can clear the earlier placeholder value.
  // Pin both names to the captured managed bootstrap identity.
  '-c',
  'supautils.privileged_extensions_superuser=supabase_admin',
  '-c',
  'supautils.privileged_role=supabase_privileged_role',
  '-c',
  'supautils.privileged_extensions=dblink,pg_stat_statements,pg_trgm,pgcrypto,uuid-ossp,vector',
  '-c',
  'supautils.reserved_roles=supabase_admin,supabase_auth_admin,supabase_storage_admin,supabase_read_only_user,supabase_realtime_admin,supabase_replication_admin,supabase_etl_admin,dashboard_user,pgbouncer,service_role*,authenticator*,authenticated*,anon*,supabase_privileged_role',
  '-c',
  'supautils.reserved_memberships=pg_read_server_files,pg_write_server_files,pg_execute_server_program,supabase_admin,supabase_auth_admin,supabase_storage_admin,supabase_read_only_user,supabase_realtime_admin,supabase_replication_admin,supabase_etl_admin,dashboard_user,pgbouncer,authenticator',
]);

// Server-only settings remain private to the initdb connection. The app's
// replication role exercises the actual output plugin separately.
export async function assertBootstrapPostgresConfiguration(db) {
  const result =
    await db.query(`SELECT current_user='supabase_admin' AND session_user='supabase_admin'
    AND inet_server_addr() IS NULL AND current_database()='postgres'
    AND current_setting('data_directory')='/var/lib/postgresql/data'
    AND current_setting('wal_level')='logical'
    AND current_setting('output_plugin_libraries')='pgoutput,wal2json'
    AND current_setting('session_preload_libraries')='supautils'
    AND current_setting('supautils.superuser')='supabase_admin'
    AND current_setting('supautils.privileged_extensions_superuser')='supabase_admin'
    AND current_setting('supautils.privileged_role')='supabase_privileged_role' AS configured`);
  assert.deepEqual(
    result.rows,
    [{ configured: true }],
    'FIXTURE_BOOTSTRAP_POSTGRES_CONFIGURATION_REQUIRED'
  );
}

// Private service catalogs are observed by their original initdb identity.
// This connection never performs application signup or funded-route work.
export async function assertFixtureServiceBootstrap(db) {
  const result = await db.query(`SELECT current_database()='club_arena_qualification'
    AND current_user='supabase_admin' AND session_user='supabase_admin'
    AND inet_server_addr() IS NULL
    AND EXISTS(SELECT 1 FROM pg_roles WHERE rolname=current_user AND oid=10 AND rolsuper)
    AS owned_service_bootstrap`);
  assert.deepEqual(
    result.rows,
    [{ owned_service_bootstrap: true }],
    'FIXTURE_SERVICE_BOOTSTRAP_IDENTITY_REQUIRED'
  );
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
    ALTER DEFAULT PRIVILEGES FOR ROLE supabase_auth_admin IN SCHEMA auth
      GRANT ALL ON TABLES TO postgres, dashboard_user;
    ALTER DEFAULT PRIVILEGES FOR ROLE supabase_auth_admin IN SCHEMA auth
      GRANT ALL ON SEQUENCES TO postgres, dashboard_user;
    ALTER DEFAULT PRIVILEGES FOR ROLE supabase_auth_admin IN SCHEMA auth
      GRANT EXECUTE ON FUNCTIONS TO postgres, dashboard_user;
    ALTER ROLE supabase_auth_admin SET search_path TO auth;
    GRANT CREATE ON DATABASE club_arena_qualification TO supabase_auth_admin;
    CREATE SCHEMA _realtime AUTHORIZATION supabase_admin;`;
}

// The managed Auth migration ledger is an exception to the captured Auth
// defaults: postgres may read it, never stamp or alter migration history.
// Called through the existing bootstrap identity after genuine migrations.
export async function sealFixtureAuthMigrationLedger(db) {
  const owner = await db.query(`SELECT current_database()='club_arena_qualification'
    AND current_user='supabase_admin' AND session_user='supabase_admin'
    AND inet_server_addr() IS NULL
    AND (SELECT pg_get_userbyid(relowner)='supabase_auth_admin' FROM pg_class
      WHERE oid='auth.schema_migrations'::regclass) AS owned_auth_ledger`);
  assert.deepEqual(owner.rows, [{ owned_auth_ledger: true }], 'FIXTURE_AUTH_LEDGER_OWNER_REQUIRED');
  await db.query('BEGIN');
  try {
    await db.query(`SET LOCAL ROLE supabase_auth_admin;
      REVOKE ALL ON TABLE auth.schema_migrations FROM postgres, dashboard_user;
      GRANT SELECT ON TABLE auth.schema_migrations TO postgres WITH GRANT OPTION;`);
    await db.query('COMMIT');
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  }
}

export const serviceBoundaryReceipt = Object.freeze({
  auth_admin_inheritance: 'disabled',
  authenticator_membership: 'set-without-inherit',
  auth_schema_owner: 'supabase_admin',
  auth_schema_create: 'auth-admin-only-among-application-callers',
  bootstrap_postgres: 'non-superuser-managed-owner',
  initdb_identity: 'supabase_admin',
  production_application_privilege_parity: false,
});

// This must run after the reviewed application schema and before any signup.
// The source composer owns application grants. Source that promotes the
// initial non-superuser owner must not reach application signup.
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
    (SELECT NOT rolsuper AND rolcanlogin AND rolinherit AND rolreplication AND rolbypassrls
      AND rolcreaterole AND rolcreatedb FROM pg_roles WHERE rolname='postgres') AS application_owner_flags,
    pg_has_role('postgres','supabase_privileged_role','MEMBER') AS managed_owner_membership,
    (SELECT bool_and(NOT pg_has_role(r,'supabase_privileged_role','MEMBER'))
      FROM unnest(ARRAY['anon','authenticated','service_role','authenticator','supabase_auth_admin']) r) AS api_managed_membership_denied,
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
    has_table_privilege('postgres','auth.schema_migrations','SELECT')
      AND NOT has_table_privilege('postgres','auth.schema_migrations','INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER,REFERENCES,MAINTAIN')
      AND NOT has_table_privilege('dashboard_user','auth.schema_migrations','SELECT,INSERT,UPDATE,DELETE') AS auth_ledger_read_only,
    (SELECT bool_and(has_schema_privilege(r,'auth','USAGE') AND NOT has_schema_privilege(r,'auth','CREATE'))
      FROM unnest(ARRAY['anon','authenticated','service_role']) r) AS application_schema_boundary`);
  assert.deepEqual(
    result.rows,
    [
      {
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
        auth_ledger_read_only: true,
        application_schema_boundary: true,
      },
    ],
    'FIXTURE_NATIVE_SERVICE_ROLE_BOUNDARY_REQUIRED'
  );
  return { ...serviceBoundaryReceipt };
}

export const managedPostgresReceipt = Object.freeze({
  library: 'supautils-3.4.3',
  source: 'e35f8affc4467202ff0d98f8dd14cb955bc13c75',
  application_superuser: false,
  owned_event_trigger: 'created-altered-fired',
  ordinary_role: 'trigger-fired-create-denied',
  rollback: 'schema-trigger-role-absent',
  production_binary_version_parity: false,
  complete_application_acl_parity: false,
});

// Actual native SQL, run by both entrypoints on the same application identity.
// All probe objects and membership changes roll back, even on a failed assertion.
export async function assertManagedPostgresBoundary(db) {
  await assertApplicationOwnerBoundary(db);
  // Private preload configuration was checked on the bootstrap connection.
  // This identity proves the actual managed behavior below without permission
  // to read server-private settings or promote itself to a superuser.
  const membership = await db.query(`SELECT
    pg_has_role(current_user,'supabase_privileged_role','MEMBER') AS managed_membership`);
  assert.deepEqual(
    membership.rows,
    [{ managed_membership: true }],
    'FIXTURE_MANAGED_POSTGRES_REQUIRED'
  );
  const absent = async () => {
    const result = await db.query(`SELECT
      NOT EXISTS(SELECT 1 FROM pg_namespace WHERE nspname='fixture_managed_probe')
      AND NOT EXISTS(SELECT 1 FROM pg_event_trigger WHERE evtname IN ('fixture_managed_event','fixture_denied_event'))
      AND NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='fixture_managed_plain')
      AND NOT (SELECT rolsuper FROM pg_roles WHERE rolname='postgres') AS absent`);
    assert.deepEqual(result.rows, [{ absent: true }], 'FIXTURE_MANAGED_PROBE_CLEANUP_REQUIRED');
  };
  await absent();
  await db.query('BEGIN');
  try {
    await db.query(`CREATE SCHEMA fixture_managed_probe;
      CREATE TABLE fixture_managed_probe.events (id bigint GENERATED ALWAYS AS IDENTITY);
      CREATE FUNCTION fixture_managed_probe.record_ddl() RETURNS event_trigger
        LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $body$
        BEGIN INSERT INTO fixture_managed_probe.events DEFAULT VALUES; END; $body$;
      CREATE EVENT TRIGGER fixture_managed_event ON ddl_command_end WHEN TAG IN ('CREATE TABLE')
        EXECUTE FUNCTION fixture_managed_probe.record_ddl();
      ALTER EVENT TRIGGER fixture_managed_event OWNER TO postgres;
      CREATE TABLE fixture_managed_probe.owner_table (id integer);`);
    assert.deepEqual(
      (
        await db.query(`SELECT pg_get_userbyid(evtowner)='postgres' AND evtenabled='O' AS owned
      FROM pg_event_trigger WHERE evtname='fixture_managed_event'`)
      ).rows,
      [{ owned: true }]
    );
    assert.deepEqual(
      (await db.query('SELECT count(*)::int AS n FROM fixture_managed_probe.events')).rows,
      [{ n: 1 }]
    );
    await db.query(`CREATE ROLE fixture_managed_plain NOLOGIN NOSUPERUSER NOINHERIT;
      GRANT fixture_managed_plain TO postgres WITH INHERIT FALSE, SET TRUE;
      GRANT USAGE,CREATE ON SCHEMA fixture_managed_probe TO fixture_managed_plain;
      SET LOCAL ROLE fixture_managed_plain;
      CREATE TABLE fixture_managed_probe.ordinary_table (id integer);
      RESET ROLE;`);
    assert.deepEqual(
      (await db.query('SELECT count(*)::int AS n FROM fixture_managed_probe.events')).rows,
      [{ n: 2 }]
    );
    await db.query('SAVEPOINT denied_event_trigger');
    try {
      await db.query(`SET LOCAL ROLE fixture_managed_plain;
        CREATE EVENT TRIGGER fixture_denied_event ON ddl_command_end
          EXECUTE FUNCTION fixture_managed_probe.record_ddl();`);
      assert.fail('FIXTURE_ORDINARY_EVENT_TRIGGER_CREATION_MUST_REFUSE');
    } catch (error) {
      assert.equal(error.code, '42501', 'FIXTURE_ORDINARY_EVENT_TRIGGER_DENIAL_REQUIRED');
    } finally {
      await db.query('ROLLBACK TO SAVEPOINT denied_event_trigger');
    }
  } finally {
    await db.query('ROLLBACK');
    await absent();
  }
  return { ...managedPostgresReceipt };
}

// Production catalog observed 2026-09-12 13:55:49 UTC. These four platform
// helpers are owned by Auth, not by the application restore role. Their bodies,
// attributes and direct ACLs are preserved independently of GoTrue's ledger.
const authPlatformHelpers = [
  {
    identity: 'auth.email()',
    owner: 'supabase_auth_admin',
    body_md5: 'd83fa9609bbd5e95512922e407b4141d',
    language: 'sql',
    volatility: 's',
    security_definer: false,
    strict: false,
    settings: null,
    acl: [
      '=X/supabase_auth_admin',
      'dashboard_user=X/supabase_auth_admin',
      'supabase_auth_admin=X/supabase_auth_admin',
    ],
  },
  {
    identity: 'auth.jwt()',
    owner: 'supabase_auth_admin',
    body_md5: '2db09c3fc855ba90e71d3ae28cfadae3',
    language: 'sql',
    volatility: 's',
    security_definer: false,
    strict: false,
    settings: null,
    acl: [
      '=X/supabase_auth_admin',
      'dashboard_user=X/supabase_auth_admin',
      'postgres=X/supabase_auth_admin',
      'supabase_auth_admin=X/supabase_auth_admin',
    ],
  },
  {
    identity: 'auth.role()',
    owner: 'supabase_auth_admin',
    body_md5: 'f31486fed08a7402e89d4aa71b0ad273',
    language: 'sql',
    volatility: 's',
    security_definer: false,
    strict: false,
    settings: null,
    acl: [
      '=X/supabase_auth_admin',
      'dashboard_user=X/supabase_auth_admin',
      'supabase_auth_admin=X/supabase_auth_admin',
    ],
  },
  {
    identity: 'auth.uid()',
    owner: 'supabase_auth_admin',
    body_md5: 'cdef18c69c4f4cbbced2eaf81e628b49',
    language: 'sql',
    volatility: 's',
    security_definer: false,
    strict: false,
    settings: null,
    acl: [
      '=X/supabase_auth_admin',
      'dashboard_user=X/supabase_auth_admin',
      'supabase_auth_admin=X/supabase_auth_admin',
    ],
  },
];
async function authPlatformCatalog(db) {
  const result =
    await db.query(`SELECT format('%I.%I(%s)',n.nspname,p.proname,pg_get_function_identity_arguments(p.oid)) AS identity,
    pg_get_userbyid(p.proowner) AS owner, md5(p.prosrc) AS body_md5,
    l.lanname AS language, p.provolatile AS volatility,
    p.prosecdef AS security_definer, p.proisstrict AS strict, p.proconfig AS settings,
    ARRAY(SELECT a::text FROM unnest(p.proacl) a ORDER BY a::text) AS acl
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    JOIN pg_language l ON l.oid=p.prolang
    WHERE n.nspname='auth' AND p.proname=ANY(ARRAY['email','jwt','role','uid'])
    ORDER BY n.nspname,p.proname,pg_get_function_identity_arguments(p.oid)`);
  return result.rows;
}

export async function assertFixtureAuthPlatformHelpers(db) {
  assert.deepEqual(
    await authPlatformCatalog(db),
    authPlatformHelpers,
    'FIXTURE_AUTH_PLATFORM_IDENTITY_REQUIRED'
  );
  return { helpers: 4, owner: 'supabase_auth_admin', catalog: 'exact-body-attributes-direct-acl' };
}

// GoTrue's pinned 20220224000811 and 20220531120530 migrations already
// create these exact bodies. Align only the production ACL exception to
// current default grants; never replace a migrated function or stamp a ledger.
export async function alignFixtureAuthPlatformHelperGrants(db) {
  await assertFixtureServiceBootstrap(db);
  await db.query('BEGIN');
  try {
    const preflight = await db.query(`SELECT
      current_database()='club_arena_qualification' AND inet_server_addr() IS NULL
      AND current_user='supabase_admin' AND session_user='supabase_admin'
      AND (SELECT pg_get_userbyid(nspowner)='supabase_admin' FROM pg_namespace WHERE nspname='auth')
      AND (SELECT pg_get_userbyid(relowner)='supabase_auth_admin' FROM pg_class
        WHERE oid='auth.schema_migrations'::regclass)
      AND NOT has_schema_privilege('postgres','auth','CREATE') AS auth_platform_owned`);
    assert.deepEqual(
      preflight.rows,
      [{ auth_platform_owned: true }],
      'FIXTURE_AUTH_PLATFORM_OWNER_REQUIRED'
    );
    const migrationDefaults = authPlatformHelpers.map((helper) => ({
      ...helper,
      acl: [...new Set([...helper.acl, 'postgres=X/supabase_auth_admin'])].sort(),
    }));
    assert.deepEqual(
      await authPlatformCatalog(db),
      migrationDefaults,
      'FIXTURE_GOTRUE_PLATFORM_PREIMAGE_REQUIRED'
    );
    await db.query('SET LOCAL ROLE supabase_auth_admin');
    await db.query(
      `REVOKE EXECUTE ON FUNCTION auth.email(), auth.role(), auth.uid() FROM postgres;`
    );
    await assertFixtureAuthPlatformHelpers(db);
    await db.query('COMMIT');
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  }
}

// The real application connection may execute helpers but must not replace
// Auth's definition. Both expected denial and unexpected success roll back.
export async function assertFixtureAuthPlatformWriteDenied(db) {
  await assertApplicationOwnerBoundary(db);
  await db.query('BEGIN');
  let denied = false;
  try {
    await db.query(`CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid
      LANGUAGE sql STABLE AS $$SELECT NULL::uuid$$`);
  } catch (error) {
    if (error?.code !== '42501') throw error;
    denied = true;
  } finally {
    await db.query('ROLLBACK');
  }
  assert.equal(denied, true, 'FIXTURE_APPLICATION_AUTH_REPLACEMENT_MUST_REFUSE');
  await assertFixtureAuthPlatformHelpers(db);
}
