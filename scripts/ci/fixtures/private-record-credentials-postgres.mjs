import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import {
  installGatewayCredential,
  roleAdmissionSql,
  assertRoleAdmission,
} from '../private-record-gateway-credentials.mjs';
const require = createRequire(new URL('../../../server/package.json', import.meta.url));
const { Client } = require('pg');
const password = 'f'.repeat(96);
const canonical =
  'postgresql://postgres:unrelated-fixture@db.kuklfnapbkmacvwxktbh.supabase.co:5432/postgres';
const admin = new Client({
  host: process.argv[2],
  port: 57649,
  user: 'postgres',
  database: 'postgres',
});
const tls = { ca: readFileSync(process.argv[3], 'utf8'), rejectUnauthorized: true };
const ownClient = () =>
  new Client({
    host: '127.0.0.1',
    port: 57649,
    user: 'ca_record_gateway',
    password,
    database: 'postgres',
    ssl: tls,
  });
const verify = async () => {
  const own = ownClient();
  try {
    await own.connect();
    assertRoleAdmission((await own.query(roleAdmissionSql)).rows[0].admission);
    await own.query('LISTEN ca_private_record_changes');
    await own.query('UNLISTEN ca_private_record_changes');
    assert.equal(
      (await own.query('SELECT current_user AS role')).rows[0].role,
      'ca_record_gateway'
    );
  } finally {
    await own.end();
  }
};
const install = () =>
  installGatewayCredential({
    admin,
    newPassword: password,
    adminConnection: canonical,
    operationId: '7401',
    verify,
  });
await admin.connect();
try {
  const creator = (
    await admin.query('SELECT rolsuper,rolcreaterole FROM pg_roles WHERE rolname=current_user')
  ).rows[0];
  assert.equal(creator.rolsuper, false);
  assert.equal(creator.rolcreaterole, true);
  const initial = (await admin.query(roleAdmissionSql)).rows[0].admission;
  assertRoleAdmission(initial);
  // Provider extensions can expose relation grants without exposing their
  // namespace. Prove effective denial, rather than exempting a schema by name.
  await admin.query(`
    CREATE SCHEMA inaccessible_fixture;
    REVOKE ALL ON SCHEMA inaccessible_fixture FROM PUBLIC;
    CREATE TABLE inaccessible_fixture.table_grants(id integer);
    INSERT INTO inaccessible_fixture.table_grants VALUES (1);
    GRANT ALL ON inaccessible_fixture.table_grants TO PUBLIC;
    CREATE TABLE inaccessible_fixture.column_grants(id integer);
    GRANT SELECT, INSERT(id), UPDATE(id), REFERENCES(id)
      ON inaccessible_fixture.column_grants TO PUBLIC;
    CREATE FUNCTION inaccessible_fixture.unsafe_definer() RETURNS void
      LANGUAGE sql SECURITY DEFINER
      AS $$ INSERT INTO inaccessible_fixture.table_grants VALUES (2) $$;
  `);
  const inaccessible = (await admin.query(roleAdmissionSql)).rows[0].admission;
  assertRoleAdmission(inaccessible);
  assert.deepEqual(inaccessible.inaccessibleRelationGrants.sort(), [
    'inaccessible_fixture.column_grants',
    'inaccessible_fixture.table_grants',
  ]);
  assert.deepEqual(inaccessible.writableRelations, []);
  assert.deepEqual(inaccessible.executableDefiners, []);
  await admin.query('GRANT USAGE ON SCHEMA inaccessible_fixture TO PUBLIC');
  const reachable = (await admin.query(roleAdmissionSql)).rows[0].admission;
  assert.deepEqual(reachable.writableRelations.sort(), [
    'inaccessible_fixture.column_grants',
    'inaccessible_fixture.table_grants',
  ]);
  assert.ok(
    reachable.executableDefiners.some(
      (routine) => routine.name === 'inaccessible_fixture.unsafe_definer'
    )
  );
  await assert.rejects(install(), /PUBLIC privileges/);
  await admin.query('REVOKE USAGE ON SCHEMA inaccessible_fixture FROM PUBLIC');
  assert.deepEqual(initial.memberships, [
    {
      role: 'ca_record_gateway',
      member: 'postgres',
      admin: true,
      inherit: false,
      set: false,
      memberSuperuser: false,
      memberCreateRole: true,
    },
  ]);
  assert.equal(
    (await admin.query("SELECT rolcanlogin FROM pg_roles WHERE rolname='ca_record_gateway'"))
      .rows[0].rolcanlogin,
    false
  );
  await admin.query(
    'CREATE TABLE public.financial_fixture(id integer); REVOKE ALL ON public.financial_fixture FROM PUBLIC'
  );
  await admin.query('GRANT INSERT ON public.financial_fixture TO PUBLIC');
  await assert.rejects(install(), /PUBLIC privileges/);
  assert.equal(
    (await admin.query("SELECT rolcanlogin FROM pg_roles WHERE rolname='ca_record_gateway'"))
      .rows[0].rolcanlogin,
    false
  );
  await admin.query('REVOKE INSERT ON public.financial_fixture FROM PUBLIC');
  await admin.query('GRANT UPDATE(id) ON public.financial_fixture TO PUBLIC');
  await assert.rejects(install(), /PUBLIC privileges/);
  await admin.query('REVOKE UPDATE(id) ON public.financial_fixture FROM PUBLIC');
  await admin.query(
    'CREATE FUNCTION public.unsafe_financial_fixture() RETURNS void LANGUAGE sql SECURITY DEFINER AS $$ INSERT INTO public.financial_fixture VALUES(1) $$'
  );
  await assert.rejects(install(), /privileged routine/);
  await admin.query('DROP FUNCTION public.unsafe_financial_fixture()');
  // The listener must never inherit or SET another application/admin role.
  await admin.query(
    'CREATE ROLE forbidden_listener_parent NOLOGIN; GRANT forbidden_listener_parent TO ca_record_gateway'
  );
  await assert.rejects(install(), /membership/);
  await admin.query('REVOKE forbidden_listener_parent FROM ca_record_gateway');
  // Nor may another actor receive a listener membership/administration edge.
  await admin.query(
    'CREATE ROLE unexpected_listener_admin NOLOGIN; GRANT ca_record_gateway TO unexpected_listener_admin WITH ADMIN TRUE, INHERIT FALSE, SET FALSE'
  );
  await assert.rejects(install(), /membership/);
  await admin.query('REVOKE ca_record_gateway FROM unexpected_listener_admin');
  // A broader trusted-creator edge is also refused; restore its PG17 shape.
  const seed = new Client({
    host: process.argv[2],
    port: 57649,
    user: 'fixture_admin',
    database: 'postgres',
  });
  await seed.connect();
  try {
    // Only the fixture's original bootstrap grantor changes this edge. PG17
    // correctly refuses a nonsuperuser granting ADMIN back to its own grantor.
    await seed.query(
      'GRANT ca_record_gateway TO postgres WITH ADMIN TRUE, INHERIT FALSE, SET TRUE'
    );
    await assert.rejects(install(), /membership/);
    await seed.query(
      'GRANT ca_record_gateway TO postgres WITH ADMIN TRUE, INHERIT FALSE, SET FALSE'
    );
  } finally {
    await seed.end();
  }
  assert.equal((await install()).status, 'installed');
  assert.equal((await install()).status, 'already-ready');
  const own = ownClient();
  try {
    await own.connect();
    await assert.rejects(
      own.query('INSERT INTO public.financial_fixture VALUES(1)'),
      (error) => error.code === '42501'
    );
    for (const query of [
      'INSERT INTO inaccessible_fixture.table_grants VALUES (3)',
      'UPDATE inaccessible_fixture.table_grants SET id=3',
      'DELETE FROM inaccessible_fixture.table_grants',
      'TRUNCATE inaccessible_fixture.table_grants',
      'INSERT INTO inaccessible_fixture.column_grants(id) VALUES (3)',
      'UPDATE inaccessible_fixture.column_grants SET id=3',
      'SELECT inaccessible_fixture.unsafe_definer()',
      'CREATE TEMP TABLE reference_fixture(id integer REFERENCES inaccessible_fixture.table_grants(id))',
    ])
      await assert.rejects(own.query(query), (error) => error.code === '42501');
    // A later USAGE grant changes effective access and must refuse an existing
    // credential too, before the installer can report already-ready or rotate it.
    const marker = (await admin.query(roleAdmissionSql)).rows[0].admission.role.marker;
    await admin.query('GRANT USAGE ON SCHEMA inaccessible_fixture TO PUBLIC');
    await assert.rejects(install(), /PUBLIC privileges/);
    assert.equal((await admin.query(roleAdmissionSql)).rows[0].admission.role.marker, marker);
    await admin.query('REVOKE USAGE ON SCHEMA inaccessible_fixture FROM PUBLIC');
    assertRoleAdmission((await own.query(roleAdmissionSql)).rows[0].admission);
    assert.equal(
      (await admin.query('SELECT count(*)::integer AS n FROM inaccessible_fixture.table_grants'))
        .rows[0].n,
      1
    );
    assert.equal(
      (await admin.query('SELECT count(*)::integer AS n FROM inaccessible_fixture.column_grants'))
        .rows[0].n,
      0
    );
    await own.query('LISTEN ca_private_record_changes');
    const notification = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(Error('local committed signal missing')), 3000);
      own.once('notification', (value) => {
        clearTimeout(timeout);
        resolve(value);
      });
    });
    await admin.query("NOTIFY ca_private_record_changes, 'isolated-qualification'");
    assert.equal((await notification).payload, 'isolated-qualification');
    await own.query('UNLISTEN ca_private_record_changes');
  } finally {
    await own.end();
  }
  const wrong = new Client({
    host: '127.0.0.1',
    port: 57649,
    user: 'ca_record_gateway',
    password: 'e'.repeat(96),
    database: 'postgres',
    ssl: tls,
  });
  try {
    await assert.rejects(wrong.connect(), (error) => error.code === '28P01');
  } finally {
    await wrong.end();
  }
  const untrusted = new Client({
    host: '127.0.0.1',
    port: 57649,
    user: 'ca_record_gateway',
    password,
    database: 'postgres',
    ssl: { rejectUnauthorized: true },
  });
  try {
    await assert.rejects(untrusted.connect(), /certificate/);
  } finally {
    await untrusted.end();
  }
  assert.equal(
    (await admin.query('SELECT count(*)::integer AS n FROM public.financial_fixture')).rows[0].n,
    0
  );
  console.log(
    'Native NOSUPERUSER CREATEROLE creator/credential installer, exact ADMIN edge, verified TLS/SCRAM and inherited privilege gates PASS'
  );
} finally {
  await admin.end();
}
