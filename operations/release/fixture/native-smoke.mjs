// Real binaries/protocols in an internal-network fixture, with a separate peer.
// This deliberately does not emit a product semantic certificate.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile, readFile, access, open, readdir, lstat, unlink } from 'node:fs/promises';
import pg from 'pg';
import { chromium } from '@playwright/test';
import {
  fixtureSecrets,
  fixtureAuth,
  assertFixtureAuthVersion,
  assertFixtureAuthMigrations,
  assertLedgerAttributionIdentity,
} from './auth-fixture.mjs';
import {
  serviceRoleBootstrapSql,
  assertNativeServiceRoleBoundary,
  createFixtureApplicationOwner,
  managedPostgresArguments,
  assertManagedPostgresBoundary,
  assertBootstrapPostgresConfiguration,
  sealFixtureAuthMigrationLedger,
  alignFixtureAuthPlatformHelperGrants,
  assertFixtureAuthPlatformHelpers,
  assertFixtureAuthPlatformWriteDenied,
} from './service-role-boundary.mjs';
import { startObservationBridge } from './observation-bridge.mjs';
import {
  prepareRealtimeCookie,
  assertRealtimeHttpListener,
  verifyRealtimePeerBoundary,
  realtimeMigrated,
} from './fixture-server.mjs';
import { createFixtureGateway } from './gateway.mjs';
import {
  nativeFailureDiagnostic,
  NativeDatabaseOwner,
  nativeChildFailure,
  realtimeLogDiagnostic,
} from './runtime-files.mjs';

const exec = promisify(execFile);
const root = '/run/native-smoke';
const pgBin = '/usr/lib/postgresql/17/bin';
const database = 'club_arena_qualification';
const controls = '/opt/qualification/controls';
const controlModules = controls + '/operations/release/native/';
const observationSocket = '/run/fixture-observer/observation.sock';
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let stage = 'initialization';
const children = [];
const databaseOwner = new NativeDatabaseOwner();
let bridgeFailure = null;
let gatewayFailure = false;
let realtimeBootstrapOutput = '';

async function smokeControl() {
  const control = JSON.parse(await readFile(controls + '/smoke-control.json', 'utf8'));
  assert.deepEqual(Object.keys(control).sort(), ['control_sha', 'version']);
  assert.equal(control.version, 1);
  assert.match(control.control_sha, /^[0-9a-f]{40}$/);
  return control;
}

async function eventually(check, milliseconds = 60000) {
  const deadline = Date.now() + milliseconds;
  for (;;) {
    databaseOwner.check();
    assert.equal(bridgeFailure, null, 'native observation bridge failed');
    assert.equal(gatewayFailure, false, 'native gateway failed');
    const childFailure = nativeChildFailure(children);
    if (childFailure) throw childFailure;
    if (await check()) return;
    assert.ok(Date.now() < deadline, 'native service readiness timed out');
    await pause(200);
  }
}

async function healthy(url, headers = {}) {
  try {
    return (
      await fetch(url, {
        headers,
        signal: AbortSignal.any([databaseOwner.signal, AbortSignal.timeout(1000)]),
        redirect: 'error',
      })
    ).ok;
  } catch {
    return false;
  }
}

async function start(name, binary, args, env = {}) {
  const log = await open(`${root}/private/${name}.log`, 'wx', 0o600);
  const child = spawn(binary, args, {
    env: { ...process.env, ...env },
    signal: databaseOwner.signal,
    stdio: ['ignore', log.fd, log.fd],
  });
  child.nativeName = name;
  child.on('error', () => {
    child.nativeFailed = true;
  });
  children.push(child);
  await log.close();
  await pause(20);
  assert.ok(!child.nativeFailed && child.exitCode === null, 'native service could not start');
  return child;
}

async function command(binary, args, env = {}) {
  // Output can contain local bootstrap configuration: never print it in CI.
  return exec(binary, args, {
    env: { ...process.env, ...env },
    signal: databaseOwner.signal,
    timeout: 90000,
    maxBuffer: 8 * 1024 * 1024,
  });
}

async function oracle() {
  stage = 'observer-user-isolation';
  assert.equal(process.getuid(), 1001);
  assert.equal(process.getgid(), 1001);
  assert.ok(!process.getgroups().includes(1000));
  await mkdir('/tmp/qualification', { recursive: true, mode: 0o700 });
  await assert.rejects(readFile(`${root}/private/service.json`), {
    code: 'EACCES',
  });
  await assert.rejects(readFile('/app/releases/COOKIE'), { code: 'EACCES' });
  await assert.rejects(readFile('/tmp/fixture/.erlang.cookie'), { code: 'EACCES' });
  const fixture = JSON.parse(await readFile(`${root}/oracle.json`, 'utf8'));
  await assert.rejects(readFile(`/proc/${fixture.auth_pid}/environ`), {
    code: 'EACCES',
  });
  for (const entry of await readdir('/proc')) {
    if (!/^[0-9]+$/.test(entry)) continue;
    let commandLine;
    try {
      commandLine = await readFile(`/proc/${entry}/cmdline`, 'utf8');
    } catch (error) {
      if (['EACCES', 'ENOENT', 'ESRCH'].includes(error.code)) continue;
      throw error;
    }
    for (const argument of commandLine.split('\0')) {
      const digest = createHash('sha256').update(argument).digest('hex');
      assert.ok(
        !fixture.private_arg_hashes.includes(digest),
        'private service argument is observer-readable'
      );
    }
  }
  const pgDirectory = await lstat('/run/postgresql');
  assert.ok(pgDirectory.isDirectory() && !pgDirectory.isSymbolicLink());
  assert.equal(pgDirectory.uid, 1000);
  assert.equal(pgDirectory.gid, 1000);
  assert.equal(pgDirectory.mode & 0o7777, 0o700);
  await assert.rejects(readdir('/run/postgresql'), { code: 'EACCES' });
  for (const user of ['postgres', 'qualification_reader']) {
    const denied = new pg.Client({
      host: '/run/postgresql',
      database,
      user,
      connectionTimeoutMillis: 3000,
    });
    try {
      // This must be filesystem denial, not merely a failed SQL privilege check.
      await assert.rejects(denied.connect(), { code: 'EACCES' });
    } finally {
      await denied.end();
    }
  }
  stage = 'native-observation-bridge';
  const control = await smokeControl();
  await assert.rejects(writeFile(controls + '/smoke-control.json', '{}'), { code: 'EROFS' });
  await assert.rejects(unlink(observationSocket), { code: 'EACCES' });
  await assert.rejects(
    writeFile('/run/fixture-observer/oracle-created', 'refused', { flag: 'wx' }),
    { code: 'EACCES' }
  );
  const { createObservationClient } = await import(
    controlModules + 'component-observation-client.mjs'
  );
  const observer = createObservationClient(fixture.observation_bridge, control);
  try {
    assert.deepEqual(await observer.catalogue(), { catalogue_digest: fixture.catalogue_digest });
    // Fixed synthetic protocol data only: these are not engine or browser hands.
    const hand = { hand_number: 2, next_hand_number: 3 };
    assert.deepEqual(await observer.handPresence(hand), { count: 1 });
    assert.deepEqual(await observer.handFacts(hand), {
      count: 1,
      rows: [
        { hand_number: 2, pot_size: '3.00', rake_amount: '0.00', action_count: 1, player_count: 2 },
      ],
      seat_count: 0,
    });
    assert.deepEqual(await observer.catalogue(), { catalogue_digest: fixture.catalogue_digest });
  } finally {
    observer.close();
  }
  stage = 'chromium-native-read-and-rls';
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    // Load a genuine PostgREST response, with a real GoTrue-issued user token.
    await page.setExtraHTTPHeaders({
      Authorization: `Bearer ${fixture.access_token}`,
    });
    const response = await page.goto(
      'http://127.0.0.1:3000/fixture_smoke?select=id,owner_id,payload'
    );
    assert.equal(response.status(), 200);
    const rows = await response.json();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].owner_id, fixture.user_id);
    assert.equal(rows[0].payload, 'native-realtime-change');
    await context.close();
  } finally {
    await browser.close();
  }
  await writeFile('/tmp/native-smoke-oracle-complete', 'complete', {
    flag: 'wx',
    mode: 0o644,
  });
  console.log(
    JSON.stringify({
      scope: 'native-service-smoke',
      observer: 'passed',
      observation_bridge: 'native-synthetic-protocol',
      postgres_socket: 'denied',
      browser: 'chromium',
      retries: 0,
    })
  );
}

async function services() {
  assert.equal(process.getuid(), 1000);
  assert.equal(process.getgid(), 1000);
  assert.ok(!process.getgroups().includes(1001));
  assert.equal(process.version, 'v22.23.2');
  await mkdir(root, { recursive: true, mode: 0o755 });
  await mkdir(`${root}/private`, { mode: 0o700 });
  await mkdir('/tmp/fixture/realtime', { recursive: true, mode: 0o700 });
  const realtimeCookie = await prepareRealtimeCookie();
  await mkdir('/run/postgresql', { mode: 0o700 });
  const control = await smokeControl();
  const secrets = fixtureSecrets();
  await writeFile(`${root}/private/service.json`, JSON.stringify(secrets), {
    mode: 0o600,
  });
  const password = secrets.databasePassword;
  assert.match(password, /^[a-f0-9]{64}$/);
  const data = '/var/lib/postgresql/data';
  stage = 'postgresql-version';
  const version = await command(`${pgBin}/postgres`, ['--version']);
  assert.match(version.stdout, /PostgreSQL\) 17\.11\b/);
  stage = 'postgrest-version';
  const restVersion = await command('/usr/local/bin/postgrest', ['--version']);
  assert.match(restVersion.stdout, /\b14\.5\b/);
  stage = 'gotrue-version';
  const authVersion = await command('/usr/local/bin/auth', ['version']);
  // The pinned command prints its version on stdout. main.go's deferred
  // cancellation may also log shutdown on stderr as the process exits.
  assertFixtureAuthVersion(authVersion.stdout);
  stage = 'postgresql-initialize';
  await command(`${pgBin}/initdb`, [
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
  stage = 'postgresql-start';
  await start('postgres', `${pgBin}/postgres`, [
    '-D',
    data,
    '-k',
    '/run/postgresql',
    '-h',
    '127.0.0.1',
    '-c',
    'wal_level=logical',
    '-c',
    'output_plugin_libraries=pgoutput,wal2json',
    '-c',
    'max_replication_slots=20',
    '-c',
    'max_wal_senders=20',
    '-c',
    'shared_preload_libraries=pg_stat_statements',
    ...managedPostgresArguments,
  ]);
  stage = 'postgresql-ready';
  await eventually(async () => {
    try {
      await command(`${pgBin}/pg_isready`, ['-h', '/run/postgresql', '-U', 'supabase_admin']);
      return true;
    } catch {
      return false;
    }
  });
  stage = 'postgresql-create-database';
  const admin = databaseOwner.own(
    new pg.Client({
      host: '/run/postgresql',
      user: 'supabase_admin',
      database: 'postgres',
    })
  );
  await admin.connect();
  await assertBootstrapPostgresConfiguration(admin);
  await createFixtureApplicationOwner(admin);
  await admin.query(`CREATE DATABASE ${database} OWNER postgres`);
  await admin.query('REVOKE CONNECT ON DATABASE postgres, template1 FROM PUBLIC');
  await databaseOwner.end(admin);
  const bootstrap = databaseOwner.own(
    new pg.Client({ host: '/run/postgresql', user: 'supabase_admin', database })
  );
  await bootstrap.connect();
  stage = 'postgresql-bootstrap-roles';
  await bootstrap.query(serviceRoleBootstrapSql(password));
  await databaseOwner.end(bootstrap);
  const db = databaseOwner.own(
    new pg.Client({
      host: '/run/postgresql',
      user: 'postgres',
      database,
    })
  );
  await db.connect();
  let bridge, gateway;
  try {
    stage = 'postgresql-slot-identity';
    const slotIdentity = await db.query(`
      SELECT current_user = 'postgres' AND session_user = 'postgres' AS identity,
        r.rolsuper AS superuser, r.rolreplication AS replication,
        current_database() = 'club_arena_qualification' AS database,
        current_setting('wal_level') = 'logical' AS logical_wal
      FROM pg_catalog.pg_roles r WHERE r.rolname = current_user
    `);
    assert.deepEqual(slotIdentity.rows, [
      {
        identity: true,
        superuser: false,
        replication: true,
        database: true,
        logical_wal: true,
      },
    ]);
    stage = 'postgresql-wal2json-native-slot';
    // Load the real output plugin through PostgreSQL. Its presence on disk
    // alone does not prove Realtime can create its required logical slot.
    const slot = await db.query(
      "SELECT slot_name FROM pg_create_logical_replication_slot('fixture_wal2json_probe','wal2json',true)"
    );
    assert.equal(slot.rows[0]?.slot_name, 'fixture_wal2json_probe');
    stage = 'postgresql-wal2json-slot-inspection';
    const installed = await db.query(
      "SELECT plugin,temporary FROM pg_replication_slots WHERE slot_name='fixture_wal2json_probe'"
    );
    assert.deepEqual(installed.rows, [{ plugin: 'wal2json', temporary: true }]);
    stage = 'postgresql-wal2json-slot-drop';
    await db.query("SELECT pg_drop_replication_slot('fixture_wal2json_probe')");
    stage = 'postgresql-bootstrap-schemas';
    await db.query(`
      CREATE SCHEMA extensions;
    `);
    for (const [name, statement] of [
      ['dblink', 'CREATE EXTENSION dblink'],
      ['pg-stat-statements', 'CREATE EXTENSION pg_stat_statements WITH SCHEMA extensions'],
      ['pg-trgm', 'CREATE EXTENSION pg_trgm'],
      ['pgcrypto', 'CREATE EXTENSION pgcrypto WITH SCHEMA extensions'],
      ['uuid-ossp', 'CREATE EXTENSION "uuid-ossp" WITH SCHEMA extensions'],
      ['vector', 'CREATE EXTENSION vector WITH SCHEMA extensions'],
    ]) {
      stage = `postgresql-extension-${name}`;
      await db.query(statement);
    }
    stage = 'postgresql-extension-inventory';
    const extensions = await db.query(
      "SELECT extname FROM pg_extension WHERE extname IN ('dblink','pg_stat_statements','pg_trgm','pgcrypto','uuid-ossp','vector')"
    );
    assert.equal(extensions.rowCount, 6);
    stage = 'gotrue-genuine-migrations-and-mfa';
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
      GOTRUE_MFA_TOTP_ENROLL_ENABLED: 'true',
      GOTRUE_MFA_TOTP_VERIFY_ENABLED: 'true',
      GOTRUE_DISABLE_SIGNUP: 'false',
      GOTRUE_LOG_LEVEL: 'error',
    };
    stage = 'gotrue-database-namespace';
    const authDatabase = databaseOwner.own(
      new pg.Client({
        host: '127.0.0.1',
        user: 'supabase_auth_admin',
        password,
        database,
      })
    );
    await authDatabase.connect();
    assert.deepEqual(
      (
        await authDatabase.query(`SELECT
      current_schema() = 'auth' AS auth_namespace,
      current_setting('search_path') = 'auth' AS auth_search_path,
      has_schema_privilege(current_user, 'auth', 'CREATE') AS auth_create,
      has_schema_privilege(current_user, 'public', 'CREATE') AS public_create
    `)
      ).rows,
      [{ auth_namespace: true, auth_search_path: true, auth_create: true, public_create: false }]
    );
    await databaseOwner.end(authDatabase);
    stage = 'gotrue-migrate-command';
    await command('/usr/local/bin/auth', ['migrate'], authEnv);
    const authBootstrap = databaseOwner.own(
      new pg.Client({ host: '/run/postgresql', user: 'supabase_admin', database })
    );
    try {
      await authBootstrap.connect();
      await sealFixtureAuthMigrationLedger(authBootstrap);
      await alignFixtureAuthPlatformHelperGrants(authBootstrap);
    } finally {
      await databaseOwner.end(authBootstrap);
    }
    stage = 'gotrue-platform-helper-authority';
    await assertFixtureAuthPlatformHelpers(db);
    await assertFixtureAuthPlatformWriteDenied(db);
    stage = 'gotrue-migration-ledger';
    assertFixtureAuthMigrations(
      (await db.query('SELECT version FROM auth.schema_migrations')).rows.map((row) => row.version)
    );
    assert.equal(
      (await db.query("SELECT to_regclass('public.schema_migrations') IS NULL AS absent")).rows[0]
        .absent,
      true
    );
    stage = 'gotrue-server-start';
    const auth = await start('auth', '/usr/local/bin/auth', ['serve'], authEnv);
    stage = 'gotrue-server-ready';
    await eventually(() => healthy('http://127.0.0.1:9999/health'));
    const api = fixtureAuth({
      serviceKey: secrets.serviceKey,
      jwtSecret: secrets.jwtSecret,
    });
    stage = 'gotrue-real-user-signin';
    const users = await api.createUsers();
    stage = 'gotrue-real-mfa-enrollment';
    const user = await api.enrollMfa(users[0]);
    stage = 'gotrue-real-mfa-persistence';
    assert.equal(
      (await db.query("SELECT count(*)::int AS n FROM auth.mfa_factors WHERE status='verified'"))
        .rows[0].n,
      1
    );

    stage = 'gotrue-disabled-ledger-attribution';
    await api.createLedgerAttributionIdentity();
    await assertLedgerAttributionIdentity(db);

    stage = 'postgrest-14-5-authentication-and-rls';
    // Small native protocol fixture only; the full schema artifact is qualified separately.
    await db.query(`
      CREATE TABLE public.fixture_smoke (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, owner_id uuid NOT NULL REFERENCES auth.users(id), payload text NOT NULL, stream_version integer NOT NULL DEFAULT 0);
      ALTER TABLE public.fixture_smoke ENABLE ROW LEVEL SECURITY;
      CREATE POLICY own_rows ON public.fixture_smoke FOR SELECT TO authenticated USING (owner_id::text = current_setting('request.jwt.claims',true)::json->>'sub');
      GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
      GRANT SELECT ON public.fixture_smoke TO anon, authenticated, service_role;
      CREATE PUBLICATION supabase_realtime FOR TABLE public.fixture_smoke;
      CREATE FUNCTION public.fixture_auth_claims() RETURNS jsonb LANGUAGE sql STABLE
        AS $$SELECT jsonb_build_object('uid',auth.uid(),'role',auth.role(),
          'email',auth.email(),'jwt_sub',auth.jwt()->>'sub')$$;
      REVOKE ALL ON FUNCTION public.fixture_auth_claims() FROM PUBLIC;
      GRANT EXECUTE ON FUNCTION public.fixture_auth_claims() TO anon, authenticated;
    `);
    await db.query('INSERT INTO public.fixture_smoke(owner_id,payload) VALUES($1,$2)', [
      users[1].id,
      'hidden-other-user',
    ]);
    stage = 'postgrest-server-start';
    await start('postgrest', '/usr/local/bin/postgrest', [], {
      PGRST_DB_URI: `postgres://authenticator:${password}@127.0.0.1:5432/${database}`,
      PGRST_DB_SCHEMAS: 'public',
      PGRST_DB_ANON_ROLE: 'anon',
      PGRST_JWT_SECRET: secrets.jwtSecret,
      PGRST_SERVER_HOST: '127.0.0.1',
      PGRST_SERVER_PORT: '3000',
      PGRST_LOG_LEVEL: 'error',
    });
    stage = 'postgrest-server-ready';
    await eventually(() => healthy('http://127.0.0.1:3000/'));
    stage = 'gotrue-platform-helper-http';
    for (const actor of [users[1], user]) {
      const claimResponse = await fetch('http://127.0.0.1:3000/rpc/fixture_auth_claims', {
        headers: { authorization: `Bearer ${actor.session.access_token}` },
      });
      assert.equal(claimResponse.status, 200);
      assert.deepEqual(await claimResponse.json(), {
        uid: actor.id,
        role: 'authenticated',
        email: actor.email,
        jwt_sub: actor.id,
      });
    }
    const anonymousClaims = await fetch('http://127.0.0.1:3000/rpc/fixture_auth_claims');
    assert.equal(anonymousClaims.status, 200);
    assert.deepEqual(await anonymousClaims.json(), {
      uid: null,
      role: 'anon',
      email: null,
      jwt_sub: null,
    });
    stage = 'postgrest-anonymous-rls';
    const anonymous = await fetch('http://127.0.0.1:3000/fixture_smoke');
    assert.equal(anonymous.status, 200);
    assert.deepEqual(await anonymous.json(), []);
    stage = 'postgrest-invalid-token';
    assert.equal(
      (
        await fetch('http://127.0.0.1:3000/fixture_smoke', {
          headers: { authorization: 'Bearer invalid-fixture-token' },
        })
      ).status,
      401
    );
    stage = 'native-migrated-service-role-boundary';
    await assertNativeServiceRoleBoundary(db);
    stage = 'realtime-genuine-migrations-and-change';
    const realtimeEnv = {
      PORT: '4000',
      DB_HOST: '127.0.0.1',
      DB_PORT: '5432',
      DB_USER: 'supabase_admin',
      DB_PASSWORD: password,
      DB_NAME: database,
      DB_SSL: 'false',
      DB_IP_VERSION: 'ipv4',
      REALTIME_IP_VERSION: 'ipv4',
      DB_AFTER_CONNECT_QUERY: 'SET search_path TO _realtime',
      DB_ENC_KEY: secrets.realtimeEncryptionKey,
      API_JWT_SECRET: secrets.jwtSecret,
      METRICS_JWT_SECRET: secrets.jwtSecret,
      SECRET_KEY_BASE: secrets.realtimeSecret,
      APP_NAME: 'realtime',
      SELF_HOST_TENANT_NAME: 'realtime-dev',
      SEED_SELF_HOST: 'true',
      RUN_JANITOR: 'true',
      ERL_AFLAGS: '-proto_dist inet_tcp',
      // The pinned release uses named distribution with OTP's private cookie file.
      RELEASE_DISTRIBUTION: 'name',
      DNS_NODES: "''",
      RLIMIT_NOFILE: '10000',
    };
    stage = 'realtime-migrate-command';
    const realtimeMigration = await command('/app/bin/migrate', [], realtimeEnv);
    realtimeBootstrapOutput = realtimeMigration.stdout + '\n' + realtimeMigration.stderr;
    stage = 'realtime-seed-command';
    const realtimeSeed = await command(
      '/app/bin/realtime',
      ['eval', 'Realtime.Release.seeds(Realtime.Repo)'],
      realtimeEnv
    );
    realtimeBootstrapOutput += '\n' + realtimeSeed.stdout + '\n' + realtimeSeed.stderr;
    // The real seeder may return zero after a tenant migration failed. Reuse
    // the fixture's exact installed-set check before opening subscriptions.
    stage = 'realtime-tenant-migration-ledger';
    const realtimeBootstrap = databaseOwner.own(
      new pg.Client({ host: '/run/postgresql', user: 'supabase_admin', database })
    );
    try {
      await realtimeBootstrap.connect();
      await eventually(() => realtimeMigrated(realtimeBootstrap));
      stage = 'realtime-tenant-row';
      assert.equal(
        (
          await realtimeBootstrap.query(
            "SELECT count(*)::int AS n FROM _realtime.tenants WHERE external_id='realtime-dev'"
          )
        ).rows[0].n,
        1
      );
    } finally {
      await databaseOwner.end(realtimeBootstrap);
    }
    stage = 'realtime-server-start';
    await start('realtime', '/app/bin/server', [], realtimeEnv);
    stage = 'realtime-server-ready';
    await eventually(() =>
      healthy('http://127.0.0.1:4000/api/tenants/realtime-dev/health', {
        authorization: `Bearer ${secrets.anonKey}`,
      })
    );
    // The real named node must authenticate this RPC with the private file,
    // and report only a hash proving it did not use the image's baked cookie.
    stage = 'realtime-cookie-rpc';
    const cookieProof = await command(
      '/app/bin/realtime',
      [
        'rpc',
        'hash = fn value -> Base.encode16(:crypto.hash(:sha256, value), case: :lower) end; ' +
          'IO.write(Jason.encode!(%{node: Atom.to_string(node()), named: Node.alive?(), ' +
          'otp: hash.(Atom.to_string(:erlang.get_cookie())), gen_rpc: hash.(:gen_rpc_auth.get_cookie()), ' +
          'cluster_channel_is_fixed: (get_in(Application.get_env(:libcluster, :topologies), [:postgres, :config, :channel_name]) == "fixture_realtime_cluster"), ' +
          'http_listener: (case Phoenix.Endpoint.Cowboy2Adapter.server_info(RealtimeWeb.Endpoint, :http) do ' +
          '{:ok, {addr, port}} -> %{port: port, address: cond do ' +
          'addr == {127, 0, 0, 1} -> "ipv4-loopback"; addr == {0, 0, 0, 0} -> "ipv4-wildcard"; ' +
          'addr == {0, 0, 0, 0, 0, 0, 0, 1} -> "ipv6-loopback"; addr == {0, 0, 0, 0, 0, 0, 0, 0} -> "ipv6-wildcard"; ' +
          'is_tuple(addr) and tuple_size(addr) == 4 -> "ipv4-other"; ' +
          'is_tuple(addr) and tuple_size(addr) == 8 -> "ipv6-other"; true -> "unknown" end}; ' +
          '_ -> %{port: 0, address: "unknown"} end), ' +
          'override_absent: Application.get_env(:gen_rpc, :secret_cookie) == nil, ' +
          'insecure_fallback: Application.get_env(:gen_rpc, :insecure_auth_fallback_allowed, false)}))',
      ],
      realtimeEnv
    );
    stage = 'realtime-cookie-proof';
    const { http_listener: httpListener, ...cookieIdentity } = JSON.parse(cookieProof.stdout);
    assert.deepEqual(cookieIdentity, {
      node: 'realtime@127.0.0.1',
      named: true,
      otp: realtimeCookie.sha256,
      gen_rpc: realtimeCookie.sha256,
      cluster_channel_is_fixed: true,
      override_absent: true,
      insecure_fallback: false,
    });
    stage = 'realtime-loopback-and-gateway';
    const realtimeChildFailure = nativeChildFailure(children);
    if (realtimeChildFailure) throw realtimeChildFailure;
    assertRealtimeHttpListener(
      await readFile('/proc/net/tcp', 'utf8'),
      await readFile('/proc/net/tcp6', 'utf8'),
      httpListener
    );
    await command('/usr/bin/openssl', [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-days',
      '1',
      '-subj',
      '/CN=isolated-native-smoke',
      '-keyout',
      root + '/private/tls.key',
      '-out',
      root + '/private/tls.crt',
    ]);
    gateway = createFixtureGateway({
      supabaseHost: 'componentfixturetest.supabase.co',
      publicAnonKey: secrets.anonKey,
      localAnonKey: secrets.anonKey,
      // Unused smoke-only static bytes are never candidate product artifacts.
      files: new Map([
        ['index.html', Buffer.from('Native protocol smoke')],
        ['build-info.json', Buffer.from('{"scope":"native-service-smoke"}')],
      ]),
      tls: {
        key: await readFile(root + '/private/tls.key'),
        cert: await readFile(root + '/private/tls.crt'),
      },
      onFailure: () => {
        gatewayFailure = true;
      },
    });
    await gateway.listen();
    for (const token of [secrets.serviceKey, user.session.access_token]) {
      const response = await fetch('http://fixture:8000/realtime/v1/api/tenants/realtime-dev', {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(3000),
        redirect: 'error',
      });
      assert.equal(response.status, 403);
      await response.body?.cancel();
    }
    stage = 'realtime-websocket-open';
    const subscriptions = [user, users[1]].map((actor, index) => {
      const socket = new WebSocket(
        `ws://fixture:8000/realtime/v1/websocket?apikey=${encodeURIComponent(secrets.anonKey)}&vsn=1.0.0`
      );
      const stream = {
        actor,
        socket,
        topic: `realtime:native-smoke-${index}`,
        messages: [],
        failed: false,
      };
      socket.addEventListener('error', () => {
        stream.failed = true;
      });
      socket.addEventListener('message', (event) => {
        try {
          if (stream.messages.length >= 64) throw new Error('native stream exceeded frame bound');
          stream.messages.push(JSON.parse(event.data));
        } catch {
          stream.failed = true;
        }
      });
      return stream;
    });
    try {
      await eventually(async () => {
        assert.ok(subscriptions.every((stream) => !stream.failed));
        return subscriptions.every((stream) => stream.socket.readyState === WebSocket.OPEN);
      }, 15000);
      stage = 'realtime-postgres-subscription';
      for (const stream of subscriptions) {
        stream.socket.send(
          JSON.stringify({
            topic: stream.topic,
            event: 'phx_join',
            ref: '1',
            payload: {
              config: {
                broadcast: { ack: false, self: false },
                presence: { key: '' },
                // Both users request the whole table. The genuine service's
                // RLS evaluation must perform the separation, not a client filter.
                postgres_changes: [{ event: '*', schema: 'public', table: 'fixture_smoke' }],
                private: false,
              },
              access_token: stream.actor.session.access_token,
            },
          })
        );
      }
      await eventually(async () => {
        assert.ok(subscriptions.every((stream) => !stream.failed));
        return subscriptions.every(
          (stream) =>
            stream.messages.some(
              (m) =>
                m.event === 'system' &&
                m.payload?.extension === 'postgres_changes' &&
                m.payload?.status === 'ok'
            ) &&
            stream.messages.some(
              (m) => m.event === 'phx_reply' && m.ref === '1' && m.payload?.status === 'ok'
            )
        );
      });
      stage = 'realtime-causal-change';
      const inserted = await db.query(
        'INSERT INTO public.fixture_smoke(owner_id,payload) VALUES($1,$2),($3,$4) RETURNING id,owner_id',
        [users[1].id, 'native-peer-change', user.id, 'native-realtime-change']
      );
      await eventually(async () => {
        assert.ok(subscriptions.every((stream) => !stream.failed));
        return subscriptions.every((stream) =>
          stream.messages.some(
            (m) =>
              m.event === 'postgres_changes' &&
              m.payload?.data?.type === 'INSERT' &&
              m.payload?.data?.record?.owner_id === stream.actor.id
          )
        );
      });
      stage = 'realtime-two-user-causal-isolation';
      // A later UPDATE is a stream watermark after both INSERTs. Preserve the
      // payload so the separate real-browser/PostgREST observation stays valid.
      await db.query(
        'UPDATE public.fixture_smoke SET stream_version=1 WHERE id=ANY($1::bigint[])',
        [inserted.rows.map((row) => row.id)]
      );
      await eventually(async () => {
        assert.ok(subscriptions.every((stream) => !stream.failed));
        return subscriptions.every((stream) =>
          stream.messages.some(
            (m) =>
              m.event === 'postgres_changes' &&
              m.payload?.data?.type === 'UPDATE' &&
              m.payload?.data?.record?.owner_id === stream.actor.id
          )
        );
      });
      for (const stream of subscriptions) {
        const expected = inserted.rows.find((row) => row.owner_id === stream.actor.id);
        const changes = stream.messages.filter((m) => m.event === 'postgres_changes');
        assert.equal(changes.length, 2);
        assert.deepEqual(
          changes.map((m) => m.payload.data.type),
          ['INSERT', 'UPDATE']
        );
        assert.deepEqual(
          changes.map((m) => m.payload.data.record.stream_version),
          [0, 1]
        );
        for (const change of changes) {
          assert.equal(change.topic, stream.topic);
          assert.equal(change.payload.data.record.owner_id, stream.actor.id);
          assert.equal(String(change.payload.data.record.id), expected.id);
        }
      }
      stage = 'postgrest-two-user-isolation';
      for (const actor of [user, users[1]]) {
        const response = await fetch('http://127.0.0.1:3000/fixture_smoke?order=id', {
          headers: { authorization: `Bearer ${actor.session.access_token}` },
          signal: AbortSignal.timeout(3000),
          redirect: 'error',
        });
        assert.equal(response.status, 200);
        const visible = await response.json();
        assert.equal(visible.length, actor.id === user.id ? 1 : 2);
        assert.ok(visible.every((row) => row.owner_id === actor.id));
      }
      const anonymousAfterChanges = await fetch('http://127.0.0.1:3000/fixture_smoke', {
        signal: AbortSignal.timeout(3000),
        redirect: 'error',
      });
      assert.equal(anonymousAfterChanges.status, 200);
      assert.deepEqual(await anonymousAfterChanges.json(), []);
    } finally {
      for (const stream of subscriptions) stream.socket.close();
    }
    stage = 'native-observation-bridge-start';
    // These minimal base tables satisfy the exact production observation helper
    // types. They deliberately contain synthetic protocol rows, not gameplay.
    await db.query(`CREATE TABLE public.hand_history (
      table_id uuid NOT NULL, hand_number bigint NOT NULL,
      pot_size numeric(20,2) NOT NULL, rake_amount numeric(20,2) NOT NULL,
      actions jsonb NOT NULL, players jsonb NOT NULL);
      CREATE TABLE public.table_seats (table_id uuid NOT NULL, user_id uuid NOT NULL);
      ALTER TABLE public.hand_history ENABLE ROW LEVEL SECURITY;
      ALTER TABLE public.table_seats ENABLE ROW LEVEL SECURITY;`);
    assert.equal(
      (
        await db.query(
          "SELECT count(*)::integer AS count FROM pg_roles WHERE rolname='qualification_reader'"
        )
      ).rows[0].count,
      0
    );
    const binding = {
      version: 1,
      instance_id: randomUUID(),
      control_sha: control.control_sha,
      table_id: randomUUID(),
      spectator_user_id: users[2].id,
    };
    const insertHand = (number) =>
      db.query(
        `INSERT INTO public.hand_history
      (table_id,hand_number,pot_size,rake_amount,actions,players) VALUES($1,$2,3,0,$3,$4)`,
        [
          binding.table_id,
          number,
          JSON.stringify([{ type: 'synthetic-protocol-row' }]),
          JSON.stringify([users[0].id, users[1].id]),
        ]
      );
    await insertHand(1);
    await db.query('INSERT INTO public.table_seats(table_id,user_id) VALUES($1,$2),($1,$3)', [
      binding.table_id,
      users[0].id,
      users[1].id,
    ]);
    const observerDb = databaseOwner.own(
      new pg.Client({
        host: '/run/postgresql',
        user: 'postgres',
        database,
        connectionTimeoutMillis: 5000,
        query_timeout: 5000,
        statement_timeout: 5000,
      })
    );
    try {
      await observerDb.connect();
    } catch (error) {
      await databaseOwner.end(observerDb).catch(() => {});
      throw error;
    }
    bridge = await startObservationBridge({
      db: observerDb,
      binding,
      onFailure: (category) => {
        bridgeFailure = category;
      },
    });
    // The actual bridge captures floor=1 before this new, fixed test row exists.
    await insertHand(2);
    const { schemaCatalogue } = await import(
      controlModules + 'component-semantic-observations.mjs'
    );
    const catalogueDigest = await schemaCatalogue(db);
    stage = 'observer-and-browser-handoff';
    await writeFile(
      `${root}/oracle.json`,
      JSON.stringify({
        auth_pid: auth.pid,
        private_arg_hashes: [
          ...Object.entries(secrets)
            .filter(([key]) => key !== 'anonKey')
            .map(([, value]) => createHash('sha256').update(value).digest('hex')),
          realtimeCookie.sha256,
        ],
        user_id: user.id,
        access_token: user.session.access_token,
        observation_bridge: { ...bridge.binding, socket: observationSocket },
        catalogue_digest: catalogueDigest,
      }),
      { mode: 0o644 }
    );
    databaseOwner.check();
    await writeFile(`${root}/ready`, 'ready', { mode: 0o644 });
    await eventually(async () => {
      try {
        await access('/tmp/native-smoke-oracle-complete');
        return true;
      } catch {
        return false;
      }
    }, 90000);
    assert.equal(await readFile('/tmp/native-smoke-oracle-complete', 'utf8'), 'complete');
    databaseOwner.check();
    stage = 'native-migrated-service-role-boundary';
    const serviceRoles = await assertNativeServiceRoleBoundary(db);
    stage = 'managed-postgres-event-trigger-boundary';
    const managedPostgres = await assertManagedPostgresBoundary(db);
    console.log(
      JSON.stringify({
        scope: 'native-service-smoke',
        postgres: '17.11',
        extensions: 6,
        auth: '2.196.0',
        mfa: 'aal2',
        ledger_attribution: 'banned-without-session',
        service_roles: { ...serviceRoles, auth_claim_helpers: 'service-owned-and-http-verified' },
        managed_postgres: managedPostgres,
        postgrest: '14.5',
        realtime: '2.134.10',
        realtime_listener: '127.0.0.1:4000',
        realtime_gateway: 'authenticated-change-observed',
        realtime_rls: 'two-users-causal-isolation',
        change: 'observed',
        observation_bridge: 'native-synthetic-protocol',
        retries: 0,
      })
    );
  } finally {
    await gateway?.close();
    await bridge?.close();
    await databaseOwner.end(db);
  }
}

let timer;
try {
  timer = setTimeout(() => {
    console.error(JSON.stringify({ status: 'failed', stage, reason: 'deadline' }));
    process.exit(1);
  }, 300000);
  if (process.argv.length === 3 && process.argv[2] === '--peer') {
    stage = 'candidate-peer-isolation';
    assert.equal(process.getuid(), 1000);
    assert.equal(process.getgid(), 1000);
    await verifyRealtimePeerBoundary();
    console.log(
      JSON.stringify({
        scope: 'native-service-smoke',
        peer: 'passed',
        gateway: 'reachable',
        realtime_direct: 'refused',
        tenant_administration: 'refused',
      })
    );
  } else if (process.argv.length === 3 && process.argv[2] === '--oracle') await oracle();
  else {
    assert.equal(process.argv.length, 2);
    await services();
  }
} catch (error) {
  // Keep raw service output, SQL, JWTs, session objects, and URLs out of CI logs.
  const diagnostic = nativeFailureDiagnostic(
    databaseOwner.failure ? 'postgresql-client-connection' : stage,
    databaseOwner.failure ?? error
  );
  try {
    const events = await readFile('/sys/fs/cgroup/memory.events', 'utf8');
    const oom = events.match(/^oom_kill ([0-9]{1,9})$/m);
    if (oom) diagnostic.service_oom_kills = Number(oom[1]);
  } catch {
    /* Availability is not evidence of absence. */
  }
  let realtimeRuntimeOutput = '';
  try {
    realtimeRuntimeOutput = await readFile(`${root}/private/realtime.log`, 'utf8');
  } catch {
    /* A failure before Realtime starts has no service log. */
  }
  Object.assign(
    diagnostic,
    realtimeLogDiagnostic(realtimeBootstrapOutput + '\n' + realtimeRuntimeOutput)
  );
  console.error(JSON.stringify(diagnostic));
  process.exitCode = 1;
} finally {
  clearTimeout(timer);
  for (const child of children.toReversed()) if (child.exitCode === null) child.kill('SIGTERM');
  await pause(500);
  for (const child of children) if (child.exitCode === null) child.kill('SIGKILL');
  try {
    await databaseOwner.close();
  } catch (error) {
    console.error(JSON.stringify(nativeFailureDiagnostic('postgresql-client-cleanup', error)));
    process.exitCode = 1;
  }
}
