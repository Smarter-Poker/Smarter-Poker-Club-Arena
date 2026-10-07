import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import {
  connection,
  descriptor,
  primaryRef,
  primaryQuery,
  query,
  verify,
} from './leaderboard-schema-replica.mjs';

const identifier = 'abcdefghijklmnopqrst';
const input = {
  identifier,
  database_type: 'READ_REPLICA',
  db_host: 'aws-0-us-west-2.pooler.supabase.com',
  db_port: 6543,
  db_user: `postgres.${identifier}`,
  db_name: 'postgres',
  pool_mode: 'transaction',
};
const primary = `postgresql://postgres.${primaryRef}:synthetic%40password@aws-0-us-west-2.pooler.supabase.com:6543/postgres?sslmode=require&connect_timeout=10`;
const fence = { version_num: '170006', current_wal_lsn: '1/FFFFFFFF' };
const admission = {
  in_recovery: true,
  in_hot_standby: 'on',
  read_only: 'on',
  feedback: 'off',
  version_num: '170006',
  replay_lsn: '2/0',
};

test('verified descriptor changes endpoint only and preserves synthetic credential and SSL', () => {
  assert.deepEqual(descriptor(input), input);
  const result = new URL(connection(primary, input));
  assert.equal(result.username, input.db_user);
  assert.equal(result.password, new URL(primary).password);
  assert.equal(result.hostname, input.db_host);
  assert.equal(result.search, new URL(primary).search);
  assert.equal(
    new URL(connection(primary.split('?')[0], input)).searchParams.get('sslmode'),
    'require'
  );
  const direct = {
    ...input,
    db_host: `db.${identifier}.supabase.co`,
    db_user: 'postgres',
    db_port: 5432,
    pool_mode: 'session',
  };
  assert.equal(
    new URL(
      connection(
        `postgres://postgres:synthetic@db.${primaryRef}.supabase.co/postgres?sslmode=verify-full`,
        direct
      )
    ).hostname,
    direct.db_host
  );
});
test('descriptor refuses primary identity, guessed or unrelated hosts and identity overrides', () => {
  for (const change of [
    { identifier: primaryRef },
    { database_type: 'PRIMARY' },
    { identifier: 'bad' },
    { db_host: 'evil.supabase.com' },
    { db_host: `db.${primaryRef}.supabase.co` },
    { db_user: 'postgres.other' },
    { db_port: '6543' },
    { db_name: 'template1' },
    { pool_mode: 'unknown' },
    { connection_string: 'private' },
  ])
    assert.throws(() => descriptor({ ...input, ...change }), /Replica schema route refused/);
  assert.throws(() => descriptor(null));
});
test('connection refuses unsafe or ambiguous libpq URL options and non-primary origins', () => {
  for (const key of [
    'host',
    'hostaddr',
    'user',
    'password',
    'port',
    'dbname',
    'service',
    'servicefile',
    'options',
    'passfile',
  ])
    assert.throws(() => connection(`${primary}&${key}=synthetic`, input));
  for (const url of [
    primary.replace(primaryRef, identifier),
    primary.replace('sslmode=require', 'sslmode=disable'),
    primary.replace('&connect_timeout=10', '&sslmode=require'),
    primary.replace('/postgres?', '/template1?'),
    primary + '#fragment',
    primary.replace('postgresql:', 'https:'),
    primary.replace('synthetic%40password', ''),
    primary.replace('connect_timeout=10', 'connect_timeout=0'),
  ])
    assert.throws(() => connection(url, input));
});
test('strict recovery admission and unsigned 64-bit WAL fence refuse drift and lag', () => {
  verify(fence, admission);
  verify(
    { ...fence, current_wal_lsn: 'FFFFFFFF/FFFFFFFF' },
    { ...admission, replay_lsn: 'FFFFFFFF/FFFFFFFF' }
  );
  for (const change of [
    { in_recovery: false },
    { in_recovery: 'true' },
    { in_hot_standby: 'off' },
    { read_only: 'off' },
    { feedback: 'on' },
    { version_num: '170011' },
    { replay_lsn: '1/FFFFFFFE' },
    { replay_lsn: null },
    { replay_lsn: '100000000/0' },
    { replay_lsn: '2/gg' },
    { unexpected: true },
  ])
    assert.throws(() => verify(fence, { ...admission, ...change }));
  for (const change of [
    { version_num: 170006 },
    { version_num: '180001' },
    { current_wal_lsn: '0/-1' },
    { unexpected: true },
  ])
    assert.throws(() => verify({ ...fence, ...change }, admission));
});
test('fixed read-only queries and CLI errors never expose input credentials or paths', () => {
  assert.match(primaryQuery, /pg_current_wal_lsn/);
  assert.match(query, /pg_is_in_recovery/);
  assert.match(query, /hot_standby_feedback/);
  assert.doesNotMatch(query + primaryQuery, /INSERT|UPDATE|DELETE|ALTER|CREATE|dblink/);
  const script = new URL('./leaderboard-schema-replica.mjs', import.meta.url);
  const failed = spawnSync(process.execPath, [script.pathname, 'connection'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      DATABASE_URL: 'PRIVATE_SECRET_INVALID',
      LEADERBOARD_SCHEMA_REPLICA_DESCRIPTOR: '{private-invalid}',
    },
  });
  assert.equal(failed.status, 1);
  assert.equal(failed.stdout, '');
  assert.equal(failed.stderr, 'Replica schema route refused.\n');
  const successful = spawnSync(process.execPath, [script.pathname, 'connection'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      DATABASE_URL: primary,
      LEADERBOARD_SCHEMA_REPLICA_DESCRIPTOR: JSON.stringify(input),
    },
  });
  assert.equal(successful.status, 0);
  assert.equal(successful.stderr, '');
  assert.equal(successful.stdout, connection(primary, input));
});
