// Native-only literal extension of the reviewed33-role service preimage.
// Source: four owning October migrations plus safe metadata observed
// 2026-10-31T17:34:39Z–17:36:17Z. Never a production role operation.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { captureFixtureServicePreimage } from './service-preimage.mjs';

export const currentRoleGraphWitness =
  'sha256:3a2743a41de40149f61ac411400e0009b9e2f55ae9497117041f8e71156ac679';
export const currentRoleSourcePins = Object.freeze({
  'supabase/migrations/20261002135708_a_ledger_refusal_is_recorded_outside_its_rollback.sql':
    '71618fc157b5627068511454a8f53350cdd1ab99128b563a4fda21327df4df6b',
  'supabase/migrations/20261002223745_the_lease_heartbeat_has_its_own_login.sql':
    '969f0e046cc40545f7983c6f76b6f498d87256117bbff88835bb8f7bde8fbc28',
  'supabase/migrations/20261020160107_lightning_fold_uses_a_separate_restricted_session.sql':
    '12f8e563dcfad8e120b9449894724244434dba5109bebfa6e5e64f54ff4ae4c8',
  'supabase/migrations/20261028154533_private_record_listener_has_a_dedicated_disabled_role.sql':
    '1860b9e5f7c7c80d241e0c601a319f8a460d72551458fad6fd8ca9986cdde869',
  'scripts/ci/private-record-gateway-credentials.mjs':
    '02e7afb733673ca003e1f0ed0c164656f660752a364bfbe4bfb07188e120ba46',
});
export const currentApplicationRoles = Object.freeze([
  {
    name: 'ca_ledger_refusal_recorder',
    login: true,
    inherit: false,
    create_db: false,
    superuser: false,
    bypass_rls: false,
    create_role: false,
    replication: false,
    valid_until: null,
    connection_limit: 4,
    configuration: [
      {
        key: 'idle_in_transaction_session_timeout',
        value: '5s',
        value_md5: 'f20a81adfd4dc563c9c150f62b5e5014',
      },
      { key: 'lock_timeout', value: '1s', value_md5: '0cf81f9038402e85910cfad17d0051b3' },
      { key: 'statement_timeout', value: '3s', value_md5: '0d4896d431044c92de2840ed53b6fbbd' },
    ],
  },
  {
    name: 'ca_record_gateway',
    login: true,
    inherit: false,
    create_db: false,
    superuser: false,
    bypass_rls: false,
    create_role: false,
    replication: false,
    valid_until: null,
    connection_limit: 4,
    configuration: null,
  },
  {
    name: 'cli_login_supabase_read_only_user',
    login: true,
    inherit: false,
    create_db: false,
    superuser: false,
    bypass_rls: false,
    create_role: false,
    replication: false,
    valid_until: '2026-10-15 15:52:57.04123+00',
    connection_limit: -1,
    configuration: null,
  },
  {
    name: 'engine_lease_heartbeat',
    login: true,
    inherit: false,
    create_db: false,
    superuser: false,
    bypass_rls: false,
    create_role: false,
    replication: false,
    valid_until: null,
    connection_limit: 8,
    configuration: [
      {
        key: 'idle_in_transaction_session_timeout',
        value: '10s',
        value_md5: 'e82d0467d342d614cd3d6368b302d9e7',
      },
      { key: 'lock_timeout', value: '2s', value_md5: 'c804c3a15ebe05b5baf40ad5ee12be1f' },
      { key: 'statement_timeout', value: '8s', value_md5: 'ee3b1e42b451a7032605f24f4d9a8e53' },
    ],
  },
  {
    name: 'engine_lightning_fold',
    login: true,
    inherit: false,
    create_db: false,
    superuser: false,
    bypass_rls: false,
    create_role: false,
    replication: false,
    valid_until: null,
    connection_limit: 8,
    configuration: [
      {
        key: 'idle_in_transaction_session_timeout',
        value: '10s',
        value_md5: 'e82d0467d342d614cd3d6368b302d9e7',
      },
      { key: 'lock_timeout', value: '2s', value_md5: 'c804c3a15ebe05b5baf40ad5ee12be1f' },
      { key: 'search_path', value: 'pg_catalog', value_md5: '31648562b5d971a35e704e3f5c6842b3' },
      { key: 'statement_timeout', value: '8s', value_md5: 'ee3b1e42b451a7032605f24f4d9a8e53' },
      { key: 'synchronous_commit', value: null, value_md5: 'ed2b5c0139cec8ad2873829dc1117d50' },
    ],
  },
]);
export const currentApplicationEdges = Object.freeze([
  {
    set: false,
    role: 'ca_ledger_refusal_recorder',
    admin: true,
    member: 'postgres',
    grantor: 'supabase_admin',
    inherit: false,
  },
  {
    set: false,
    role: 'ca_record_gateway',
    admin: true,
    member: 'postgres',
    grantor: 'supabase_admin',
    inherit: false,
  },
  {
    set: false,
    role: 'engine_lease_heartbeat',
    admin: true,
    member: 'postgres',
    grantor: 'supabase_admin',
    inherit: false,
  },
  {
    set: false,
    role: 'engine_lightning_fold',
    admin: true,
    member: 'postgres',
    grantor: 'supabase_admin',
    inherit: false,
  },
  {
    set: true,
    role: 'supabase_read_only_user',
    admin: false,
    member: 'cli_login_supabase_read_only_user',
    grantor: 'supabase_admin',
    inherit: false,
  },
]);
const installer = `BEGIN;
SET LOCAL lock_timeout='500ms';
SET LOCAL statement_timeout='5s';
DO $owner$ BEGIN IF current_database()<>'club_arena_qualification' OR inet_server_addr() IS NOT NULL OR session_user<>'supabase_admin' OR current_user<>'supabase_admin' OR NOT EXISTS(SELECT FROM pg_roles WHERE oid=10 AND rolname=current_user AND rolsuper) THEN RAISE EXCEPTION 'ISOLATED_BOOTSTRAP_REQUIRED'; END IF; END $owner$;
CREATE ROLE ca_ledger_refusal_recorder LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 4 PASSWORD NULL;
CREATE ROLE ca_record_gateway LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 4 PASSWORD NULL;
CREATE ROLE cli_login_supabase_read_only_user LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT -1 PASSWORD NULL VALID UNTIL '2026-10-15 15:52:57.04123+00';
CREATE ROLE engine_lease_heartbeat LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 8 PASSWORD NULL;
CREATE ROLE engine_lightning_fold LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 8 PASSWORD NULL;
ALTER ROLE ca_ledger_refusal_recorder SET idle_in_transaction_session_timeout='5s';
ALTER ROLE ca_ledger_refusal_recorder SET lock_timeout='1s';
ALTER ROLE ca_ledger_refusal_recorder SET statement_timeout='3s';
ALTER ROLE engine_lease_heartbeat SET idle_in_transaction_session_timeout='10s';
ALTER ROLE engine_lease_heartbeat SET lock_timeout='2s';
ALTER ROLE engine_lease_heartbeat SET statement_timeout='8s';
ALTER ROLE engine_lightning_fold SET idle_in_transaction_session_timeout='10s';
ALTER ROLE engine_lightning_fold SET lock_timeout='2s';
ALTER ROLE engine_lightning_fold SET search_path='pg_catalog';
ALTER ROLE engine_lightning_fold SET statement_timeout='8s';
ALTER ROLE engine_lightning_fold SET synchronous_commit='on';
GRANT ca_ledger_refusal_recorder TO postgres WITH ADMIN TRUE, INHERIT FALSE, SET FALSE GRANTED BY supabase_admin;
GRANT ca_record_gateway TO postgres WITH ADMIN TRUE, INHERIT FALSE, SET FALSE GRANTED BY supabase_admin;
GRANT engine_lease_heartbeat TO postgres WITH ADMIN TRUE, INHERIT FALSE, SET FALSE GRANTED BY supabase_admin;
GRANT engine_lightning_fold TO postgres WITH ADMIN TRUE, INHERIT FALSE, SET FALSE GRANTED BY supabase_admin;
GRANT supabase_read_only_user TO cli_login_supabase_read_only_user WITH ADMIN FALSE, INHERIT FALSE, SET TRUE GRANTED BY supabase_admin;
ALTER ROLE cli_login_postgres VALID UNTIL '2026-10-15 01:06:31.108686+00';
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE MAINTAIN, REFERENCES, TRIGGER ON TABLES FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA realtime GRANT SELECT, INSERT ON TABLES TO postgres WITH GRANT OPTION;
COMMIT;`;
const order = (items, keys) =>
  items.sort((a, b) => {
    for (const key of keys) {
      if (a[key] < b[key]) return -1;
      if (a[key] > b[key]) return 1;
    }
    return 0;
  });
export function extendedRolePreimage(base) {
  const expected = structuredClone(base);
  const names = new Set(currentApplicationRoles.map((role) => role.name));
  assert.equal(expected.roles.length, 33);
  assert.ok(expected.roles.every((role) => !names.has(role.name)));
  expected.roles = order(
    [...expected.roles, ...structuredClone(currentApplicationRoles)],
    ['name']
  );
  expected.memberships = order(
    [...expected.memberships, ...structuredClone(currentApplicationEdges)],
    ['role', 'member', 'grantor']
  );
  for (const role of currentApplicationRoles.filter((role) => role.configuration))
    expected.role_settings.push({
      role: role.name,
      database: 'ALL',
      settings: structuredClone(role.configuration),
    });
  order(expected.role_settings, ['database', 'role']);
  // Exact current read-only catalogue witness. Both CLI expiries remain past;
  // no credential or authentication capability is copied or refreshed.
  const cli = expected.roles.find((role) => role.name === 'cli_login_postgres');
  assert.equal(cli.valid_until, '2026-09-07 04:55:14.200464+00');
  cli.valid_until = '2026-10-15 01:06:31.108686+00';
  const publicTables = expected.default_acl.find(
    (row) => row.creator === 'postgres' && row.schema === 'public' && row.type === 'r'
  );
  const removed = publicTables.acl.filter(
    (grant) =>
      ['anon', 'authenticated'].includes(grant.grantee) &&
      ['MAINTAIN', 'REFERENCES', 'TRIGGER'].includes(grant.privilege)
  );
  assert.equal(removed.length, 6);
  assert.ok(removed.every((grant) => grant.grantor === 'postgres' && grant.grantable === false));
  publicTables.acl = publicTables.acl.filter((grant) => !removed.includes(grant));
  const realtimeTables = expected.default_acl.find(
    (row) => row.creator === 'supabase_admin' && row.schema === 'realtime' && row.type === 'r'
  );
  const upgraded = realtimeTables.acl.filter(
    (grant) => grant.grantee === 'postgres' && ['SELECT', 'INSERT'].includes(grant.privilege)
  );
  assert.equal(upgraded.length, 2);
  for (const grant of upgraded) {
    assert.equal(grant.grantor, 'supabase_admin');
    assert.equal(grant.grantable, false);
    grant.grantable = true;
  }
  return expected;
}
function catalog(captured) {
  const value = JSON.parse(captured.serialized);
  delete value.observed_at;
  return value;
}

export async function alignCurrentApplicationRoles({ applicationClient, Client, databaseOwner }) {
  const bytes = await readFile(new URL('./role-alignment-aligned.json', import.meta.url));
  assert.equal(
    createHash('sha256').update(bytes).digest('hex'),
    'd0d858e8dbb70afca05d3e84be6ce109b818ea1ba278813d9d4b6afd062e2083'
  );
  const before = JSON.parse(bytes),
    expected = extendedRolePreimage(before);
  const create = () =>
    databaseOwner.own(
      new Client({
        host: '/run/postgresql',
        user: 'supabase_admin',
        database: 'club_arena_qualification',
        connectionTimeoutMillis: 5000,
        query_timeout: 8000,
        statement_timeout: 8000,
        options: '-c search_path=pg_catalog -c timezone=UTC -c datestyle=ISO,YMD',
      })
    );
  let installerClient = create();
  let installPid;
  try {
    await installerClient.connect();
    installPid = installerClient.processID;
    assert.notEqual(installPid, applicationClient.processID);
    assert.deepEqual(
      catalog(await captureFixtureServicePreimage(installerClient, applicationClient.processID)),
      before
    );
    const result = await installerClient.query(installer);
    assert.equal(result.at(-1).command, 'COMMIT');
  } catch (error) {
    await installerClient.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    await databaseOwner.end(installerClient);
  }
  const observer = create();
  try {
    await observer.connect();
    assert.notEqual(observer.processID, installPid);
    assert.notEqual(observer.processID, applicationClient.processID);
    assert.deepEqual(
      catalog(await captureFixtureServicePreimage(observer, applicationClient.processID)),
      expected
    );
  } finally {
    await databaseOwner.end(observer);
  }
  return {
    scope: 'native-current-application-role-extension',
    roles: 38,
    added_roles: 5,
    added_memberships: 5,
    separate_post_commit_observer: true,
    passwords_reused: false,
    production_role_mutations: false,
    full_schema_ready: false,
  };
}

export const currentApplicationExtensions = Object.freeze([
  { name: 'dblink', owner: 'supabase_admin', schema: 'extensions', version: '1.2' },
  { name: 'http', owner: 'supabase_admin', schema: 'extensions', version: '1.6' },
  { name: 'pg_cron', owner: 'supabase_admin', schema: 'pg_catalog', version: '1.6.4' },
  { name: 'pg_stat_statements', owner: 'postgres', schema: 'extensions', version: '1.11' },
  { name: 'pg_trgm', owner: 'supabase_admin', schema: 'public', version: '1.6' },
  { name: 'pgcrypto', owner: 'postgres', schema: 'extensions', version: '1.3' },
  { name: 'pgstattuple', owner: 'supabase_admin', schema: 'extensions', version: '1.5' },
  { name: 'plpgsql', owner: 'supabase_admin', schema: 'pg_catalog', version: '1.0' },
  { name: 'plpgsql_check', owner: 'supabase_admin', schema: 'public', version: '2.7' },
  { name: 'postgis', owner: 'supabase_admin', schema: 'extensions', version: '3.3.7' },
  { name: 'supabase_vault', owner: 'supabase_admin', schema: 'vault', version: '0.3.1' },
  { name: 'uuid-ossp', owner: 'postgres', schema: 'extensions', version: '1.1' },
  { name: 'vector', owner: 'supabase_admin', schema: 'public', version: '0.8.0' },
]);

export async function installCurrentApplicationExtensions({
  applicationClient,
  Client,
  databaseOwner,
}) {
  const bootstrap = databaseOwner.own(
    new Client({
      host: '/run/postgresql',
      user: 'supabase_admin',
      database: 'club_arena_qualification',
      connectionTimeoutMillis: 5000,
      query_timeout: 8000,
      statement_timeout: 8000,
      options: '-c search_path=pg_catalog',
    })
  );
  const query = `SELECT e.extname AS name,e.extversion AS version,n.nspname AS schema,
    pg_get_userbyid(e.extowner) AS owner FROM pg_extension e
    JOIN pg_namespace n ON n.oid=e.extnamespace ORDER BY e.extname`;
  try {
    await bootstrap.connect();
    assert.deepEqual(
      (
        await bootstrap.query(`SELECT current_database()='club_arena_qualification'
      AND inet_server_addr() IS NULL AND current_user='supabase_admin' AND session_user='supabase_admin'
      AND EXISTS(SELECT FROM pg_roles WHERE oid=10 AND rolname=current_user AND rolsuper) AS owned`)
      ).rows,
      [{ owned: true }]
    );
    assert.deepEqual(
      (await bootstrap.query(query)).rows,
      currentApplicationExtensions.filter((item) => ['pg_cron', 'plpgsql'].includes(item.name))
    );
    // Closed source literals only. Existing cron/plpgsql are reasserted, not
    // replaced. Supautils' unchanged six-name list handles the three existing
    // postgres-owned extensions; all five additional providers are admin-owned.
    for (const owner of ['supabase_admin', 'postgres']) {
      const client = owner === 'postgres' ? applicationClient : bootstrap;
      await client.query(
        "BEGIN; SET LOCAL lock_timeout='500ms'; SET LOCAL statement_timeout='5s';"
      );
      try {
        for (const item of currentApplicationExtensions.filter(
          (item) => item.owner === owner && !['pg_cron', 'plpgsql'].includes(item.name)
        )) {
          assert.ok(
            /^[a-z_-]+$/.test(item.name) &&
              /^[a-z_]+$/.test(item.schema) &&
              /^[0-9.]+$/.test(item.version)
          );
          await client.query(
            `CREATE EXTENSION "${item.name}" WITH SCHEMA "${item.schema}" VERSION '${item.version}'`
          );
        }
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
      }
    }
    assert.deepEqual((await bootstrap.query(query)).rows, currentApplicationExtensions);
  } finally {
    await databaseOwner.end(bootstrap);
  }
  return {
    scope: 'native-current-application-extensions',
    installed: 13,
    exact_versions_schemas_owners: true,
    genuine_create_extension: true,
    production_binary_parity: false,
  };
}
