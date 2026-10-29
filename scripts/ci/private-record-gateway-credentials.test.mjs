import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  deriveGatewayConnection,
  assertRoleAdmission,
  gatewayScramVerifier,
  installGatewayCredential,
  disabledMarker,
  roleAdmissionSql,
  requireGatewaySourceReady,
} from './private-record-gateway-credentials.mjs';
const password = 'f'.repeat(96);
const canonical =
  'postgresql://postgres.kuklfnapbkmacvwxktbh:old-unrelated-credential@us-east-1.pooler.supabase.com:6543/postgres?sslmode=require&application_name=old';
const audit = () => ({
  role: {
    name: 'ca_record_gateway',
    login: false,
    superuser: false,
    inherit: false,
    createRole: false,
    createDb: false,
    replication: false,
    bypassRls: false,
    connectionLimit: 4,
    marker: disabledMarker,
  },
  memberships: [],
  ownedObjects: 0,
  canConnect: true,
  canCreateDatabaseObjects: false,
  writableRelations: [],
  creatableSchemas: [],
  executableDefiners: [],
});
function database({ value = audit(), loseCommit = false } = {}) {
  const queries = [];
  let snapshot;
  let lost = false;
  let changes = 0;
  const admin = {
    query: async (sql) => {
      queries.push(sql);
      if (sql === 'BEGIN') snapshot = structuredClone(value);
      if (sql === roleAdmissionSql) return { rows: [{ admission: structuredClone(value) }] };
      if (sql.includes('pg_try_advisory_xact_lock')) return { rows: [{ admitted: true }] };
      if (sql.startsWith('ALTER ROLE')) {
        assert.ok(!sql.includes(password));
        assert.match(sql, /SCRAM-SHA-256\$4096:/);
        value.role.login = true;
        changes++;
      }
      if (sql.startsWith('COMMENT ON ROLE')) value.role.marker = sql.match(/IS '([^']+)'/)[1];
      if (sql === 'COMMIT') {
        snapshot = null;
        if (loseCommit && !lost) {
          lost = true;
          throw Error('lost acknowledgment');
        }
      }
      if (sql === 'ROLLBACK' && snapshot) {
        value = structuredClone(snapshot);
        snapshot = null;
      }
      return { rows: [] };
    },
  };
  return {
    admin,
    queries,
    get value() {
      return value;
    },
    get changes() {
      return changes;
    },
  };
}
const install = (db, verify = async () => {}) =>
  installGatewayCredential({
    admin: db.admin,
    newPassword: password,
    adminConnection: canonical,
    operationId: '123',
    verify,
  });
test('new dedicated URL replaces old identity/password and moves documented pooler to session mode', () => {
  const url = new URL(deriveGatewayConnection(canonical, password));
  assert.equal(url.username, 'ca_record_gateway.kuklfnapbkmacvwxktbh');
  assert.equal(url.password, password);
  assert.equal(url.port, '5432');
  assert.equal(url.search, '');
  assert.ok(!url.toString().includes('old-unrelated-credential'));
  assert.equal(
    new URL(
      deriveGatewayConnection(
        'postgresql://postgres:old@db.kuklfnapbkmacvwxktbh.supabase.co:5432/postgres',
        password
      )
    ).username,
    'ca_record_gateway'
  );
  assert.throws(() =>
    deriveGatewayConnection('postgresql://postgres:old@other.example/postgres', password)
  );
  assert.throws(() => deriveGatewayConnection(canonical, 'copied-weak-password'));
});
test('PUBLIC table/column writes, privileged routine execution, membership and ownership deny admission', () => {
  for (const patch of [
    { memberships: [{ role: 'financial_writer', member: 'ca_record_gateway' }] },
    { ownedObjects: 1 },
    { writableRelations: ['public.chip_ledger'] },
    { creatableSchemas: ['public'] },
    { executableDefiners: [{ name: 'public.fn_credit_and_log', hash: 'a'.repeat(32) }] },
    { canCreateDatabaseObjects: true },
  ])
    assert.throws(() => assertRoleAdmission({ ...audit(), ...patch }));
  const missing = audit();
  delete missing.role.superuser;
  assert.throws(() => assertRoleAdmission(missing));
  const drift = audit();
  drift.executableDefiners = [{ name: 'public.get_daily_challenge', hash: '0'.repeat(32) }];
  assert.throws(() => assertRoleAdmission(drift));
  assert.match(roleAdmissionSql, /'inaccessibleRelationGrants'/);
  assert.match(
    roleAdmissionSql,
    /'writableRelations',[\s\S]*?AND has_schema_privilege\('ca_record_gateway',n\.oid,'USAGE'\) AND \(has_table_privilege/
  );
  assert.match(roleAdmissionSql, /has_any_column_privilege/);
  assert.match(roleAdmissionSql, /has_function_privilege/);
});
test('credential uses SCRAM verifier and never sends the canonical plaintext in SQL', async () => {
  const db = database();
  let verified = 0;
  await install(db, async (url) => {
    verified++;
    assert.equal(new URL(url).password, password);
  });
  assert.equal(verified, 1);
  assert.equal(db.changes, 1);
  assert.ok(db.value.role.login);
  assert.match(db.value.role.marker, /:123$/);
  assert.ok(db.queries.every((query) => !query.includes(password)));
  const verifier = gatewayScramVerifier(password, Buffer.alloc(16));
  assert.match(verifier, /^SCRAM-SHA-256\$4096:AAAAAAAAAAAAAAAAAAAAAA==\$/);
  assert.notEqual(verifier, password);
});
test('unknown enabled ownership cannot be rotated', async () => {
  const value = audit();
  value.role.login = true;
  value.role.marker = 'another owner';
  const db = database({ value });
  await assert.rejects(install(db), /unknown credential ownership/);
  assert.equal(db.changes, 0);
});
test('lost commit acknowledgment recovers from exact owned marker without rotation', async () => {
  const db = database({ loseCommit: true });
  await assert.rejects(install(db), /lost acknowledgment/);
  assert.ok(db.value.role.login);
  assert.equal(db.changes, 1);
  assert.equal((await install(db)).status, 'already-ready');
  assert.equal(db.changes, 1);
});
test('failed dedicated verification preserves committed ownership for readback/recovery', async () => {
  const db = database();
  await assert.rejects(
    install(db, async () => {
      throw Error('unavailable');
    }),
    /unavailable/
  );
  assert.ok(db.value.role.login);
  assert.equal((await install(db)).status, 'already-ready');
  assert.equal(db.changes, 1);
});
test('effective privileges are checked before enabling the role', async () => {
  const value = audit();
  value.writableRelations = ['public.cash_hand_provenance_receipts'];
  const db = database({ value });
  await assert.rejects(install(db), /PUBLIC privileges/);
  assert.equal(db.changes, 0);
  assert.equal(db.value.role.login, false);
});

test('PG17 trusted nonsuperuser creator ADMIN edge is not listener membership privilege', () => {
  const edge = {
    role: 'ca_record_gateway',
    member: 'postgres',
    admin: true,
    inherit: false,
    set: false,
    memberSuperuser: false,
    memberCreateRole: true,
  };
  const value = audit();
  value.memberships = [edge];
  assert.equal(assertRoleAdmission(value).name, 'ca_record_gateway');
  for (const patch of [
    { member: 'untrusted_admin' },
    { role: 'financial_writer', member: 'ca_record_gateway' },
    { admin: false },
    { inherit: true },
    { set: true },
    { memberSuperuser: true },
    { memberCreateRole: false },
  ]) {
    const denied = audit();
    denied.memberships = [{ ...edge, ...patch }];
    assert.throws(() => assertRoleAdmission(denied), /membership/);
  }
  const extra = audit();
  extra.memberships = [edge, edge];
  assert.throws(() => assertRoleAdmission(extra), /membership/);
});

test('dedicated source readiness requires actual true row before verification', async () => {
  const calls = [];
  await requireGatewaySourceReady({
    query: async (sql) => {
      calls.push(sql);
      return { rows: [{ ready: true }] };
    },
  });
  assert.deepEqual(calls, ['SELECT public.fn_private_record_transport_ready() AS ready']);
  for (const result of [
    { rows: [{ ready: false }] },
    { rows: [] },
    { rows: [{ ready: 'true' }] },
    {},
  ])
    await assert.rejects(requireGatewaySourceReady({ query: async () => result }), /not ready/);
  await assert.rejects(
    requireGatewaySourceReady({
      query: async () => {
        throw Error('permission denied');
      },
    }),
    /permission denied/
  );
});
test('only exact existing read-only readiness definition is admitted', () => {
  const value = audit();
  value.executableDefiners = [
    { name: 'public.fn_private_record_transport_ready', hash: '07c92fe5dc7018f15a23d34f9bb2b386' },
  ];
  assert.equal(assertRoleAdmission(value).name, 'ca_record_gateway');
  value.executableDefiners[0].hash = '0'.repeat(32);
  assert.throws(() => assertRoleAdmission(value), /unreviewed privileged/);
});
