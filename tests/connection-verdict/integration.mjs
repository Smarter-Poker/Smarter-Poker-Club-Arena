import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import vm from 'node:vm';

const [source, evidence] = process.argv.slice(2);
const require = createRequire(path.join(source, 'package.json'));
const { Client } = require('pg');
const config = JSON.parse(readFileSync(path.join(evidence, 'cluster.json'), 'utf8'));
assert.match(
  config.host,
  /^\/private\/tmp\/ca-connection-owned-[^/]+\/socket$|^\/tmp\/ca-connection-owned-[^/]+\/socket$/
);
assert.equal(config.database, 'ca_connection_verdict');
assert.equal(config.port, 55473);
const clients = [];
async function connect(role) {
  const client = new Client({ ...config, statement_timeout: 5000 });
  clients.push(client);
  await client.connect();
  const identity = (
    await client.query('SELECT current_database() AS db, inet_server_addr() AS address')
  ).rows[0];
  assert.deepEqual(identity, { db: 'ca_connection_verdict', address: null });
  if (role) await client.query(`SET ROLE ${role}`);
  return client;
}
const admin = await connect();
const cases = [];
const trace = [];
async function test(name, fn) {
  const start = performance.now();
  await fn();
  cases.push({ name, status: 'passed', milliseconds: Math.round(performance.now() - start) });
  writeFileSync(path.join(evidence, 'cases.json'), JSON.stringify(cases, null, 2) + '\n');
}
const id = (n) => `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, '0')}`;
const user = id(100),
  other = id(101),
  chip = id(1),
  union = id(2),
  child = id(3),
  link = id(4),
  diamond = id(5),
  foreign = id(6);
const table = id(200);
let service;
async function verdict(t = table, u = user, client = service) {
  const { rows } = await client.query(
    'SELECT public.fn_ca_engine_table_connection_access($1::uuid,$2::uuid) AS verdict',
    [t, u]
  );
  assert.equal(rows.length, 1);
  return rows[0].verdict;
}
function expected(reason, extras = {}) {
  return {
    table_id: table,
    user_id: user,
    scope_id: chip,
    allowed: ['seated', 'club_member', 'diamond_member'].includes(reason),
    reason,
    banned: false,
    ip_restricted: false,
    ...extras,
  };
}
async function reset() {
  await admin.query('TRUNCATE table_seats,club_members,blacklists,tables,union_clubs,clubs');
  await admin.query(
    `INSERT INTO clubs(id,asset,is_platform,is_union,union_id) VALUES
    ($1,'chips',false,false,null),($2,'chips',false,true,null),($3,'chips',false,false,$2),
    ($4,'chips',false,false,null),($5,'diamonds',true,false,null),($6,'chips',false,false,null)`,
    [chip, union, child, link, diamond, foreign]
  );
  await admin.query('INSERT INTO union_clubs VALUES($1,$2)', [union, link]);
  await admin.query(
    'INSERT INTO tables(id,club_id,restrict_observers,ip_restriction) VALUES($1,$2,false,false)',
    [table, chip]
  );
}
async function member(club = chip, status = 'active', who = user) {
  await admin.query('INSERT INTO club_members(club_id,user_id,status) VALUES($1,$2,$3)', [
    club,
    who,
    status,
  ]);
}
async function seat(left = null, who = user) {
  await admin.query('INSERT INTO table_seats(table_id,user_id,left_at) VALUES($1,$2,$3)', [
    table,
    who,
    left,
  ]);
}
async function ban({ club = chip, scope = null, expires = null, who = user } = {}) {
  await admin.query(
    'INSERT INTO blacklists(user_id,club_id,union_id,expires_at) VALUES($1,$2,$3,$4)',
    [who, club, scope, expires]
  );
}
async function dataDigest() {
  const values = {};
  for (const name of [
    'clubs',
    'union_clubs',
    'tables',
    'table_seats',
    'club_members',
    'blacklists',
  ]) {
    values[name] = (
      await admin.query(
        `SELECT jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text) AS rows FROM public.${name} t`
      )
    ).rows[0].rows;
  }
  return createHash('sha256').update(JSON.stringify(values)).digest('hex');
}
try {
  await admin.query(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role; CREATE ROLE unrelated;
    GRANT USAGE ON SCHEMA public TO anon,authenticated,service_role,unrelated;
    CREATE TABLE clubs(id uuid PRIMARY KEY,asset text,is_platform boolean,is_union boolean,union_id uuid);
    CREATE TABLE union_clubs(union_id uuid,club_id uuid);
    CREATE TABLE tables(id uuid PRIMARY KEY,club_id uuid,union_id uuid,restrict_observers boolean,ip_restriction boolean);
    CREATE TABLE table_seats(table_id uuid,user_id uuid,left_at timestamptz);
    CREATE TABLE club_members(club_id uuid,user_id uuid,status text);
    CREATE TABLE blacklists(user_id uuid,club_id uuid,union_id uuid,expires_at timestamptz);
    CREATE INDEX ON table_seats(table_id,user_id) WHERE left_at IS NULL;
    CREATE INDEX ON club_members(user_id,club_id) WHERE status IN ('active','approved');
    CREATE INDEX ON blacklists(user_id);
    CREATE INDEX ON union_clubs(union_id,club_id);
    ALTER TABLE clubs ENABLE ROW LEVEL SECURITY; ALTER TABLE tables ENABLE ROW LEVEL SECURITY;
    ALTER TABLE table_seats ENABLE ROW LEVEL SECURITY; ALTER TABLE club_members ENABLE ROW LEVEL SECURITY;
    ALTER TABLE blacklists ENABLE ROW LEVEL SECURITY; ALTER TABLE union_clubs ENABLE ROW LEVEL SECURITY;`);
  const helperSource = readFileSync(
    path.join(source, 'supabase/migrations/20260823_03_club_members_overview.sql'),
    'utf8'
  );
  const helper = helperSource.match(
    /CREATE OR REPLACE FUNCTION public\.fn_club_scope_ids\(p_club_id uuid\)[\s\S]*?AS \$\$([\s\S]*?)\$\$;/
  );
  assert(helper);
  assert.equal(
    createHash('md5').update(helper[1]).digest('hex'),
    '9fc3bbf5ebbf941e06141b3a65584ef4'
  );
  await admin.query(helper[0]);
  await admin.query(
    'REVOKE ALL ON FUNCTION public.fn_club_scope_ids(uuid) FROM PUBLIC,anon,authenticated,service_role'
  );
  const beforeHelper = (
    await admin.query(
      "SELECT md5(prosrc) AS hash FROM pg_proc WHERE oid='public.fn_club_scope_ids(uuid)'::regprocedure"
    )
  ).rows[0].hash;
  await admin.query(
    readFileSync(
      path.join(
        source,
        'supabase/migrations/20260911195214_engine_table_connection_one_snapshot_verdict.sql'
      ),
      'utf8'
    )
  );
  service = await connect('service_role');
  await test('exact helper unchanged; stable SQL definer with qualified path and service-only ACL', async () => {
    assert.equal(
      (
        await admin.query(
          "SELECT md5(prosrc) AS hash FROM pg_proc WHERE oid='public.fn_club_scope_ids(uuid)'::regprocedure"
        )
      ).rows[0].hash,
      beforeHelper
    );
    const p = (
      await admin.query(
        "SELECT p.provolatile,p.prosecdef,p.proconfig,r.rolname,l.lanname FROM pg_proc p JOIN pg_roles r ON r.oid=p.proowner JOIN pg_language l ON l.oid=p.prolang WHERE p.oid='public.fn_ca_engine_table_connection_access(uuid,uuid)'::regprocedure"
      )
    ).rows[0];
    assert.deepEqual(p, {
      provolatile: 's',
      prosecdef: true,
      proconfig: ['search_path=pg_catalog, public, pg_temp'],
      rolname: 'postgres',
      lanname: 'sql',
    });
    for (const role of ['anon', 'authenticated', 'unrelated']) {
      const denied = await connect(role);
      assert.equal(
        (
          await admin.query(
            "SELECT has_function_privilege($1,'public.fn_ca_engine_table_connection_access(uuid,uuid)','EXECUTE') AS allowed",
            [role]
          )
        ).rows[0].allowed,
        false
      );
      await assert.rejects(() => verdict(table, user, denied), { code: '42501' });
    }
    await assert.rejects(() => service.query('SELECT * FROM public.tables'), { code: '42501' });
    assert.equal((await verdict()).reason, 'table_not_found');
  });
  await test('null identities and missing table return one explicit fail-closed result', async () => {
    await reset();
    for (const [t, u] of [
      [null, user],
      [table, null],
      [null, null],
    ]) {
      assert.deepEqual(
        await verdict(t, u),
        expected('check_failed', { table_id: t, user_id: u, scope_id: t ? chip : null })
      );
    }
    assert.deepEqual(
      await verdict(id(999)),
      expected('table_not_found', { table_id: id(999), scope_id: null })
    );
  });
  await test('active seat bypasses observer membership only; expired and foreign seats do not grant', async () => {
    await reset();
    await seat(new Date());
    await seat(null, other);
    assert.deepEqual(await verdict(), expected('membership_required'));
    await seat();
    await admin.query('UPDATE tables SET restrict_observers=true');
    assert.deepEqual(await verdict(), expected('seated'));
    await ban();
    assert.deepEqual(await verdict(), expected('seated', { banned: true }));
  });
  await test('active and approved membership; inactive foreign null and duplicate memberships', async () => {
    await reset();
    for (const status of ['pending', 'banned', 'inactive', null]) await member(chip, status);
    await member(foreign);
    await member(chip, 'active', other);
    assert.deepEqual(await verdict(), expected('membership_required'));
    await member(chip, 'approved');
    assert.deepEqual(await verdict(), expected('club_member'));
    await member();
    assert.deepEqual(await verdict(), expected('club_member'));
    await admin.query('UPDATE tables SET restrict_observers=true');
    assert.deepEqual(await verdict(), expected('observers_restricted'));
  });
  await test('union shell, union-only and mapped child scopes retain exact installed helper semantics', async () => {
    for (const owner of [union, null]) {
      for (const membership of [union, child, link]) {
        await reset();
        await member(membership);
        await admin.query('UPDATE tables SET club_id=$1,union_id=$2', [owner, union]);
        assert.deepEqual(await verdict(), expected('club_member', { scope_id: union }));
      }
    }
    await reset();
    await member(link);
    await admin.query('UPDATE tables SET club_id=$1', [child]);
    assert.deepEqual(await verdict(), expected('membership_required', { scope_id: child }));
    await admin.query('UPDATE tables SET union_id=$1', [union]);
    assert.deepEqual(await verdict(), expected('club_member', { scope_id: union }));
  });
  await test('diamond automatic membership requires exact valid platform arena', async () => {
    await reset();
    await admin.query('UPDATE tables SET club_id=$1', [diamond]);
    assert.deepEqual(await verdict(), expected('diamond_member', { scope_id: diamond }));
    await admin.query('UPDATE tables SET restrict_observers=true');
    assert.deepEqual(await verdict(), expected('observers_restricted', { scope_id: diamond }));
    await seat();
    assert.equal((await verdict()).reason, 'seated');
    for (const patch of [
      'is_platform=false',
      'is_platform=NULL',
      'asset=NULL',
      "asset='unknown'",
      "union_id='" + union + "'",
    ]) {
      await reset();
      await seat();
      await admin.query('UPDATE tables SET club_id=$1', [diamond]);
      await admin.query(`UPDATE clubs SET ${patch} WHERE id=$1`, [diamond]);
      assert.equal((await verdict()).reason, 'check_failed');
    }
    await reset();
    await seat();
    await admin.query('UPDATE tables SET club_id=$1,union_id=$2', [diamond, union]);
    assert.equal((await verdict()).reason, 'check_failed');
  });
  await test('malformed chip arena and missing ownership never inherit a seat grant', async () => {
    for (const patch of ['club_id=NULL,union_id=NULL', `club_id='${id(777)}'`]) {
      await reset();
      await seat();
      await admin.query(`UPDATE tables SET ${patch}`);
      assert.equal((await verdict()).reason, 'check_failed');
    }
    for (const patch of ['is_platform=true', 'is_platform=NULL', 'asset=NULL']) {
      await reset();
      await seat();
      await admin.query(`UPDATE clubs SET ${patch} WHERE id=$1`, [chip]);
      assert.equal((await verdict()).reason, 'check_failed');
    }
  });
  await test('ban scope covers club, attached union, shell union and union-only; unrelated ban does not apply', async () => {
    for (const shape of ['club', 'attached', 'shell', 'union-only', 'explicit-union']) {
      await reset();
      await seat();
      if (shape === 'attached') await admin.query('UPDATE tables SET club_id=$1', [child]);
      if (shape === 'shell') await admin.query('UPDATE tables SET club_id=$1', [union]);
      if (shape === 'union-only')
        await admin.query('UPDATE tables SET club_id=NULL,union_id=$1', [union]);
      if (shape === 'explicit-union') await admin.query('UPDATE tables SET union_id=$1', [union]);
      await ban({ club: foreign, who: user });
      await ban({ who: other });
      assert.equal((await verdict()).banned, false);
      await ban(shape === 'club' ? {} : { club: null, scope: union });
      assert.equal((await verdict()).banned, true);
    }
    // Retained policy: an association-only union_clubs mapping does not supply
    // blacklist authority when neither the table nor its club names that union.
    await reset();
    await seat();
    await admin.query('UPDATE tables SET club_id=$1', [link]);
    await ban({ club: null, scope: union });
    assert.equal((await verdict()).banned, false);
  });
  await test('ban expiration uses statement clock, including a transaction that began before expiration', async () => {
    await reset();
    await member();
    await admin.query(
      "INSERT INTO blacklists(user_id,club_id,expires_at) VALUES($1,$2,clock_timestamp()+interval '60 milliseconds')",
      [user, chip]
    );
    await service.query('BEGIN READ ONLY');
    assert.equal((await verdict()).banned, true);
    await new Promise((r) => setTimeout(r, 90));
    assert.equal((await verdict()).banned, false);
    await service.query('COMMIT');
    await ban();
    assert.equal((await verdict()).banned, true);
  });
  await test('live IP and observer settings are not cached and nullable settings do not grant invalid scope', async () => {
    await reset();
    await member();
    await admin.query('UPDATE tables SET ip_restriction=true');
    assert.deepEqual(await verdict(), expected('club_member', { ip_restricted: true }));
    await admin.query('UPDATE tables SET ip_restriction=NULL,restrict_observers=NULL');
    assert.deepEqual(await verdict(), expected('club_member'));
    await admin.query('UPDATE tables SET restrict_observers=true');
    assert.deepEqual(await verdict(), expected('observers_restricted'));
  });
  await test('exact function runs READ ONLY without changing any projected source relation', async () => {
    await reset();
    await member();
    await seat();
    await ban({ club: foreign });
    const before = await dataDigest();
    await service.query('BEGIN READ ONLY');
    for (let n = 0; n < 8; n++) assert.equal((await verdict()).reason, 'seated');
    await service.query('COMMIT');
    assert.equal(await dataDigest(), before);
  });
  await test('temporary relations cannot replace qualified arena, seat or membership authority', async () => {
    await reset();
    await service.query(`CREATE TEMP TABLE tables(id uuid,club_id uuid,union_id uuid,restrict_observers boolean,ip_restriction boolean);
      CREATE TEMP TABLE table_seats(table_id uuid,user_id uuid,left_at timestamptz);
      CREATE TEMP TABLE clubs(id uuid,asset text,is_platform boolean,is_union boolean,union_id uuid);
      CREATE TEMP TABLE club_members(club_id uuid,user_id uuid,status text);
      SET search_path=pg_temp,public;`);
    await service.query('INSERT INTO pg_temp.table_seats VALUES($1,$2,null)', [table, user]);
    await service.query("INSERT INTO pg_temp.club_members VALUES($1,$2,'active')", [chip, user]);
    assert.deepEqual(await verdict(), expected('membership_required'));
    await member();
    assert.deepEqual(await verdict(), expected('club_member'));
    await service.query('RESET search_path');
  });
  await test('actual TypeScript decoder composes with native RPC and refuses malformed identity, flags and errors', async () => {
    await reset();
    await member();
    const ts = require('typescript');
    const filename = path.join(source, 'server/src/services/TableConnectionAccess.ts');
    const compiled = ts.transpileModule(readFileSync(filename, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    const calls = [];
    let mutate = (row) => row,
      fail = false;
    const rpc = async (name, params) => {
      calls.push({ name, params });
      if (fail) return { data: null, error: { code: 'fixture' } };
      return { data: mutate(await verdict(params.p_table_id, params.p_user_id)), error: null };
    };
    const context = vm.createContext({ Set, RegExp });
    const dependency = new vm.SyntheticModule(
      ['supabase'],
      function () {
        this.setExport('supabase', { rpc });
      },
      { context }
    );
    const mod = new vm.SourceTextModule(compiled, { context, identifier: filename });
    await mod.link((specifier) => {
      assert.equal(specifier, './supabase.js');
      return dependency;
    });
    await mod.evaluate();
    const authorize = mod.namespace.authorizeTableConnection;
    const plain = (value) => JSON.parse(JSON.stringify(value));
    assert.deepEqual(plain(await authorize(table, user)), {
      allowed: true,
      reason: 'club_member',
      clubId: chip,
      banned: false,
      ipRestricted: false,
    });
    assert.deepEqual(plain(calls), [
      {
        name: 'fn_ca_engine_table_connection_access',
        params: { p_table_id: table, p_user_id: user },
      },
    ]);
    await ban();
    await admin.query('UPDATE public.tables SET ip_restriction=true');
    assert.deepEqual(plain(await authorize(table, user)), {
      allowed: true,
      reason: 'club_member',
      clubId: chip,
      banned: true,
      ipRestricted: true,
    });
    const refused = {
      allowed: false,
      reason: 'check_failed',
      clubId: null,
      banned: false,
      ipRestricted: false,
    };
    const mutations = [
      (row) => ({ ...row, table_id: other }),
      (row) => ({ ...row, user_id: other }),
      (row) => ({ ...row, allowed: 'true' }),
      (row) => ({ ...row, banned: 0 }),
      (row) => ({ ...row, ip_restricted: null }),
      (row) => ({ ...row, scope_id: null }),
      (row) => ({ ...row, reason: 'membership_required' }),
      (row) => [row],
      () => null,
    ];
    for (const fn of mutations) {
      mutate = fn;
      assert.deepEqual(plain(await authorize(table, user)), refused);
    }
    mutate = (row) => row;
    fail = true;
    assert.deepEqual(plain(await authorize(table, user)), refused);
    const count = calls.length;
    assert.deepEqual(plain(await authorize('not-a-uuid', user)), refused);
    assert.equal(calls.length, count);
  });
  await test('blocked actual stable RPC sees one pre-commit snapshot; following RPC sees entire revocation', async () => {
    await reset();
    await seat();
    await member();
    const blocker = await connect();
    const first = await connect('service_role');
    const pid = (await first.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    await blocker.query('BEGIN');
    await blocker.query('LOCK TABLE public.tables IN ACCESS EXCLUSIVE MODE');
    const pending = verdict(table, user, first);
    let waiting = false;
    for (let n = 0; n < 100; n++) {
      const state = (
        await admin.query('SELECT wait_event_type,wait_event FROM pg_stat_activity WHERE pid=$1', [
          pid,
        ])
      ).rows[0];
      if (state?.wait_event_type === 'Lock') {
        waiting = true;
        trace.push({ pid, ...state });
        break;
      }
      await new Promise((r) => setTimeout(r, 10));
    }
    assert(waiting, 'actual RPC did not reach native lock wait');
    await blocker.query(
      'UPDATE table_seats SET left_at=clock_timestamp(); DELETE FROM club_members; UPDATE tables SET restrict_observers=true,ip_restriction=true'
    );
    await blocker.query('INSERT INTO blacklists(user_id,club_id) VALUES($1,$2)', [user, chip]);
    await blocker.query('COMMIT');
    const old = await pending,
      next = await verdict();
    trace.push({ old, next });
    assert.deepEqual(old, expected('seated'));
    assert.deepEqual(next, expected('membership_required', { banned: true, ip_restricted: true }));
    writeFileSync(
      path.join(evidence, 'snapshot-trace.json'),
      JSON.stringify(trace, null, 2) + '\n'
    );
  });
  console.log(JSON.stringify({ status: 'passed', cases: cases.length }));
} finally {
  await Promise.allSettled(clients.map((c) => c.end()));
}
