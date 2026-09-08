import pg from 'pg';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// Only the isolated test cluster created by run-isolated.sh may execute this probe.
assert.ok(process.env.PGHOST?.startsWith('/'), 'Requires an isolated Unix socket');
assert.ok(['journal_test', 'lease_test'].includes(process.env.PGUSER), 'Requires test DB owner');
const root = new URL('../../../../../', import.meta.url);
const migration = fs.readFileSync(
  new URL('supabase/migrations/20260908221010_lease_heartbeats_skip_busy_generations.sql', root),
  'utf8'
);
const schema = 'lease_heartbeat_probe';
const remap = (sql) =>
  sql
    .replaceAll('public.', schema + '.')
    .replaceAll("'public', 'pg_temp'", "'" + schema + "', 'pg_temp'");
const control = new pg.Client();
const holder = new pg.Client();
const heartbeat = new pg.Client();
const clients = [control, holder, heartbeat];
const id = (n) => '00000000-0000-4000-8000-' + String(n).padStart(12, '0');
let checks = 0;
try {
  await Promise.all(clients.map((client) => client.connect()));
  await control.query(`CREATE SCHEMA ${schema};
    DO $roles$ BEGIN
      IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon; END IF;
      IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated; END IF;
      IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role; END IF;
    END $roles$;
    CREATE FUNCTION ${schema}.fn_engine_lease_stale_seconds() RETURNS integer
    LANGUAGE sql IMMUTABLE AS 'SELECT 30';`);
  for (const scope of ['table', 'tournament']) {
    await control.query(`CREATE TABLE ${schema}.engine_${scope}_leases(
      ${scope}_id uuid PRIMARY KEY, instance_id text NOT NULL,
      protocol_version integer NOT NULL, lease_generation uuid NOT NULL,
      heartbeat_at timestamptz NOT NULL);`);
    const file =
      scope === 'table'
        ? '20260908043100_table_leases_and_hand_commits_have_generations.sql'
        : '20260908042900_tournament_leases_have_fencing_generations.sql';
    const baseline = fs.readFileSync(new URL('supabase/migrations/' + file, root), 'utf8');
    const name = 'heartbeat_' + scope + '_leases_v3';
    const start = baseline.indexOf('CREATE OR REPLACE FUNCTION public.' + name + '(');
    const end = baseline.indexOf('COMMENT ON FUNCTION public.' + name, start);
    await control.query(remap(baseline.slice(start, end)));
  }
  await control.query(remap(migration));
  await heartbeat.query("SET lock_timeout='250ms'; SET statement_timeout='3s'");
  for (const scope of ['table', 'tournament']) {
    const key = scope + '_id';
    const table = schema + '.engine_' + scope + '_leases';
    const name = schema + '.heartbeat_' + scope + '_leases_';
    const claims = [1, 2].map((n) => ({ [key]: id(n), lease_generation: id(10 + n) }));
    await control.query(
      `INSERT INTO ${table} VALUES
      ($1,'engine',2,$2,clock_timestamp()-interval '5 seconds'),
      ($3,'engine',2,$4,clock_timestamp()-interval '5 seconds')`,
      [id(1), id(11), id(2), id(12)]
    );
    const before = (await control.query(`SELECT ${key},heartbeat_at FROM ${table} ORDER BY ${key}`))
      .rows;
    await holder.query('BEGIN');
    await holder.query(`SELECT 1 FROM ${table} WHERE ${key}=$1 FOR SHARE`, [id(1)]);
    // Reproduce the real defect against the old deployable function.
    await assert.rejects(
      heartbeat.query(`SELECT * FROM ${name}v3($1,$2::jsonb,30)`, [
        'engine',
        JSON.stringify(claims),
      ]),
      { code: '55P03' }
    );
    checks++;
    const reply = (
      await heartbeat.query(`SELECT * FROM ${name}v4($1,$2::jsonb,30)`, [
        'engine',
        JSON.stringify(claims),
      ])
    ).rows;
    const byId = new Map(reply.map((row) => [row[key], row]));
    assert.equal(byId.get(id(1)).state, 'busy');
    assert.equal(byId.get(id(2)).state, 'kept');
    assert.equal(byId.get(id(1)).lease_generation, id(11));
    checks += 3;
    const after = (await control.query(`SELECT ${key},heartbeat_at FROM ${table} ORDER BY ${key}`))
      .rows;
    assert.equal(after[0].heartbeat_at.getTime(), before[0].heartbeat_at.getTime());
    assert.ok(after[1].heartbeat_at > before[1].heartbeat_at);
    checks += 2;
    // The settlement's shared lock still prevents a concurrent generation change.
    await assert.rejects(
      heartbeat.query(`UPDATE ${table} SET lease_generation=$2 WHERE ${key}=$1`, [id(1), id(99)]),
      { code: '55P03' }
    );
    checks++;
    await holder.query('COMMIT');
    const retry = (
      await heartbeat.query(`SELECT * FROM ${name}v4($1,$2::jsonb,30)`, [
        'engine',
        JSON.stringify(claims),
      ])
    ).rows;
    assert.ok(retry.every((row) => row.state === 'kept'));
    checks++;
    await control.query(
      `UPDATE ${table} SET heartbeat_at=clock_timestamp()-interval '31 seconds' WHERE ${key}=$1`,
      [id(1)]
    );
    const stale = (
      await heartbeat.query(`SELECT * FROM ${name}v4($1,$2::jsonb,30)`, [
        'engine',
        JSON.stringify(claims),
      ])
    ).rows;
    assert.equal(stale.find((row) => row[key] === id(1)).state, 'stale');
    const remainsStale = (
      await control.query(
        `SELECT heartbeat_at < clock_timestamp()-interval '30 seconds' AS stale FROM ${table} WHERE ${key}=$1`,
        [id(1)]
      )
    ).rows[0].stale;
    assert.equal(remainsStale, true);
    checks += 2;
    const wrong = [{ [key]: id(2), lease_generation: id(99) }];
    const taken = (
      await heartbeat.query(`SELECT * FROM ${name}v4($1,$2::jsonb,30)`, [
        'engine',
        JSON.stringify(wrong),
      ])
    ).rows[0];
    assert.equal(taken.state, 'taken');
    const otherOwner = (
      await heartbeat.query(`SELECT * FROM ${name}v4($1,$2::jsonb,30)`, [
        'another-engine',
        JSON.stringify([claims[1]]),
      ])
    ).rows[0];
    assert.equal(otherOwner.state, 'taken');
    const missing = (
      await heartbeat.query(`SELECT * FROM ${name}v4($1,$2::jsonb,30)`, [
        'engine',
        JSON.stringify([{ [key]: id(77), lease_generation: id(88) }]),
      ])
    ).rows[0];
    assert.equal(missing.state, 'missing');
    checks += 3;
    for (const payload of [
      null,
      {},
      [claims[1], claims[1]],
      [{ [key]: id(2) }],
      [{ [key]: id(2), lease_generation: 'bad-uuid' }],
    ]) {
      await assert.rejects(
        heartbeat.query(`SELECT * FROM ${name}v4($1,$2::jsonb,30)`, [
          'engine',
          JSON.stringify(payload),
        ]),
        (error) => ['22023', '22P02'].includes(error.code)
      );
      checks++;
    }
    await assert.rejects(
      heartbeat.query(`SELECT * FROM ${name}v4($1,$2::jsonb,60)`, [
        'engine',
        JSON.stringify(claims),
      ]),
      { code: '22023' }
    );
    checks++;
    const grants = (
      await control.query(
        `SELECT
      has_function_privilege('anon',$1,'EXECUTE') AS anon,
      has_function_privilege('authenticated',$1,'EXECUTE') AS authenticated,
      has_function_privilege('service_role',$1,'EXECUTE') AS service_role`,
        [name + 'v4(text,jsonb,integer)']
      )
    ).rows[0];
    assert.deepEqual(grants, { anon: false, authenticated: false, service_role: true });
    checks++;
    console.log(
      scope +
        ': old heartbeat blocked; new heartbeat isolated the locked row; authority and grants preserved'
    );
  }
  console.log('Lease heartbeat concurrency: ' + checks + ' assertions passed');
} finally {
  await holder.query('ROLLBACK').catch(() => {});
  await control.query('DROP SCHEMA IF EXISTS ' + schema + ' CASCADE').catch(() => {});
  await Promise.all(clients.map((client) => client.end()));
}
