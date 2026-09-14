import assert from 'node:assert/strict';
import { pbkdf2Sync, createHmac, createHash, timingSafeEqual } from 'node:crypto';
import { roleNativeInputs, RoleNativeOwner, identifier as ident, lastCommand, digest } from './role-native-protocol.mjs';

const privileges = Object.freeze({ r: ['DELETE','INSERT','MAINTAIN','REFERENCES','SELECT','TRIGGER','TRUNCATE','UPDATE'], S: ['SELECT','UPDATE','USAGE'], f: ['EXECUTE'] });
export function expectedFutureAcl(entry) {
  assert.ok(Object.hasOwn(privileges, entry.type));
  const grants = new Map();
  const add = (row) => {
    const key = JSON.stringify([row.grantor,row.grantee,row.privilege]);
    const old = grants.get(key);
    grants.set(key, { grantor: row.grantor, grantee: row.grantee, privilege: row.privilege, grantable: row.grantable || old?.grantable || false });
  };
  for (const privilege of privileges[entry.type]) add({ grantor: entry.creator, grantee: entry.creator, privilege, grantable: false });
  if (entry.type === 'f') add({ grantor: entry.creator, grantee: 'PUBLIC', privilege: 'EXECUTE', grantable: false });
  for (const grant of entry.acl) add(grant);
  return [...grants.values()].sort((a,b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}
export function reachableRoles(catalog, actor, option) {
  assert.ok(['set','inherit'].includes(option));
  const reachable = new Set([actor]);
  for (let changed = true; changed;) {
    changed = false;
    for (const row of catalog.memberships)
      if (row[option] && reachable.has(row.member) && !reachable.has(row.role)) { reachable.add(row.role); changed = true; }
  }
  return reachable;
}
export function expectedFuturePrivilege(catalog, entry, actor, privilege, grantOption = false) {
  const inherited = reachableRoles(catalog, actor, 'inherit');
  if (inherited.has(entry.creator)) return true;
  if (!grantOption && inherited.has('pg_read_all_data') && privilege === 'SELECT' && entry.type !== 'f') return true;
  return expectedFutureAcl(entry).some((g) => g.privilege === privilege && (!grantOption || g.grantable) && (g.grantee === 'PUBLIC' || inherited.has(g.grantee)));
}
export function expectedSchemaUsage(catalog, schema, actor) {
  const inherited = reachableRoles(catalog, actor, 'inherit');
  if (inherited.has('pg_read_all_data')) return true;
  const entry = catalog.schemas.find((row) => row.name === schema);
  assert.ok(entry);
  if (inherited.has(entry.owner)) return true;
  return (entry.acl ?? []).some((acl) => {
    const match = /^([^=]*)=([^/]+)\//.exec(acl);
    assert.ok(match);
    return match[2].includes('U') && (match[1] === '' || inherited.has(match[1]));
  });
}
export function verifySyntheticScram(password, verifier) {
  assert.match(password, /^[a-f0-9]{64}$/);
  const match = /^SCRAM-SHA-256\$([0-9]+):([A-Za-z0-9+/]+={0,2})\$([A-Za-z0-9+/]+={0,2}):([A-Za-z0-9+/]+={0,2})$/.exec(verifier);
  assert.ok(match, 'FIXTURE_ROLE_NATIVE_SCRAM_FORMAT');
  const rounds = Number(match[1]); assert.ok(rounds >= 4096 && rounds <= 100000);
  const salt = Buffer.from(match[2], 'base64'); assert.ok(salt.length >= 16 && salt.length <= 64);
  const salted = pbkdf2Sync(password, salt, rounds, 32, 'sha256');
  const stored = createHash('sha256').update(createHmac('sha256', salted).update('Client Key').digest()).digest();
  const server = createHmac('sha256', salted).update('Server Key').digest();
  const expectedStored = Buffer.from(match[3], 'base64'), expectedServer = Buffer.from(match[4], 'base64');
  assert.ok(expectedStored.length === 32 && expectedServer.length === 32);
  assert.ok(timingSafeEqual(stored, expectedStored) && timingSafeEqual(server, expectedServer), 'FIXTURE_ROLE_NATIVE_SCRAM_PASSWORD');
}
export function futureObjectCases(catalog) {
  assert.equal(catalog.default_acl.length, 27);
  assert.ok(catalog.default_acl.every((r) => r.schema !== null));
  return catalog.default_acl.map((entry, index) => ({ ...entry, name: 'fixture_role_probe_' + String(index + 1).padStart(2, '0') }));
}
const objectIdentity = (entry) => ident(entry.schema) + '.' + ident(entry.name);
const aclSql = (entry) => entry.type === 'f' ? `SELECT p.oid AS object_oid, pg_get_userbyid(p.proowner) AS owner,
  CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END AS grantee,
  pg_get_userbyid(a.grantor) AS grantor, a.privilege_type AS privilege, a.is_grantable AS grantable
  FROM pg_proc p CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
  WHERE p.oid=$1::regprocedure` : `SELECT c.oid AS object_oid, pg_get_userbyid(c.relowner) AS owner,
  CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END AS grantee,
  pg_get_userbyid(a.grantor) AS grantor, a.privilege_type AS privilege, a.is_grantable AS grantable
  FROM pg_class c CROSS JOIN LATERAL aclexplode(coalesce(c.relacl,acldefault($2::"char",c.relowner))) a
  WHERE c.oid=$1::regclass`;
const existenceSql = `SELECT count(*)::integer AS objects FROM (
  SELECT n.nspname,c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  UNION ALL SELECT n.nspname,p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
) objects WHERE name LIKE 'fixture_role_probe_%'`;

export async function qualifyRoleNativeAccess({ Client, password, signal, applicationPid, deadlineMs = 120000 }) {
  const owner = new RoleNativeOwner(Client, { password, signal, deadlineMs });
  const input = await owner.bounded(roleNativeInputs), catalog = input['role-alignment-aligned.json'];
  const cases = futureObjectCases(catalog);
  const proof = { scope: 'native-role-access-defaults', status: 'failed', stage: 'preimage',
    login_roles: [], set_role_pairs: 0, administrative_denials: 0,
    expired_cli_scram_denied: false, wrong_password_denied: false, read_only_write_denied: false,
    future_objects: [], ordinary_creations: 0, instrumented_default_materializations: 0,
    storage_create_denials: 0, temporary_schema_grants_restored: false, failure_cleanup_observed: false,
    privilege_checks: 0, actual_object_reads: 0,
    all_objects_removed: false, original_aligned_catalog_restored: false, all_clients_closed: false,
    post_alignment_services: false, full_schema_ready: false, production_or_funded: false };
  const created = [];
  const objectOids = new Map();
  let bootstrap, storageGrantActive = false, ownedNamesAdmitted = false;
  const storageAcl = catalog.schemas.find((row) => row.name === 'storage').acl;
  const schemaAclSql = `SELECT ARRAY(SELECT a::text FROM unnest(nspacl) a ORDER BY a::text) AS acl
    FROM pg_namespace WHERE nspname='storage'`;
  const createSql = (entry) => {
    const name = objectIdentity(entry);
    return entry.type === 'r' ? 'CREATE TABLE ' + name + '(id integer)' : entry.type === 'S'
      ? 'CREATE SEQUENCE ' + name + ' START 7'
      : 'CREATE FUNCTION ' + name + '() RETURNS integer LANGUAGE sql AS $$ SELECT 7 $$';
  };
  async function restoreStorageGrant(cleanup = false) {
    if (!storageGrantActive) return;
    const admin = await owner.connect('supabase_admin', undefined, cleanup);
    try { await owner.query(admin, 'REVOKE CREATE ON SCHEMA storage FROM postgres RESTRICT', undefined, cleanup); }
    finally { await owner.close(admin); }
    const observer = await owner.connect('supabase_admin', { readOnly: true }, cleanup);
    try { assert.deepEqual((await owner.query(observer, schemaAclSql, undefined, cleanup)).rows, [{ acl: storageAcl }]); }
    finally { await owner.close(observer); }
    storageGrantActive = false;
  }
  async function removeOwnedObjects(cleanup = false) {
    assert.equal(ownedNamesAdmitted, true, 'FIXTURE_ROLE_NATIVE_OWNED_NAMES_REQUIRED');
    const admin = await owner.connect('supabase_admin', undefined, cleanup);
    try {
      for (const entry of [...cases].reverse()) {
        const kind = entry.type === 'f' ? 'FUNCTION' : entry.type === 'r' ? 'TABLE' : 'SEQUENCE';
        await owner.query(admin, 'DROP ' + kind + ' IF EXISTS ' + objectIdentity(entry) + (entry.type === 'f' ? '()' : ''), undefined, cleanup);
      }
      await owner.query(admin, 'DROP TABLE IF EXISTS public.fixture_role_probe_readonly', undefined, cleanup);
      await owner.query(admin, 'DROP ROLE IF EXISTS fixture_role_probe_forbidden', undefined, cleanup);
    } finally { await owner.close(admin); }
    const observer = await owner.connect('supabase_admin', { readOnly: true }, cleanup);
    try { assert.deepEqual((await owner.query(observer, existenceSql, undefined, cleanup)).rows, [{ objects: 0 }]); }
    finally { await owner.close(observer); }
  }
  async function denyLogin(role, suppliedPassword) {
    const r = owner.make(role, { tcp: true, password: suppliedPassword });
    let denied = false;
    try { await owner.bounded(() => r.client.connect()); } catch (error) { assert.equal(error.code, '28P01'); denied = true; }
    finally { await owner.close(r); }
    assert.ok(denied, 'FIXTURE_ROLE_NATIVE_LOGIN_EXPECTED_DENIAL');
  }
  try {
    await owner.snapshot(catalog, applicationPid);
    bootstrap = await owner.connect('supabase_admin');
    assert.deepEqual((await owner.query(bootstrap, existenceSql)).rows, [{ objects: 0 }]);
    ownedNamesAdmitted = true;
    proof.stage = 'expired-cli';
    const credential = (await owner.query(bootstrap, `SELECT rolpassword AS verifier, rolvaliduntil < clock_timestamp() AS expired
      FROM pg_authid WHERE rolname='cli_login_postgres'`)).rows[0];
    assert.equal(credential.expired, true);
    verifySyntheticScram(password, credential.verifier);
    await denyLogin('cli_login_postgres', password);
    proof.expired_cli_scram_denied = true;
    await denyLogin('authenticator', password === '0'.repeat(64) ? '1'.repeat(64) : '0'.repeat(64));
    proof.wrong_password_denied = true;
    await owner.close(bootstrap);
    const roles = catalog.roles.filter((r) => r.login && !r.superuser && r.name !== 'cli_login_postgres');
    const targets = catalog.roles.filter((r) => !r.name.startsWith('pg_') || catalog.memberships.some((m) => m.role === r.name));
    proof.stage = 'ordinary-role-matrix';
    for (const role of roles) {
      const actor = await owner.connect(role.name, { tcp: role.name !== 'postgres' });
      proof.login_roles.push({ name: role.name, authentication: role.name === 'postgres' ? 'peer' : 'scram-sha-256' });
      const expected = reachableRoles(catalog, role.name, 'set');
      for (const target of targets) {
        let allowed = true;
        try { await owner.query(actor, 'SET ROLE ' + ident(target.name)); }
        catch (error) { assert.equal(error.code, '42501'); allowed = false; }
        assert.equal(allowed, expected.has(target.name), 'FIXTURE_ROLE_NATIVE_SET_ROLE_MATRIX');
        if (allowed) assert.deepEqual((await owner.query(actor, 'SELECT current_user AS role')).rows, [{ role: target.name }]);
        await owner.query(actor, 'RESET ROLE');
        proof.set_role_pairs++;
      }
      if (!role.create_role) {
        let denied = false;
        try { await owner.query(actor, 'CREATE ROLE fixture_role_probe_forbidden'); }
        catch (error) { assert.ok(['42501','25006'].includes(error.code)); denied = true; }
        assert.ok(denied, 'FIXTURE_ROLE_NATIVE_ROLE_ADMIN_DENIAL'); proof.administrative_denials++;
      }
      if (role.name === 'supabase_read_only_user') {
        let denied = false;
        try { await owner.query(actor, 'CREATE TABLE public.fixture_role_probe_readonly(id integer)'); }
        catch (error) { assert.equal(error.code, '25006'); denied = true; }
        assert.ok(denied); proof.read_only_write_denied = true;
      }
      await owner.close(actor);
    }
    proof.stage = 'future-object-create';
    for (const entry of cases) {
      const name = objectIdentity(entry);
      const instrumented = entry.creator === 'postgres' && entry.schema === 'storage';
      if (instrumented) {
        const original = await owner.connect('postgres');
        try {
          let denied = false;
          try { await owner.query(original, createSql(entry)); }
          catch (error) { assert.equal(error.code, '42501'); denied = true; }
          assert.ok(denied, 'FIXTURE_ROLE_NATIVE_STORAGE_CREATE_DENIAL');
          proof.storage_create_denials++;
        } finally { await owner.close(original); }
        const admin = await owner.connect('supabase_admin');
        try {
          assert.deepEqual((await owner.query(admin, schemaAclSql)).rows, [{ acl: storageAcl }]);
          storageGrantActive = true;
          await owner.query(admin, 'GRANT CREATE ON SCHEMA storage TO postgres');
        } finally { await owner.close(admin); }
      }
      const creator = await owner.connect(entry.creator, { tcp: entry.creator === 'supabase_auth_admin' });
      try {
        await owner.query(creator, 'BEGIN');
        await owner.query(creator, createSql(entry));
        if (entry.type === 'r') await owner.query(creator, 'INSERT INTO ' + name + ' VALUES (7)');
        lastCommand(await owner.query(creator, 'COMMIT'), 'COMMIT');
        created.push(entry);
        if (instrumented) proof.instrumented_default_materializations++;
        else proof.ordinary_creations++;
      } finally {
        await owner.close(creator);
        await restoreStorageGrant(true);
      }
      const observer = await owner.connect('supabase_admin', { readOnly: true });
      try {
        const args = entry.type === 'f' ? [name + '()'] : [name, entry.type];
        const rows = (await owner.query(observer, aclSql(entry), args)).rows;
        const objectOid = rows[0]?.object_oid;
        assert.ok(Number.isInteger(objectOid) && objectOid > 0 && objectOid <= 4294967295,
          'FIXTURE_ROLE_NATIVE_OBJECT_IDENTITY');
        assert.ok(rows.length > 0 && rows.every((r) => r.owner === entry.creator && r.object_oid === objectOid));
        objectOids.set(name, objectOid);
        const actual = rows.map(({ owner: ignored, object_oid: ignoredOid, ...row }) => ({ grantor: row.grantor, grantee: row.grantee, privilege: row.privilege, grantable: row.grantable })).sort((a,b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
        assert.deepEqual(actual, expectedFutureAcl(entry), 'FIXTURE_ROLE_NATIVE_FUTURE_ACL');
        proof.future_objects.push({ creator: entry.creator, schema: entry.schema, type: entry.type, creation: instrumented ? 'instrumented-latent-default' : 'ordinary', direct_acl_sha256: digest(JSON.stringify(actual)) });
      } finally { await owner.close(observer); }
    }
    assert.equal(proof.ordinary_creations, 24);
    assert.equal(proof.instrumented_default_materializations, 3);
    assert.equal(proof.storage_create_denials, 3);
    assert.equal(storageGrantActive, false);
    proof.temporary_schema_grants_restored = true;
    proof.stage = 'future-effective-access';
    for (const role of roles) {
      const actor = await owner.connect(role.name, { tcp: role.name !== 'postgres' });
      try {
        for (const entry of cases) {
          const name = objectIdentity(entry), objectOid = objectOids.get(name);
          assert.ok(Number.isInteger(objectOid) && objectOid > 0 && objectOid <= 4294967295,
            'FIXTURE_ROLE_NATIVE_OBJECT_IDENTITY');
          // Text-name lookup itself requires schema USAGE. Use the OID captured
          // by the separate read-only observer to test object ACLs independently;
          // the real schema-qualified reads below still enforce schema access.
          const fn = entry.type === 'r' ? 'has_table_privilege' : entry.type === 'S' ? 'has_sequence_privilege' : 'has_function_privilege';
          for (const privilege of privileges[entry.type]) {
            const result = (await owner.query(actor, `SELECT ${fn}(current_user,$1::oid,$2) AS allowed, ${fn}(current_user,$1::oid,$3) AS grantable`, [objectOid, privilege, privilege + ' WITH GRANT OPTION'])).rows[0];
            assert.deepEqual(result, { allowed: expectedFuturePrivilege(catalog, entry, role.name, privilege), grantable: expectedFuturePrivilege(catalog, entry, role.name, privilege, true) });
            proof.privilege_checks++;
          }
          const readPrivilege = entry.type === 'f' ? 'EXECUTE' : 'SELECT';
          const expected = expectedFuturePrivilege(catalog, entry, role.name, readPrivilege) && expectedSchemaUsage(catalog, entry.schema, role.name);
          let allowed = true;
          try {
            const query = entry.type === 'f' ? 'SELECT ' + name + '() AS value' : entry.type === 'S' ? 'SELECT last_value::integer AS value FROM ' + name : 'SELECT id AS value FROM ' + name;
            assert.deepEqual((await owner.query(actor, query)).rows, [{ value: 7 }]);
          } catch (error) { assert.equal(error.code, '42501'); allowed = false; }
          assert.equal(allowed, expected, 'FIXTURE_ROLE_NATIVE_ACTUAL_OBJECT_READ');
          proof.actual_object_reads++;
        }
      } finally { await owner.close(actor); }
    }
    proof.stage = 'cleanup';
    await removeOwnedObjects();
    proof.all_objects_removed = true;
    await owner.snapshot(catalog, applicationPid);
    proof.original_aligned_catalog_restored = true;
  } catch {
    throw Object.assign(new Error('FIXTURE_ROLE_NATIVE_ACCESS_FAILED'), { proof });
  } finally {
    try {
      await owner.closeAll();
      if (ownedNamesAdmitted && !proof.original_aligned_catalog_restored) {
        await restoreStorageGrant(true);
        await removeOwnedObjects(true);
        await owner.snapshot(catalog, applicationPid, true);
        proof.failure_cleanup_observed = true;
      }
      await owner.closeAll();
      proof.all_clients_closed = true;
    }
    catch { throw Object.assign(new Error('FIXTURE_ROLE_NATIVE_ACCESS_CLEANUP_FAILED'), { proof }); }
  }
  proof.status = 'passed'; proof.stage = 'complete';
  return proof;
}
