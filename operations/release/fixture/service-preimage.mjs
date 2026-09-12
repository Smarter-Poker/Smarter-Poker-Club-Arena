import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';

// Only the fixed default is used by the committed container command. The
// optional harness supplies owned local files for filesystem refusal tests.
export async function readFixtureServicePreimage({
  file = '/run/club-arena-qualification/service-preimage.json',
  uid = 1000,
  gid = 1000,
} = {}) {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  const requireFile = (condition) => {
    if (!condition) throw new Error('FIXTURE_SERVICE_PREIMAGE_FILE_REFUSED');
  };
  try {
    const before = await handle.stat();
    requireFile(
      before.isFile() &&
        before.nlink === 1 &&
        before.uid === uid &&
        before.gid === gid &&
        (before.mode & 0o222) === 0 &&
        before.size > 0 &&
        before.size <= 1024 * 1024
    );
    const bytes = Buffer.alloc(before.size + 1);
    let received = 0;
    while (received < bytes.length) {
      const { bytesRead } = await handle.read(bytes, received, bytes.length - received, null);
      if (bytesRead === 0) break;
      received += bytesRead;
    }
    const after = await handle.stat();
    requireFile(
      received === before.size &&
        ['dev', 'ino', 'mode', 'nlink', 'uid', 'gid', 'size', 'mtimeMs', 'ctimeMs'].every(
          (field) => before[field] === after[field]
        )
    );
    return bytes.subarray(0, received);
  } finally {
    await handle.close();
  }
}

// Original owned bootstrap only, after verified genuine service migrations.
// No passwords, application rows, arbitrary server settings or vault data.
const identitySql = String.raw`SET LOCAL statement_timeout = '8s';
SET LOCAL search_path = pg_catalog;
SET LOCAL timezone = 'UTC';
SET LOCAL datestyle = 'ISO, YMD';
DO $owned$
BEGIN
  IF current_database() <> 'club_arena_qualification'
     OR inet_server_addr() IS NOT NULL
     OR current_user <> 'supabase_admin'
     OR session_user <> 'supabase_admin'
     OR NOT EXISTS (SELECT 1 FROM pg_roles WHERE oid = 10
       AND rolname = current_user AND rolsuper)
     OR NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'postgres'
       AND NOT rolsuper AND rolcanlogin AND rolcreaterole AND rolcreatedb)
     OR to_regclass('auth.schema_migrations') IS NULL
     OR to_regclass('realtime.schema_migrations') IS NULL
     OR to_regclass('_realtime.tenants') IS NULL THEN
    RAISE EXCEPTION 'OWNED_POST_SERVICE_FIXTURE_PREIMAGE_REQUIRED';
  END IF;
END;
$owned$;`;
const catalogSql = String.raw`WITH known_config(key) AS (
  VALUES ('search_path'), ('statement_timeout'), ('lock_timeout'),
    ('idle_in_transaction_session_timeout'), ('default_transaction_read_only'),
    ('log_statement'), ('pgrst.db_pre_request'), ('session_preload_libraries'),
    ('app.settings.jwt_exp')
), role_rows AS (
  SELECT jsonb_build_object(
    'name', r.rolname, 'superuser', r.rolsuper, 'inherit', r.rolinherit,
    'create_role', r.rolcreaterole, 'create_db', r.rolcreatedb,
    'login', r.rolcanlogin, 'replication', r.rolreplication,
    'bypass_rls', r.rolbypassrls, 'connection_limit', r.rolconnlimit,
    'valid_until', r.rolvaliduntil::text,
    'configuration', (SELECT jsonb_agg(jsonb_build_object(
      'key', split_part(c, '=', 1),
      'value', CASE WHEN split_part(c, '=', 1) IN (SELECT key FROM known_config)
        THEN substr(c, strpos(c, '=') + 1) END,
      'value_md5', md5(substr(c, strpos(c, '=') + 1))) ORDER BY split_part(c, '=', 1))
      FROM unnest(r.rolconfig) c)) AS value
  FROM pg_roles r
), setting_rows AS (
  SELECT jsonb_build_object(
    'role', CASE WHEN s.setrole = 0 THEN 'ALL' ELSE pg_get_userbyid(s.setrole) END,
    'database', CASE WHEN s.setdatabase = 0 THEN 'ALL'
      WHEN s.setdatabase = (SELECT oid FROM pg_database WHERE datname = current_database())
        THEN 'OWNED_DATABASE'
      ELSE (SELECT datname FROM pg_database WHERE oid = s.setdatabase) END,
    'settings', (SELECT jsonb_agg(jsonb_build_object(
      'key', split_part(c, '=', 1),
      'value', CASE WHEN split_part(c, '=', 1) IN (SELECT key FROM known_config)
        THEN substr(c, strpos(c, '=') + 1) END,
      'value_md5', md5(substr(c, strpos(c, '=') + 1))) ORDER BY split_part(c, '=', 1))
      FROM unnest(s.setconfig) c)) AS value
  FROM pg_db_role_setting s
), default_rows AS (
  SELECT jsonb_build_object('creator', pg_get_userbyid(d.defaclrole),
    'schema', CASE WHEN d.defaclnamespace = 0 THEN 'GLOBAL'
      ELSE (SELECT nspname FROM pg_namespace WHERE oid = d.defaclnamespace) END,
    'type', d.defaclobjtype,
    'acl', (SELECT jsonb_agg(jsonb_build_object(
      'grantor', pg_get_userbyid(a.grantor),
      'grantee', CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END,
      'privilege', a.privilege_type, 'grantable', a.is_grantable)
      ORDER BY pg_get_userbyid(a.grantor),
        CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END,
        a.privilege_type, a.is_grantable)
      FROM aclexplode(d.defaclacl) a)) AS value
  FROM pg_default_acl d
)
SELECT jsonb_build_object(
  'version', 1, 'scope', 'owned-post-service-preimage',
  'observed_at', clock_timestamp(), 'database', current_database(),
  'role_scope', 'all roles including unconnected builtin and fixture roles',
  'roles', (SELECT jsonb_agg(value ORDER BY value->>'name') FROM role_rows),
  'memberships', (SELECT jsonb_agg(jsonb_build_object(
    'role', pg_get_userbyid(m.roleid), 'member', pg_get_userbyid(m.member),
    'grantor', pg_get_userbyid(m.grantor), 'admin', m.admin_option,
    'inherit', m.inherit_option, 'set', m.set_option)
    ORDER BY pg_get_userbyid(m.roleid), pg_get_userbyid(m.member), pg_get_userbyid(m.grantor))
    FROM pg_auth_members m),
  'role_settings', (SELECT jsonb_agg(value ORDER BY value->>'database', value->>'role') FROM setting_rows),
  'default_acl', (SELECT jsonb_agg(value ORDER BY value->>'creator', value->>'schema', value->>'type') FROM default_rows),
  'schemas', (SELECT jsonb_agg(jsonb_build_object('name', nspname,
    'owner', pg_get_userbyid(nspowner),
    'acl', (SELECT jsonb_agg(a::text ORDER BY a::text) FROM unnest(nspacl) a)) ORDER BY nspname)
    FROM pg_namespace WHERE nspname !~ '^pg_(temp|toast)' AND nspname <> 'pg_catalog'
      AND nspname <> 'information_schema'),
  'extensions', (SELECT jsonb_agg(jsonb_build_object('name', e.extname,
    'version', e.extversion, 'schema', n.nspname, 'owner', pg_get_userbyid(e.extowner)) ORDER BY e.extname)
    FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace),
  'production_parity', false,
  'contains_passwords_or_user_rows', false
) AS preimage;`;

export async function captureFixtureServicePreimage(db, idleApplicationPid) {
  assert.ok(
    Number.isInteger(idleApplicationPid) &&
      idleApplicationPid > 0 &&
      idleApplicationPid <= 2147483647
  );
  await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try {
    await db.query(identitySql);
    // The only other client is the actual idle application connection held by
    // this bootstrap invocation. No Auth server, Realtime server, application
    // archive, actor or arbitrary database client is running in this mode.
    const quiescent = await db.query(
      `SELECT NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_stat_activity
      WHERE backend_type = 'client backend' AND pid <> pg_backend_pid()
        AND (pid = $1 AND datname = current_database() AND usename = 'postgres'
          AND state = 'idle' AND xact_start IS NULL) IS NOT TRUE
    ) AS quiescent`,
      [idleApplicationPid]
    );
    assert.deepEqual(
      quiescent.rows,
      [{ quiescent: true }],
      'FIXTURE_SERVICE_PREIMAGE_REQUIRES_QUIESCENT_CATALOG'
    );
    const result = await db.query(catalogSql);
    assert.equal(result.rows.length, 1, 'FIXTURE_SERVICE_PREIMAGE_SINGLE_RESULT_REQUIRED');
    const catalog = result.rows[0].preimage;
    assert.equal(catalog.version, 1);
    assert.equal(catalog.scope, 'owned-post-service-preimage');
    assert.equal(catalog.database, 'club_arena_qualification');
    assert.equal(catalog.production_parity, false);
    assert.equal(catalog.contains_passwords_or_user_rows, false);
    assert.deepEqual(
      Object.keys(catalog).sort(),
      [
        'version',
        'scope',
        'observed_at',
        'database',
        'role_scope',
        'roles',
        'memberships',
        'role_settings',
        'default_acl',
        'schemas',
        'extensions',
        'production_parity',
        'contains_passwords_or_user_rows',
      ].sort()
    );
    for (const key of ['roles', 'memberships', 'schemas', 'extensions']) {
      assert.ok(
        Array.isArray(catalog[key]) && catalog[key].length > 0 && catalog[key].length <= 128
      );
    }
    for (const key of ['role_settings', 'default_acl']) {
      assert.ok(
        catalog[key] === null || (Array.isArray(catalog[key]) && catalog[key].length <= 128)
      );
    }
    const serialized = JSON.stringify(catalog) + '\n';
    assert.ok(Buffer.byteLength(serialized) <= 1024 * 1024, 'FIXTURE_SERVICE_PREIMAGE_SIZE_LIMIT');
    return {
      serialized,
      proof: {
        scope: 'native-service-preimage',
        status: 'captured',
        catalog_sha256: createHash('sha256').update(serialized).digest('hex'),
        roles: catalog.roles.length,
        memberships: catalog.memberships.length,
        schemas: catalog.schemas.length,
        extensions: catalog.extensions.length,
        role_settings: (catalog.role_settings ?? []).length,
        default_acl: (catalog.default_acl ?? []).length,
        production_parity: false,
        application_schema_restored: false,
      },
    };
  } finally {
    await db.query('ROLLBACK');
  }
}
