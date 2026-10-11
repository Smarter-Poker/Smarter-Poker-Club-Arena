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
  connections = [],
  outcomes = [];
let stage = 'initialize',
  gateway,
  engineLoaded = false,
  stopEquityWorkers;
function setStage(value) {
  assert.match(value, /^[a-zA-Z0-9_.-]{1,100}$/);
  stage = value;
  console.log(
    JSON.stringify({ scope: 'authenticated-ev-cashout-native-lifecycle', kind: 'stage', stage })
  );
}
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
  setStage('genuine-auth-migrations');
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
  setStage('application-schema');
  for (const [name, sql] of JSON.parse(await readFile('/ev/chunks.json', 'utf8'))) {
    setStage(`schema-${name}`);
    await db.query(sql);
  }
  setStage('critical-authority-readback');
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
  setStage('player-session-authority-readback');
  const sessionAuthority = (
    await db.query(
      "SELECT md5(prosrc) AS body_md5,pg_get_userbyid(proowner) AS owner,prosecdef FROM pg_proc WHERE oid='public.fn_ca_player_session_live(uuid,uuid)'::regprocedure"
    )
  ).rows[0];
  assert.deepEqual(sessionAuthority, {
    body_md5: 'fc89c3f60dca4c05ba730f18c83672a1',
    owner: 'postgres',
    prosecdef: true,
  });
  const sessionGrants = (
    await db.query(
      "SELECT has_function_privilege('service_role','public.fn_ca_player_session_live(uuid,uuid)','EXECUTE') AS service, has_function_privilege('authenticated','public.fn_ca_player_session_live(uuid,uuid)','EXECUTE') AS authenticated, has_function_privilege('anon','public.fn_ca_player_session_live(uuid,uuid)','EXECUTE') AS anon"
    )
  ).rows[0];
  assert.deepEqual(sessionGrants, { service: true, authenticated: false, anon: false });
  setStage('genuine-auth-signin');
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
  setStage('postgrest');
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
  setStage('genuine-player-session-access');
  const sessionIds = users.map(
    (user) =>
      JSON.parse(Buffer.from(user.session.access_token.split('.')[1], 'base64url').toString('utf8'))
        .session_id
  );
  sessionIds.forEach((id) => assert.match(id, /^[0-9a-f-]{36}$/i));
  const sessionLive = async (userId, sessionId) => {
    const response = await fetch('http://127.0.0.1:3000/rpc/fn_ca_player_session_live', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${secrets.serviceKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ p_user_id: userId, p_session_id: sessionId }),
      signal: AbortSignal.timeout(10000),
    });
    assert.equal(
      response.status,
      200,
      'real session authority must be reachable before authenticated EV actions'
    );
    return response.json();
  };
  await db.query(
    "INSERT INTO public.ca_player_session_revocations(user_id,revoked_before,op_id) VALUES($1,clock_timestamp(),'ev-targeted-session-proof')",
    [users[0].id]
  );
  assert.equal(
    await sessionLive(users[0].id, sessionIds[0]),
    true,
    'targeted account current genuine session remains valid'
  );
  assert.equal(
    await sessionLive(users[0].id, sessionIds[1]),
    false,
    'another account session cannot grant targeted access'
  );
  assert.equal(
    await sessionLive(users[0].id, null),
    false,
    'targeted account missing session refuses'
  );
  assert.equal(await sessionLive(users[1].id, sessionIds[1]), true, 'other account retains access');
  await db.query('DELETE FROM public.ca_player_session_revocations WHERE user_id=$1', [
    users[0].id,
  ]);
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
  setStage('equity-workers');
  const equity = await import('/ev/server/dist/engine/equity/EquityWorkerPool.js');
  stopEquityWorkers = equity.stopEquityWorkerPool;
  const workerStatus = await equity.startEquityWorkerPool();
  assert.equal(workerStatus.acceptingWork, true, 'real pricing worker must be ready');
  for (const river of ['3c', '3d']) {
    setStage(`fund-club-${river}`);
    const club = randomUUID(),
      table = randomUUID(),
      game = randomUUID();
    await db.query(
      'INSERT INTO public.clubs(id,club_id,name,chip_treasury) VALUES($1,$2,$3,10000)',
      [club, river === '3c' ? 80001 : 80002, `Isolated EV acceptance ${river}`]
    );
    setStage(`fund-game-${river}`);
    await db.query(
      "INSERT INTO public.cash_games(id,club_id,name,template_name,variant,sb,bb,handedness,ruleset_snapshot) VALUES($1,$2,'Isolated EV acceptance','classic','nlh',1,2,2,'{}')",
      [game, club]
    );
    setStage(`fund-table-${river}`);
    await db.query(
      "INSERT INTO public.tables(id,name,club_id,cluster_id,game_type,game_variant,small_blind,big_blind,min_buy_in,max_buy_in,max_players,status,insurance_enabled,is_private) VALUES($1,'Isolated EV acceptance',$2,$3,'cash','nlh',1,2,1,1000,2,'waiting',true,true)",
      [table, club, game]
    );
    setStage(`fund-bank-${river}`);
    await db.query('INSERT INTO public.club_wallets(club_id,insurance_balance) VALUES($1,10000)', [
      club,
    ]);
    for (const [i, u] of users.entries()) {
      setStage(`fund-member-${river}`);
      await db.query(
        "INSERT INTO public.club_members(club_id,user_id,chip_balance,role,status) VALUES($1,$2,1000,'player','active')",
        [club, u.id]
      );
      setStage(`fund-seat-${river}`);
      await db.query(
        'SELECT public.atomic_table_buyin_before_maintenance_announcement_gate($1,$2,$3,150,false,$4,$5) AS result',
        [u.id, table, i + 1, club, randomUUID()]
      );
      const funded = await db.query(
        `SELECT s.stack, cm.chip_balance, f.amount, f.balance_before, f.balance_after
         FROM public.table_seats s
         JOIN public.club_members cm ON cm.user_id=s.user_id AND cm.club_id=s.club_id
         JOIN public.cash_participant_funding_receipts f ON f.seat_id=s.id
           AND f.occupancy_id=s.occupancy_id AND f.user_id=s.user_id
           AND f.table_id=s.table_id AND f.funding_club_id=s.club_id
         WHERE s.table_id=$1 AND s.user_id=$2 AND s.left_at IS NULL`,
        [table, u.id]
      );
      assert.equal(funded.rows.length, 1, 'one original funded seat receipt required');
      assert.deepEqual(
        Object.values(funded.rows[0]).map(Number),
        [150, 850, 150, 1000, 850],
        'original wallet debit and seat funding must agree'
      );
    }
    setStage(`authenticated-lifecycle-${river}`);
    engineLoaded = true;
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
          setStage(value);
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
  const failureAuthorities = JSON.parse(await readFile('/ev/captured-authorities.json', 'utf8'));
  const failureObjects = failureAuthorities.relations
    .map((r) => r.name)
    .concat(failureAuthorities.functions.map((f) => f.signature.split('(')[0]))
    .flatMap((name) => [name, name.startsWith('public.') ? name.slice(7) : `public.${name}`]);
  const databaseError = schemaCacheDiagnostics(
    JSON.stringify({ code: error.code, message: error.message }),
    failureObjects
  );
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
      database_error: databaseError,
      completed_outcomes: outcomes,
      error_code: /^[A-Z0-9_]{3,50}$/.test(error.code || '')
        ? error.code
        : 'ASSERTION_OR_RUNTIME_FAILURE',
    })
  );
  process.exitCode = 1;
} finally {
  const cleanupErrors = [];
  const closeOwned = async (code, close) => {
    try {
      await close();
    } catch {
      cleanupErrors.push(code);
    }
  };
  if (engineLoaded) {
    await closeOwned('CHANNEL_HUB_CLOSE_FAILED', async () => {
      const { channelHub } = await import('/ev/server/dist/hub/ChannelHub.js');
      channelHub.close();
    });
    await closeOwned('DEADLINE_SCHEDULER_STOP_FAILED', async () => {
      const { deadlineScheduler } = await import('/ev/server/dist/engine/DeadlineScheduler.js');
      deadlineScheduler.stop();
    });
  }
  if (stopEquityWorkers) await closeOwned('EQUITY_WORKERS_STOP_FAILED', stopEquityWorkers);
  if (gateway)
    await closeOwned('GATEWAY_CLOSE_FAILED', async () => {
      gateway.closeAllConnections();
      await new Promise((resolve, reject) =>
        gateway.close((error) => (error ? reject(error) : resolve()))
      );
    });
  for (const db of connections.reverse()) await closeOwned('DATABASE_CLOSE_FAILED', () => db.end());
  for (const child of children.reverse())
    await closeOwned('CHILD_STOP_FAILED', () => child.kill('SIGTERM'));
  if (cleanupErrors.length) {
    console.error(
      JSON.stringify({
        scope: 'authenticated-ev-cashout-native-lifecycle',
        kind: 'cleanup',
        error_codes: cleanupErrors,
      })
    );
    process.exitCode = 1;
  }
}
