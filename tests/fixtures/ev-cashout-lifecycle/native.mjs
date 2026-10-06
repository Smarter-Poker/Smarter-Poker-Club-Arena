// EV-specific native acceptance. Never a full component/product certificate.
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile, readFile, open } from 'node:fs/promises';
import http from 'node:http';
import pg from '/opt/qualification/node_modules/pg/lib/index.js';
import {
  fixtureSecrets,
  fixtureAuth,
  assertFixtureAuthMigrations,
} from '/opt/qualification/runtime/auth-fixture.mjs';
import {
  serviceRoleBootstrapSql,
  createFixtureApplicationOwner,
  managedPostgresArguments,
  sealFixtureAuthMigrationLedger,
  alignFixtureAuthPlatformHelperGrants,
} from '/opt/qualification/runtime/service-role-boundary.mjs';
import { exerciseEvCashout } from './actor.mjs';
import { schemaCacheDiagnostics } from './diagnostics.mjs';

const command = promisify(execFile),
  bin = '/usr/lib/postgresql/17/bin',
  data = '/var/lib/postgresql/data';
const database = 'club_arena_qualification',
  children = [],
  connections = [];
let stage = 'initialize',
  gateway;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function ready(check) {
  const end = Date.now() + 30000;
  while (Date.now() < end) {
    assert.ok(
      children.every((c) => c.exitCode === null && !c.failed),
      'native child stopped'
    );
    if (await check()) return;
    await wait(100);
  }
  throw Object.assign(new Error('native readiness absent'), { code: 'NATIVE_READINESS_ABSENT' });
}
async function start(name, binary, args, env = {}) {
  const log = await open(`/run/ev/${name}.log`, 'wx', 0o600);
  const c = spawn(binary, args, {
    env: { ...process.env, ...env },
    stdio: ['ignore', log.fd, log.fd],
  });
  c.on('error', () => {
    c.failed = true;
  });
  children.push(c);
  await log.close();
  return c;
}
async function connect(user, db = database) {
  const c = new pg.Client({ host: '/run/postgresql', user, database: db });
  await c.connect();
  connections.push(c);
  return c;
}
let readinessStatus = null,
  readinessCode = null;
async function healthy(url, headers = {}) {
  try {
    const response = await fetch(url, { headers, signal: AbortSignal.timeout(1000) });
    readinessStatus = response.status;
    if (!response.ok) {
      const body = await response.json().catch(() => null);
      readinessCode = /^(PGRST[0-9]{3}|[0-9A-Z]{5})$/.test(body?.code || '') ? body.code : null;
    }
    return response.ok;
  } catch {
    return false;
  }
}
try {
  assert.equal(process.getuid(), 1000);
  await mkdir('/run/ev', { recursive: true, mode: 0o700 });
  await mkdir('/run/postgresql', { recursive: true, mode: 0o700 });
  await command(`${bin}/initdb`, [
    '-D',
    data,
    '-U',
    'supabase_admin',
    '--auth-local=peer',
    '--auth-host=scram-sha-256',
    '--no-locale',
    '--encoding=UTF8',
  ]);
  await writeFile(
    `${data}/pg_hba.conf`,
    'local all all peer map=fixture_users\nhost all all 127.0.0.1/32 scram-sha-256\n'
  );
  await writeFile(
    `${data}/pg_ident.conf`,
    'fixture_users fixture supabase_admin\nfixture_users fixture postgres\n'
  );
  await start('postgres', `${bin}/postgres`, [
    '-D',
    data,
    '-k',
    '/run/postgresql',
    '-h',
    '127.0.0.1',
    ...managedPostgresArguments,
  ]);
  await ready(async () => {
    try {
      await command(`${bin}/pg_isready`, ['-h', '/run/postgresql', '-U', 'supabase_admin']);
      return true;
    } catch {
      return false;
    }
  });
  const admin = await connect('supabase_admin', 'postgres');
  await createFixtureApplicationOwner(admin);
  await admin.query(`CREATE DATABASE ${database} OWNER postgres`);
  const bootstrap = await connect('supabase_admin'),
    password = randomBytes(32).toString('hex'),
    secrets = fixtureSecrets();
  await bootstrap.query(serviceRoleBootstrapSql(password));
  const authEnv = {
    GOTRUE_API_HOST: '127.0.0.1',
    GOTRUE_API_PORT: '9999',
    API_EXTERNAL_URL: 'http://127.0.0.1:9999',
    GOTRUE_DB_DRIVER: 'postgres',
    GOTRUE_DB_DATABASE_URL: `postgres://supabase_auth_admin:${password}@127.0.0.1:5432/${database}`,
    GOTRUE_SITE_URL: 'http://127.0.0.1:3000',
    GOTRUE_JWT_SECRET: secrets.jwtSecret,
    GOTRUE_JWT_ADMIN_ROLES: 'service_role',
    GOTRUE_JWT_AUD: 'authenticated',
    GOTRUE_JWT_DEFAULT_GROUP_NAME: 'authenticated',
    GOTRUE_EXTERNAL_EMAIL_ENABLED: 'true',
    GOTRUE_MAILER_AUTOCONFIRM: 'true',
    GOTRUE_DISABLE_SIGNUP: 'false',
    GOTRUE_LOG_LEVEL: 'error',
  };
  stage = 'genuine-auth-migrations';
  await command('/usr/local/bin/auth', ['migrate'], {
    env: { ...process.env, ...authEnv },
    maxBuffer: 8 * 1024 * 1024,
  });
  await sealFixtureAuthMigrationLedger(bootstrap);
  await alignFixtureAuthPlatformHelperGrants(bootstrap);
  const db = await connect('postgres');
  assertFixtureAuthMigrations(
    (await db.query('SELECT version FROM auth.schema_migrations')).rows.map((r) => r.version)
  );
  stage = 'application-schema';
  for (const [name, sql] of JSON.parse(await readFile('/ev/chunks.json', 'utf8'))) {
    stage = `schema-${name}`;
    await db.query(sql);
  }
  stage = 'critical-authority-readback';
  for (const authority of JSON.parse(await readFile('/ev/captured-authorities.json', 'utf8'))
    .functions) {
    const signature = authority.signature.startsWith('smarter_private.')
      ? authority.signature
      : `public.${authority.signature}`;
    const actual = (
      await db.query(
        'SELECT md5(prosrc) AS body_md5,pg_get_userbyid(proowner) AS owner FROM pg_proc WHERE oid=$1::regprocedure',
        [signature]
      )
    ).rows[0];
    assert.deepEqual(
      actual,
      { body_md5: authority.body_md5, owner: authority.owner },
      'critical authority differs from captured source'
    );
  }
  await db.query("SELECT set_config('request.jwt.claim.role','service_role',false)");
  stage = 'genuine-auth-signin';
  await start('auth', '/usr/local/bin/auth', ['serve'], authEnv);
  await ready(() => healthy('http://127.0.0.1:9999/health'));
  const api = fixtureAuth({ serviceKey: secrets.serviceKey, jwtSecret: secrets.jwtSecret });
  await api.createLedgerAttributionIdentity();
  const users = (await api.createUsers()).slice(0, 2);
  for (const u of users)
    await db.query('INSERT INTO public.profiles(id,username,is_horse) VALUES($1,$2,false)', [
      u.id,
      `ev-${u.id}`,
    ]);
  stage = 'postgrest';
  await start('postgrest', '/usr/local/bin/postgrest', [], {
    PGRST_DB_URI: `postgres://authenticator:${password}@127.0.0.1:5432/${database}`,
    PGRST_DB_SCHEMAS: 'public',
    PGRST_DB_ANON_ROLE: 'anon',
    PGRST_JWT_SECRET: secrets.jwtSecret,
    PGRST_SERVER_HOST: '127.0.0.1',
    PGRST_SERVER_PORT: '3000',
    PGRST_LOG_LEVEL: 'error',
  });
  // Exercise bounded REST access, not generated OpenAPI for the full catalog.
  // Repeated abandoned OpenAPI requests can consume the connection pool.
  await ready(() =>
    healthy('http://127.0.0.1:3000/profiles?select=id&limit=0', {
      authorization: `Bearer ${secrets.serviceKey}`,
    })
  );
  // Only fixed loopback service routes; no fake auth response or remote target.
  gateway = http.createServer((req, res) => {
    const auth = req.url.startsWith('/auth/v1/'),
      rest = req.url.startsWith('/rest/v1/');
    if (!auth && !rest) {
      res.writeHead(404).end();
      return;
    }
    const upstream = http.request(
      {
        hostname: '127.0.0.1',
        port: auth ? 9999 : 3000,
        path: req.url.slice(auth ? 8 : 8),
        method: req.method,
        headers: req.headers,
      },
      (r) => {
        res.writeHead(r.statusCode, r.headers);
        r.pipe(res);
      }
    );
    upstream.on('error', () => res.writeHead(502).end());
    req.pipe(upstream);
  });
  await new Promise((r) => gateway.listen(54321, '127.0.0.1', r));
  process.env.SUPABASE_URL = 'http://127.0.0.1:54321';
  process.env.SUPABASE_SERVICE_ROLE_KEY = secrets.serviceKey;
  const outcomes = [];
  for (const river of ['3c', '3d']) {
    stage = `fund-club-${river}`;
    const club = randomUUID(),
      table = randomUUID(),
      game = randomUUID();
    await db.query(
      "INSERT INTO public.clubs(id,name,chip_treasury) VALUES($1,'Isolated EV acceptance',10000)",
      [club]
    );
    stage = `fund-game-${river}`;
    await db.query(
      "INSERT INTO public.cash_games(id,club_id,name,template_name,variant,sb,bb,handedness,ruleset_snapshot) VALUES($1,$2,'Isolated EV acceptance','classic','nlh',1,2,2,'{}')",
      [game, club]
    );
    stage = `fund-table-${river}`;
    await db.query(
      "INSERT INTO public.tables(id,name,club_id,cluster_id,game_type,game_variant,small_blind,big_blind,min_buy_in,max_buy_in,max_players,status,insurance_enabled,is_private) VALUES($1,'Isolated EV acceptance',$2,$3,'cash','nlh',1,2,1,1000,2,'waiting',true,true)",
      [table, club, game]
    );
    stage = `fund-bank-${river}`;
    await db.query('INSERT INTO public.club_wallets(club_id,insurance_balance) VALUES($1,10000)', [
      club,
    ]);
    for (const [i, u] of users.entries()) {
      stage = `fund-member-${river}`;
      await db.query(
        "INSERT INTO public.club_members(club_id,user_id,chip_balance,role,status) VALUES($1,$2,1000,'player','active')",
        [club, u.id]
      );
      stage = `fund-seat-${river}`;
      const result = await db.query(
        'SELECT public.atomic_table_buyin_before_maintenance_announcement_gate($1,$2,$3,150,false,$4,$5) AS result',
        [u.id, table, i + 1, club, randomUUID()]
      );
      assert.equal(result.rows[0].result.success, true, 'original funding owner refused');
    }
    stage = `authenticated-lifecycle-${river}`;
    outcomes.push(
      await exerciseEvCashout({
        db,
        users,
        tableId: table,
        serverDirectory: '/ev/server',
        river,
        reportStage: (value) => {
          assert.match(
            value,
            /^ev-(prepare|offer|authentication|acceptance|duplicate-refusal|commit|conservation|replay)$/
          );
          stage = value;
        },
      })
    );
  }
  console.log(
    JSON.stringify({
      scope: 'authenticated-ev-cashout-native-lifecycle',
      status: 'passed',
      product_certificate: false,
      outcomes,
    })
  );
} catch (error) {
  let providerDiagnostics, databaseActivity;
  if (stage === 'postgrest') {
    const authorities = JSON.parse(await readFile('/ev/captured-authorities.json', 'utf8'));
    const allowed = [
      'public',
      'auth',
      'extensions',
      'smarter_private',
      ...authorities.relations.map((r) => r.name),
      ...authorities.functions.map((f) => f.signature.split('(')[0]),
    ];
    providerDiagnostics = schemaCacheDiagnostics(
      await readFile('/run/ev/postgrest.log', 'utf8').catch(() => ''),
      allowed.flatMap((name) => [name, name.split('.').at(-1)])
    );
    // Private fixture metadata only: never retain SQL text or connection details.
    databaseActivity = await connections[0]
      .query({
        text: `SELECT pid, usename AS role, state, wait_event_type, wait_event,
        pg_blocking_pids(pid) AS blocking_pids,
        round(extract(epoch FROM clock_timestamp()-xact_start))::int AS transaction_age_seconds,
        round(extract(epoch FROM clock_timestamp()-query_start))::int AS query_age_seconds,
        CASE WHEN query LIKE '%pg_proc%' AND query LIKE '%pg_class%' THEN 'schema-catalog'
             WHEN query ~* '^\\s*(begin|start transaction)' THEN 'transaction-start'
             WHEN query ~* '^\\s*select' THEN 'select'
             WHEN query ~* '^\\s*with' THEN 'with' ELSE 'other' END AS statement_kind
        FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()
        ORDER BY pid LIMIT 16`,
        values: [database],
        query_timeout: 2000,
      })
      .then((result) => result.rows)
      .catch(() => [{ status: 'unreadable' }]);
  }
  // Deliberately omit raw SQL, tokens, bodies, service logs and environment.
  console.error(
    JSON.stringify({
      scope: 'authenticated-ev-cashout-native-lifecycle',
      status: 'failed',
      product_certificate: false,
      stage,
      readiness_http_status: stage === 'postgrest' ? readinessStatus : undefined,
      readiness_error_code: stage === 'postgrest' ? readinessCode : undefined,
      provider_diagnostics: providerDiagnostics,
      database_activity: databaseActivity,
      error_code: /^[A-Z0-9_]{3,50}$/.test(error.code || '')
        ? error.code
        : 'ASSERTION_OR_RUNTIME_FAILURE',
    })
  );
  process.exitCode = 1;
} finally {
  if (gateway) await new Promise((r) => gateway.close(r));
  for (const db of connections.reverse()) await db.end().catch(() => {});
  for (const child of children.reverse()) child.kill('SIGTERM');
}
