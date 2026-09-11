#!/usr/bin/env node
/** Isolated native PG17 proof. Never uses a supplied database URL or live credentials. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(path.join(root, 'server/package.json'));
const { Client } = require('pg');
const pgbin = process.env.PG17_BINDIR ?? '/opt/homebrew/opt/postgresql@17/bin';
assert.match(
  execFileSync(path.join(pgbin, 'postgres'), ['--version'], { encoding: 'utf8' }),
  / 17\./
);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-lease-hedging-'));
const socket = path.join(dir, 'socket');
fs.mkdirSync(socket);
const run = (name, args) =>
  execFileSync(path.join(pgbin, name), args, {
    encoding: 'utf8',
    env: { ...process.env, LC_ALL: 'C' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
const clients = [];
let booted = false;
const connect = async (user = 'lease_test') => {
  const client = new Client({
    host: socket,
    port: 55447,
    user,
    database: 'postgres',
    password: '',
    ssl: false,
  });
  clients.push(client);
  await client.connect();
  return client;
};
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const claims = (scope, generation = 11) =>
  JSON.stringify([{ [`${scope}_id`]: id(1), lease_generation: id(generation) }]);
const heartbeat = (client, scope, generation = 11) =>
  client.query(`SELECT * FROM public.heartbeat_${scope}_leases_v4($1,$2::jsonb,30)`, [
    'engine',
    claims(scope, generation),
  ]);
try {
  run('initdb', [
    '-D',
    path.join(dir, 'data'),
    '-U',
    'lease_test',
    '-A',
    'trust',
    '--no-locale',
    '-E',
    'UTF8',
  ]);
  run('pg_ctl', [
    '-D',
    path.join(dir, 'data'),
    '-l',
    path.join(dir, 'postgres.log'),
    '-o',
    `-h '' -k '${socket}' -p 55447`,
    '-w',
    'start',
  ]);
  booted = true;
  const control = await connect();
  await control.query(`CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN;
    CREATE ROLE service_role LOGIN; ALTER ROLE service_role SET statement_timeout='8s';
    CREATE FUNCTION public.fn_engine_lease_stale_seconds() RETURNS integer LANGUAGE sql IMMUTABLE AS 'SELECT 30';`);
  for (const scope of ['table', 'tournament']) {
    await control.query(`CREATE TABLE public.engine_${scope}_leases(
      ${scope}_id uuid PRIMARY KEY, instance_id text NOT NULL, protocol_version integer NOT NULL,
      lease_generation uuid NOT NULL, heartbeat_at timestamptz NOT NULL);
      INSERT INTO public.engine_${scope}_leases VALUES ('${id(1)}','engine',2,'${id(11)}',clock_timestamp());`);
  }
  await control.query(
    fs.readFileSync(
      path.join(
        root,
        'supabase/migrations/20260908221010_lease_heartbeats_skip_busy_generations.sql'
      ),
      'utf8'
    )
  );
  const peers = await Promise.all(Array.from({ length: 6 }, () => connect('service_role')));
  for (const peer of peers)
    assert.equal((await peer.query('SHOW statement_timeout')).rows[0].statement_timeout, '8s');
  // Six actual independent DB sessions model both admitted scopes. Every 6s
  // request fits the measured role cap; neither scope waits for a JS peer.
  const started = performance.now();
  const six = peers.map(async (peer, i) => {
    await peer.query('SELECT pg_sleep(6)');
    return (await heartbeat(peer, i < 3 ? 'table' : 'tournament')).rows[0];
  });
  const replies = await Promise.all(six);
  assert.ok(replies.every((r) => ['kept', 'busy'].includes(r.state)));
  assert.ok(replies.slice(0, 3).some((r) => r.state === 'kept'));
  assert.ok(replies.slice(3).some((r) => r.state === 'kept'));
  const sixSecondMs = Math.round(performance.now() - started);
  assert.ok(sixSecondMs >= 5900 && sixSecondMs < 12000);
  const holder = await connect();
  for (const scope of ['table', 'tournament']) {
    const peer = peers[0];
    await holder.query('BEGIN');
    await holder.query(`SELECT 1 FROM public.engine_${scope}_leases FOR UPDATE`);
    const busyStart = performance.now();
    assert.equal((await heartbeat(peer, scope)).rows[0].state, 'busy');
    assert.ok(performance.now() - busyStart < 2000);
    const other = scope === 'table' ? 'tournament' : 'table';
    assert.equal((await heartbeat(peers[1], other)).rows[0].state, 'kept');
    await holder.query('ROLLBACK');

    // The request is genuinely executing on its DB connection before takeover.
    const delayed = peer.query('SELECT pg_sleep(0.25)').then(() => heartbeat(peer, scope));
    await control.query(
      `UPDATE public.engine_${scope}_leases SET instance_id='successor', lease_generation=$1 WHERE ${scope}_id=$2`,
      [id(99), id(1)]
    );
    assert.equal((await delayed).rows[0].state, 'taken');
    const preserved = (
      await control.query(`SELECT instance_id,lease_generation FROM public.engine_${scope}_leases`)
    ).rows[0];
    assert.deepEqual(preserved, { instance_id: 'successor', lease_generation: id(99) });
    await control.query(
      `UPDATE public.engine_${scope}_leases SET instance_id='engine',lease_generation=$1,heartbeat_at=clock_timestamp()-interval '31s'`,
      [id(11)]
    );
    assert.equal((await heartbeat(peer, scope)).rows[0].state, 'stale');
    await control.query(`UPDATE public.engine_${scope}_leases SET heartbeat_at=clock_timestamp()`);
  }
  const boundedStart = performance.now();
  await assert.rejects(peers[0].query('SELECT pg_sleep(30)'), { code: '57014' });
  const boundedMs = Math.round(performance.now() - boundedStart);
  assert.ok(boundedMs >= 7800 && boundedMs < 12000);
  assert.equal((await heartbeat(peers[0], 'table')).rows[0].state, 'kept');
  console.log(
    JSON.stringify(
      {
        result: 'PASS',
        postgres: '17',
        sixRealConnections: 6,
        sixSecondMs,
        roleStatementTimeoutMs: 8000,
        boundedMs,
        scopes: ['table', 'tournament'],
        proof: [
          'busy does not block peer scope',
          'delayed old generation cannot renew successor',
          'stale generation cannot revive',
          'role cap terminates actual DB statement',
        ],
        limit:
          'Isolated PostgreSQL role configuration is proved; live PostgREST role-setting and pool consumption require installed readback.',
      },
      null,
      2
    )
  );
} finally {
  await Promise.allSettled(clients.map((client) => client.end()));
  if (booted) run('pg_ctl', ['-D', path.join(dir, 'data'), '-m', 'immediate', '-w', 'stop']);
  fs.rmSync(dir, { recursive: true, force: true });
}
