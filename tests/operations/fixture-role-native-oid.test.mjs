import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { pbkdf2Sync, createHash, createHmac } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const subject = process.env.ROLE_NATIVE_ACCESS_SUBJECT
  ? pathToFileURL(process.env.ROLE_NATIVE_ACCESS_SUBJECT)
  : new URL('../../operations/release/fixture/role-native-access.mjs', import.meta.url);
const access = await import(subject.href);
const protocol = await import(new URL('./role-native-protocol.mjs', subject).href);
const catalog = (await protocol.roleNativeInputs())['role-alignment-aligned.json'];
const password = 'a'.repeat(64);
const salt = Buffer.alloc(16, 1), salted = pbkdf2Sync(password, salt, 4096, 32, 'sha256');
const stored = createHash('sha256').update(createHmac('sha256', salted).update('Client Key').digest()).digest('base64');
const server = createHmac('sha256', salted).update('Server Key').digest('base64');
const verifier = `SCRAM-SHA-256$4096:${salt.toString('base64')}$${stored}:${server}`;
const qualified = (entry) => `"${entry.schema}"."${entry.name}"`;
const refusal = (code) => Object.assign(new Error('controlled PostgreSQL refusal'), { code });

// This is a portable protocol regression, not a PostgreSQL emulator or native
// qualification. Its one independent engine rule comes from PostgreSQL17.11:
// text object-name resolution requires schema USAGE before has_*_privilege.
// Existing catalog/ACL oracles supply expected values for unrelated operations.
function fixture(identityMode = 'valid') {
  const cases = access.futureObjectCases(catalog);
  const objects = new Map(), clients = [], nameLookups = [], reads = [];
  let grant = false;
  class Client extends EventEmitter {
    constructor(config) { super(); this.config = config; this.processID = clients.length + 100; this.role = config.user; clients.push(this); }
    async connect() {
      if (this.config.host === '127.0.0.1' && (this.config.user === 'cli_login_postgres' || this.config.password !== password)) throw refusal('28P01');
    }
    async end() { this.emit('end'); this.closed = true; }
    async query(request) {
      const text = typeof request === 'string' ? request : request.text;
      const values = request.values ?? [];
      const session = catalog.roles.find((row) => row.name === this.config.user);
      if (text.includes('SELECT pg_backend_pid() AS pid')) return { rows: [{ pid: this.processID, session_role: this.config.user, current_role: this.role, database: this.config.database, superuser: this.config.user === 'supabase_admin', tcp: this.config.host === '127.0.0.1', read_only: this.config.options?.includes('read_only=on') || this.config.user === 'supabase_read_only_user' ? 'on' : 'off' }] };
      if (text.includes("WHERE name LIKE 'fixture_role_probe_%'")) return { rows: [{ objects: objects.size }] };
      if (text.includes('SELECT rolpassword AS verifier')) return { rows: [{ verifier, expired: true }] };
      if (text.startsWith('SET ROLE ')) {
        const target = text.slice('SET ROLE '.length).replaceAll('"', '');
        if (!access.reachableRoles(catalog, this.config.user, 'set').has(target)) throw refusal('42501');
        this.role = target; return { command: 'SET', rows: [] };
      }
      if (text === 'SELECT current_user AS role') return { rows: [{ role: this.role }] };
      if (text === 'RESET ROLE') { this.role = this.config.user; return { command: 'RESET', rows: [] }; }
      if (text === 'CREATE ROLE fixture_role_probe_forbidden') { assert.equal(session.create_role, false); throw refusal('42501'); }
      if (text.startsWith('CREATE TABLE public.fixture_role_probe_readonly')) throw refusal('25006');
      if (text === 'BEGIN' || text === 'COMMIT') return { command: text, rows: [] };
      if (text.startsWith('GRANT CREATE ON SCHEMA storage')) { grant = true; return { command: 'GRANT', rows: [] }; }
      if (text.startsWith('REVOKE CREATE ON SCHEMA storage')) { grant = false; return { command: 'REVOKE', rows: [] }; }
      if (text.includes("FROM pg_namespace WHERE nspname='storage'")) {
        assert.equal(grant, false, 'check observes restored original storage ACL');
        return { rows: [{ acl: catalog.schemas.find((row) => row.name === 'storage').acl }] };
      }
      if (/^CREATE (TABLE|SEQUENCE|FUNCTION) /.test(text)) {
        const entry = cases.find((row) => text.includes(qualified(row)));
        assert.ok(entry, text); assert.equal(this.role, entry.creator);
        if (entry.creator === 'postgres' && entry.schema === 'storage' && !grant) throw refusal('42501');
        objects.set(qualified(entry), { entry, oid: 20000 + cases.indexOf(entry) });
        return { command: 'CREATE', rows: [] };
      }
      if (text.startsWith('INSERT INTO ')) return { command: 'INSERT', rows: [] };
      if (text.includes('CROSS JOIN LATERAL aclexplode')) {
        assert.equal(this.config.user, 'supabase_admin');
        assert.ok(this.config.options?.includes('read_only=on'));
        const object = objects.get(values[0].replace(/\(\)$/, '')); assert.ok(object);
        const rows = access.expectedFutureAcl(object.entry).map((row, index) => ({ owner: object.entry.creator, ...row,
          ...(text.includes('AS object_oid') ? { object_oid: identityMode === 'missing' ? undefined : identityMode === 'mixed' && index ? object.oid + 1 : object.oid } : {}) }));
        return { rows };
      }
      if (/^SELECT has_(table|sequence|function)_privilege/.test(text)) {
        const oidInput = text.includes('$1::oid');
        const object = oidInput ? [...objects.values()].find((row) => row.oid === values[0]) : objects.get(values[0].replace(/\(\)$/, ''));
        assert.ok(object, 'the privilege query binds to the object observed earlier');
        if (!oidInput) {
          nameLookups.push({ actor: this.role, schema: object.entry.schema, type: object.entry.type });
          if (!access.expectedSchemaUsage(catalog, object.entry.schema, this.role)) throw refusal('42501');
        }
        return { rows: [{ allowed: access.expectedFuturePrivilege(catalog, object.entry, this.role, values[1]), grantable: access.expectedFuturePrivilege(catalog, object.entry, this.role, values[1], true) }] };
      }
      if (/^SELECT (id AS value|last_value::integer AS value|"[a-z_]+"\.)/.test(text)) {
        const object = [...objects.values()].find((row) => text.includes(qualified(row.entry))); assert.ok(object, text);
        const permission = object.entry.type === 'f' ? 'EXECUTE' : 'SELECT';
        const allowed = access.expectedFuturePrivilege(catalog, object.entry, this.role, permission) && access.expectedSchemaUsage(catalog, object.entry.schema, this.role);
        reads.push({ actor: this.role, schema: object.entry.schema, type: object.entry.type, allowed });
        if (!allowed) throw refusal('42501');
        return { rows: [{ value: 7 }] };
      }
      if (text.startsWith('DROP ')) {
        const name = [...objects.keys()].find((key) => text.includes(key));
        if (name) objects.delete(name);
        return { command: 'DROP', rows: [] };
      }
      throw new Error('Unmodelled operation: ' + text);
    }
  }
  return { Client, objects, clients, nameLookups, reads, grantActive: () => grant };
}

async function run(fake) {
  const snapshot = protocol.RoleNativeOwner.prototype.snapshot;
  protocol.RoleNativeOwner.prototype.snapshot = async function (expected) {
    // Catalog snapshots themselves are not evaluated as native SQL here.
    assert.deepEqual(expected, catalog); assert.equal(fake.objects.size, 0);
    assert.equal(fake.grantActive(), false); return 'c'.repeat(64);
  };
  try { return await access.qualifyRoleNativeAccess({ Client: fake.Client, password, applicationPid: 99, deadlineMs: 10000 }); }
  finally { protocol.RoleNativeOwner.prototype.snapshot = snapshot; }
}

test('ordinary actors without schema USAGE still reach all object ACL comparisons, then actual named reads refuse', async (t) => {
  assert.equal(access.expectedSchemaUsage(catalog, 'storage', 'authenticator'), false);
  const fake = fixture();
  let proof;
  try { proof = await run(fake); }
  catch (error) {
    t.diagnostic(JSON.stringify({ stage: error.proof?.stage, privilegeChecks: error.proof?.privilege_checks,
      actualReads: error.proof?.actual_object_reads, lastNameLookup: fake.nameLookups.at(-1),
      objectsRemaining: fake.objects.size, failedCleanupObserved: error.proof?.failure_cleanup_observed }));
    throw error;
  }
  assert.equal(proof.status, 'passed');
  assert.equal(proof.set_role_pairs, 250);
  assert.equal(proof.ordinary_creations, 24); assert.equal(proof.instrumented_default_materializations, 3);
  assert.equal(proof.privilege_checks, 1080); assert.equal(proof.actual_object_reads, 270);
  assert.equal(fake.nameLookups.length, 0, 'object ACL checks must never trigger actor text-name resolution');
  assert.ok(fake.reads.some((row) => row.actor === 'authenticator' && row.schema === 'storage' && !row.allowed));
  assert.ok(fake.reads.some((row) => row.actor === 'postgres' && row.schema === 'public' && row.allowed));
  assert.equal(fake.objects.size, 0); assert.equal(fake.grantActive(), false);
  assert.ok(fake.clients.every((client) => client.closed));
  t.diagnostic(JSON.stringify({ privilegeChecks: proof.privilege_checks, actualReads: proof.actual_object_reads,
    namedReadsDenied: fake.reads.filter((row) => !row.allowed).length, objectNameLookups: fake.nameLookups.length }));
});

for (const mode of ['missing', 'mixed']) test(`observer ${mode} OID identity refuses before effective-access credit and cleans objects`, async () => {
  const fake = fixture(mode);
  await assert.rejects(run(fake), (error) => error.message === 'FIXTURE_ROLE_NATIVE_ACCESS_FAILED'
    && error.proof.stage === 'future-object-create' && error.proof.privilege_checks === 0
    && error.proof.failure_cleanup_observed === true);
  assert.equal(fake.objects.size, 0); assert.equal(fake.grantActive(), false);
  assert.ok(fake.clients.every((client) => client.closed));
});
