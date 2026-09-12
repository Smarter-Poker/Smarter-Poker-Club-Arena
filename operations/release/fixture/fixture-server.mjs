import { configureFixtureSafeupdate } from './safeupdate-provider.mjs';
import { captureFixtureServicePreimage } from './service-preimage.mjs';
import {
  cronPostgresArguments,
  installFixtureCron,
  assertFixtureCronCatalog,
} from './cron-provider.mjs';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, writeFile, readFile, open, access, rm, chmod, lstat } from 'node:fs/promises';
import { promisify } from 'node:util';
import net from 'node:net';
import { pathToFileURL } from 'node:url';
import {
  fixtureSecrets,
  fixtureAuth,
  browserStorage,
  assertFixtureAuthMigrations,
  assertLedgerAttributionIdentity,
} from './auth-fixture.mjs';
import { assertCanonicalSignup, assertAttributionChipSeed } from './auth-bootstrap-proof.mjs';
import {
  serviceRoleBootstrapSql,
  assertNativeServiceRoleBoundary,
  createFixtureApplicationOwner,
  assertApplicationOwnerBoundary,
  managedPostgresArguments,
  assertManagedPostgresBoundary,
  assertBootstrapPostgresConfiguration,
  sealFixtureAuthMigrationLedger,
  alignFixtureAuthPlatformHelperGrants,
  assertFixtureAuthPlatformHelpers,
  assertFixtureAuthPlatformWriteDenied,
  assertFixtureServiceBootstrap,
} from './service-role-boundary.mjs';
import { createFixtureGateway, loadStaticManifest, findPublicAnonKey } from './gateway.mjs';
import {
  extractArchive,
  startArguments,
  fixtureTemplate,
  observationControl,
  NativeDatabaseOwner,
  nativeFailureDiagnostic,
  financialActorDescriptor,
} from './runtime-files.mjs';

const exec = promisify(execFile);
const root = '/run/club-arena-qualification';
const privateRoot = root + '/private';
const pgBin = '/usr/lib/postgresql/17/bin';
const database = 'club_arena_qualification';
const packageRoot = '/opt/qualification/runtime';
const capabilities = Object.freeze({
  version: 1,
  scope: 'isolated-club-arena-fixture',
  product_suite: 'live-table-schema-v1',
  services: ['auth', 'postgresql', 'postgrest', 'realtime', 'tls-proxy'],
  browser: 'chromium',
  fixture_credentials: 'synthetic-local-only',
});
const environment = Object.freeze({
  PATH: '/usr/local/bin:/usr/bin:/bin',
  HOME: '/tmp/fixture',
  TMPDIR: '/tmp',
  XDG_CACHE_HOME: '/tmp/fixture/cache',
  RELEASE_TMP: '/tmp/fixture/realtime',
  ERL_CRASH_DUMP: '/tmp/fixture/erl_crash.dump',
  PLAYWRIGHT_BROWSERS_PATH: '/opt/qualification/browsers',
  LANG: 'C.UTF-8',
});
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Pinned Realtime v2.134.10 uses the Elixir 1.19.5 release template, rendered
// with release name realtime and its default -mode option. The whole-file
// preimages bind this fixture-only adaptation; an upstream change stops build.
export function privateRealtimeLauncher(launcher, releaseEnvironment) {
  const digest = (text) => createHash('sha256').update(text).digest('hex');
  assert.equal(
    digest(launcher),
    'b35710db4fe3c141340dac83d02fbe9d3c8407ff600eb98915f54feb69e227a9',
    'FIXTURE_REALTIME_LAUNCHER_PREIMAGE_REFUSED'
  );
  assert.equal(
    digest(releaseEnvironment),
    '3fbe75e1c0ea82357e01a38af7666f2f54fac8e389c303084a45a48aeb178121',
    'FIXTURE_REALTIME_ENV_PREIMAGE_REFUSED'
  );
  const replace = (before, after, count) => {
    assert.equal(launcher.split(before).length - 1, count);
    launcher = launcher.split(before).join(after);
  };
  replace(
    'RELEASE_COOKIE="${RELEASE_COOKIE:-"$(cat "$RELEASE_ROOT/releases/COOKIE")"}"\nexport RELEASE_COOKIE\n',
    '# Fixture: OTP reads the private HOME/.erlang.cookie itself. Never put it in argv.\n' +
      'if [ -n "${RELEASE_COOKIE:-}" ]; then\n' +
      '  echo "FIXTURE_REALTIME_COOKIE_ENV_REFUSED" >&2\n  exit 1\nfi\n',
    1
  );
  replace('       --cookie "$RELEASE_COOKIE" \\\n', '', 2);
  replace('--hidden --cookie "$RELEASE_COOKIE" \\', '--hidden \\', 2);
  assert.ok(!launcher.includes('--cookie') && !launcher.includes('-setcookie'));
  return launcher;
}

// Build-time only, after the immutable image's release has been copied. No
// runtime/candidate input selects a launcher path or supplies replacement code.
export async function adaptRealtimeLauncher() {
  assert.equal(process.getuid(), 0);
  const launcher = '/app/bin/realtime';
  const releaseEnvironment = '/app/releases/2.134.10/env.sh';
  for (const file of [launcher, releaseEnvironment]) {
    const details = await lstat(file);
    assert.ok(details.isFile() && !details.isSymbolicLink());
  }
  const adapted = privateRealtimeLauncher(
    await readFile(launcher, 'utf8'),
    await readFile(releaseEnvironment, 'utf8')
  );
  await writeFile(launcher, adapted);
  await chmod(launcher, 0o555);
}

// The pinned upstream HTTP listener otherwise binds every interface. Keep the
// genuine endpoint/auth implementation, but expose it only to our local gateway.
// libcluster_postgres otherwise reuses the OTP cookie as a LISTEN channel. Our
// 96-byte private cookie exceeds Postgrex's 63-byte channel limit and must never
// serve as a database channel name. Keep authentication and discovery separate.
export function loopbackRealtimeConfiguration(source) {
  assert.equal(
    createHash('sha256').update(source).digest('hex'),
    '6892bee389b9974972ece8e8737d2cdbe8bac50e82f2776037641e786b16d84c',
    'FIXTURE_REALTIME_CONFIG_PREIMAGE_REFUSED'
  );
  const before = 'socket_opts: [realtime_ip_version]';
  assert.equal(source.split(before).length - 1, 1);
  const discovery = 'strategy: LibclusterPostgres.Strategy,\n            config: [\n';
  assert.equal(source.split(discovery).length - 1, 1);
  return source
    .replace(before, 'socket_opts: [realtime_ip_version, {:ip, {127, 0, 0, 1}}]')
    .replace(discovery, discovery + '              channel_name: "fixture_realtime_cluster",\n');
}

export async function adaptRealtimeConfiguration() {
  assert.equal(process.getuid(), 0);
  const file = '/app/releases/2.134.10/runtime.exs';
  const details = await lstat(file);
  assert.ok(details.isFile() && !details.isSymbolicLink());
  const adapted = loopbackRealtimeConfiguration(await readFile(file, 'utf8'));
  await writeFile(file, adapted);
  await chmod(file, 0o444);
}

// Actual Linux network-namespace evidence, independent of application config.
// A healthy loopback request alone cannot exclude an additional wildcard bind.
export function assertRealtimeHttpListener(tcp, tcp6, endpoint) {
  const listeners = [];
  const inspected = { listener_rows4: 0, listener_rows6: 0, listener_port4000: 0 };
  const refuse = (reason) => {
    const counts = {
      listener_loopback4: listeners.filter(
        ([family, address]) => family === 'ipv4' && address === '0100007F:0FA0'
      ).length,
      listener_other4: listeners.filter(
        ([family, address]) => family === 'ipv4' && address !== '0100007F:0FA0'
      ).length,
      listener_ipv6: listeners.filter(([family]) => family === 'ipv6').length,
    };
    throw Object.assign(new Error('FIXTURE_REALTIME_LISTENER_REFUSED'), {
      listener_reason: reason,
      ...counts,
      ...inspected,
      ...(endpoint
        ? { listener_http_port: endpoint.port, listener_http_address: endpoint.address }
        : {}),
    });
  };
  for (const [family, source] of [
    ['ipv4', tcp],
    ['ipv6', tcp6],
  ]) {
    const lines = source.trim().split('\n');
    if (!/local_address\s+rem(?:ote)?_address\s+st/.test(lines.shift())) refuse('header');
    for (const line of lines) {
      const fields = line.trim().split(/\s+/);
      if (fields.length < 10) refuse('row-shape');
      const local = fields[1];
      if (
        !(family === 'ipv4' ? /^[A-F0-9]{8}:[A-F0-9]{4}$/ : /^[A-F0-9]{32}:[A-F0-9]{4}$/).test(
          local
        )
      )
        refuse('address-shape');
      inspected[family === 'ipv4' ? 'listener_rows4' : 'listener_rows6']++;
      if (local.endsWith(':0FA0')) inspected.listener_port4000++;
      if (local.endsWith(':0FA0') && fields[3] === '0A') listeners.push([family, local]);
    }
  }
  if (listeners.length !== 1 || listeners[0][0] !== 'ipv4' || listeners[0][1] !== '0100007F:0FA0')
    refuse('listener-set');
}

// Run only in the separate smoke peer. Positive gateway reachability must pass
// before ECONNREFUSED can count; DNS errors/timeouts never prove isolation.
export async function verifyRealtimePeerBoundary(testHarness = {}) {
  const { host = 'fixture', apiPort = 8000, realtimePort = 4000 } = testHarness;
  const healthResponse = await fetch(`http://${host}:${apiPort}/auth/v1/health`, {
    signal: AbortSignal.timeout(3000),
    redirect: 'error',
  });
  assert.equal(healthResponse.status, 200);
  await healthResponse.body?.cancel();
  await new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port: realtimePort });
    socket.setTimeout(3000, () => socket.destroy(new Error('FIXTURE_PEER_CONNECTION_TIMEOUT')));
    socket.once('connect', () => {
      socket.destroy();
      reject(new Error('FIXTURE_PEER_REALTIME_EXPOSED'));
    });
    socket.once('error', (error) => {
      socket.destroy();
      if (error.code === 'ECONNREFUSED') resolve();
      else reject(new Error('FIXTURE_PEER_CONNECTION_UNPROVEN'));
    });
  });
  const refused = await fetch(`http://${host}:${apiPort}/realtime/v1/api/tenants/realtime-dev`, {
    signal: AbortSignal.timeout(3000),
    redirect: 'error',
  });
  assert.equal(refused.status, 403);
  await refused.body?.cancel();
}

// The optional harness is for local filesystem tests; no wire or environment
// input can change the production home/UID. Return only an argument-scan hash.
export async function prepareRealtimeCookie(testHarness = {}) {
  const { home = '/tmp/fixture', uid = 1000, gid = 1000 } = testHarness;
  assert.equal(process.getuid(), uid);
  assert.equal(process.getgid(), gid);
  const parent = await lstat(home);
  assert.ok(
    parent.isDirectory() &&
      !parent.isSymbolicLink() &&
      parent.uid === uid &&
      parent.gid === gid &&
      (parent.mode & 0o7777) === 0o700,
    'FIXTURE_REALTIME_COOKIE_HOME_REFUSED'
  );
  const cookie = randomBytes(48).toString('hex');
  const file = await open(
    home + '/.erlang.cookie',
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o400
  );
  try {
    const details = await file.stat();
    assert.ok(
      details.isFile() &&
        details.nlink === 1 &&
        details.uid === uid &&
        details.gid === gid &&
        (details.mode & 0o7777) === 0o400,
      'FIXTURE_REALTIME_COOKIE_FILE_REFUSED'
    );
    await file.writeFile(cookie + '\n');
  } finally {
    await file.close();
  }
  return { sha256: createHash('sha256').update(cookie).digest('hex') };
}

export class ServiceSupervisor {
  constructor({ logRoot = privateRoot, env = environment } = {}) {
    this.logRoot = logRoot;
    this.env = env;
    this.children = [];
    this.stopped = false;
    this.failure = null;
    this.abort = new AbortController();
    this.failed = new Promise((resolve) => {
      this.signalFailure = resolve;
    });
    this.databaseOwner = new NativeDatabaseOwner();
    this.databaseOwner.signal.addEventListener(
      'abort',
      () => this.fail('postgresql-client-connection'),
      { once: true }
    );
  }

  fail(name) {
    if (this.stopped || this.failure) return;
    this.failure = name;
    this.abort.abort();
    this.signalFailure(name);
  }

  assertHealthy() {
    assert.equal(this.failure, null, 'fixture service failed');
    assert.equal(this.stopped, false, 'fixture stopped');
  }

  async start(name, binary, args, env = {}) {
    assert.match(name, /^[a-z][a-z0-9-]*$/);
    this.assertHealthy();
    const log = await open(`${this.logRoot}/${name}.log`, 'wx', 0o600);
    let child;
    try {
      child = spawn(binary, args, {
        env: { ...this.env, ...env },
        stdio: ['ignore', log.fd, log.fd],
      });
      this.children.push(child);
      child.once('error', () => this.fail(name));
      child.once('exit', () => this.fail(name));
      await new Promise((resolve, reject) => {
        child.once('spawn', resolve);
        child.once('error', reject);
      });
    } finally {
      await log.close();
    }
    this.assertHealthy();
    return child;
  }

  async command(binary, args, env = {}) {
    this.assertHealthy();
    const pending = exec(binary, args, {
      env: { ...this.env, ...env },
      timeout: 90000,
      maxBuffer: 8 * 1024 * 1024,
      signal: this.abort.signal,
    });
    // execFile exposes its actual owned child on the promise. Track it too:
    // an aborted command may reject while a SIGTERM-ignoring child still lives.
    this.children.push(pending.child);
    const result = await pending;
    this.assertHealthy();
    return result;
  }

  async until(check, milliseconds = 60000) {
    const deadline = Date.now() + milliseconds;
    for (;;) {
      this.assertHealthy();
      const okay = await check();
      this.assertHealthy();
      assert.ok(Date.now() <= deadline, 'fixture readiness deadline expired');
      if (okay) return;
      await pause(150);
    }
  }

  async close() {
    this.stopped = true;
    this.abort.abort();
    try {
      await this.closeChildren();
    } finally {
      await this.databaseOwner.close();
    }
  }

  async closeChildren() {
    // Only our own direct children are signalled. The container's tini owns
    // their descendants; no process scan, external PID or port is targeted.
    // A failed spawn has no PID and never emits exit: it owns no OS process.
    const children = this.children.filter((child) => Number.isInteger(child.pid) && child.pid > 0);
    const exited = (child) => child.exitCode !== null || child.signalCode !== null;
    const waitForExit = (milliseconds) =>
      new Promise((resolve) => {
        const pending = children.filter((child) => !exited(child));
        if (pending.length === 0) return resolve(true);
        const finish = (complete) => {
          clearTimeout(timer);
          for (const child of pending) child.removeListener('exit', check);
          resolve(complete);
        };
        const check = () => {
          if (pending.every(exited)) finish(true);
        };
        const timer = setTimeout(() => finish(false), milliseconds);
        for (const child of pending) child.once('exit', check);
        check();
      });
    for (const child of [...children].reverse()) {
      if (!exited(child)) child.kill('SIGTERM');
    }
    if (await waitForExit(5000)) return;
    for (const child of children) {
      if (!exited(child)) child.kill('SIGKILL');
    }
    assert.ok(await waitForExit(5000), 'fixture owned child exit was not observed after SIGKILL');
  }
}

// Attempt every owned close even if another resource throws or never settles.
// The outer driver still owns final container removal and absence verification.
export async function closeFixtureResources(
  { retireReady, actors, gateway, bridge, supervisor },
  deadlineMs = 25000
) {
  const closing = Promise.allSettled(
    [
      retireReady,
      () => actors?.close(),
      () => gateway?.close(),
      () => bridge?.close(),
      () => supervisor.close(),
    ].map((close) => Promise.resolve().then(close))
  );
  let timer;
  try {
    const results = await Promise.race([
      closing,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('FIXTURE_CLEANUP_DEADLINE')), deadlineMs);
      }),
    ]);
    assert.ok(
      results.every((result) => result.status === 'fulfilled'),
      'FIXTURE_CLEANUP_FAILED'
    );
  } finally {
    clearTimeout(timer);
  }
}

async function health(url, headers = {}) {
  try {
    return (await fetch(url, { headers, signal: AbortSignal.timeout(1000), redirect: 'error' })).ok;
  } catch {
    return false;
  }
}

async function jsonHealth(url, field, headers = {}) {
  try {
    const response = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(1000),
      redirect: 'error',
    });
    return response.ok && (await response.json())?.[field] === true;
  } catch {
    return false;
  }
}

export async function realtimeMigrated(db) {
  await assertFixtureServiceBootstrap(db);
  try {
    const result = await db.query(`SELECT
      (SELECT count(*)=82 AND min(version)=20211116024918 AND max(version)=20260714120000
        AND md5(string_agg(version::text, ',' ORDER BY version))='5c633bad1193b061e2d200e5a18c9c53'
        FROM realtime.schema_migrations) AND
      EXISTS(SELECT 1 FROM pg_attribute a JOIN pg_attrdef d
        ON d.adrelid=a.attrelid AND d.adnum=a.attnum
        WHERE a.attrelid='realtime.messages'::regclass AND a.attname='skip_broadcast'
          AND a.atttypid='boolean'::regtype AND a.attnotnull AND pg_get_expr(d.adbin,d.adrelid)='false') AND
      EXISTS(SELECT 1 FROM _realtime.tenants WHERE external_id='realtime-dev' AND migrations_ran=82)
      AS complete`);
    return result.rows[0]?.complete === true;
  } catch (error) {
    // A service still creating its catalog may not be ready. Authorization
    // and transport errors are failures, not sixty seconds of false readiness.
    if (error?.code === '42P01' || error?.code === '3F000') return false;
    throw error;
  }
}

async function checkPackage() {
  assert.equal(process.platform, 'linux');
  assert.equal(process.arch, 'x64');
  assert.equal(process.version, 'v22.23.2');
  assert.equal(process.getuid(), 1000);
  for (const binary of [
    `${pgBin}/initdb`,
    `${pgBin}/postgres`,
    `${pgBin}/psql`,
    '/usr/local/bin/auth',
    '/usr/local/bin/postgrest',
    '/app/bin/server',
    '/app/bin/migrate',
    '/usr/bin/openssl',
    '/usr/bin/unzip',
  ])
    await access(binary, constants.X_OK);
  for (const name of [
    'fixture-server.mjs',
    'service-preimage.mjs',
    'runtime-files.mjs',
    'gateway.mjs',
    'auth-fixture.mjs',
    'auth-bootstrap-proof.mjs',
    'service-role-boundary.mjs',
    'actors.mjs',
    'financial-route-phase.mjs',
    'seed-fixture.mjs',
    'observation-bridge.mjs',
  ])
    await access(`${packageRoot}/${name}`, constants.R_OK);
}

function serviceEnvironments(secrets) {
  const password = secrets.databasePassword;
  assert.match(password, /^[a-f0-9]{64}$/);
  return {
    auth: {
      GOTRUE_API_HOST: '127.0.0.1',
      GOTRUE_API_PORT: '9999',
      API_EXTERNAL_URL: 'https://smarter.poker',
      GOTRUE_DB_DRIVER: 'postgres',
      GOTRUE_DB_DATABASE_URL: `postgres://supabase_auth_admin:${password}@127.0.0.1:5432/${database}`,
      GOTRUE_SITE_URL: 'https://smarter.poker/hub/club-arena/',
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
    },
    rest: {
      PGRST_DB_URI: `postgres://authenticator:${password}@127.0.0.1:5432/${database}`,
      PGRST_DB_SCHEMAS: 'public',
      PGRST_DB_ANON_ROLE: 'anon',
      PGRST_JWT_SECRET: secrets.jwtSecret,
      PGRST_DB_PRE_REQUEST: 'smarter_private.fn_smarter_data_api_pre_request',
      PGRST_SERVER_HOST: '127.0.0.1',
      PGRST_SERVER_PORT: '3000',
      PGRST_LOG_LEVEL: 'error',
    },
    realtime: {
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
      // Pinned env.sh forces name. Preserve genuine distribution/authentication;
      // the adapted launcher lets OTP read the private cookie file, never argv.
      RELEASE_DISTRIBUTION: 'name',
      APP_NAME: 'realtime',
      SELF_HOST_TENANT_NAME: 'realtime-dev',
      SEED_SELF_HOST: 'true',
      RUN_JANITOR: 'true',
      ERL_AFLAGS: '-proto_dist inet_tcp',
      DNS_NODES: "''",
      RLIMIT_NOFILE: '10000',
    },
  };
}

async function start(args, preimageOnly = false) {
  if (preimageOnly) assert.equal(args.length, 0);
  const inputs = preimageOnly ? null : startArguments(args);
  await checkPackage();
  process.umask(0o077);
  await mkdir(root, { mode: 0o755 });
  await chmod(root, 0o755);
  await mkdir(privateRoot, { mode: 0o700 });
  await mkdir('/tmp/fixture/realtime', { recursive: true, mode: 0o700 });
  await prepareRealtimeCookie();
  await mkdir('/run/postgresql', { mode: 0o700 });
  const supervisor = new ServiceSupervisor();
  let db, gateway, actors, bridge;
  let stage = 'archives';
  const stop = () => supervisor.fail('termination');
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  try {
    let control, template, files, publicAnonKey;
    const schemaRoot = privateRoot + '/schema';
    const webRoot = privateRoot + '/web';
    // The dedicated preimage command stops before any application archive,
    // signup, gateway or funded actor. Ordinary start keeps every input gate.
    if (!preimageOnly) {
      const controlFile = await open(
        '/inputs/observation-control.json',
        constants.O_RDONLY | constants.O_NOFOLLOW
      );
      try {
        const details = await controlFile.stat();
        assert.ok(
          details.isFile() &&
            details.size > 0 &&
            details.size <= 1024 &&
            (details.mode & 0o222) === 0
        );
        control = observationControl(JSON.parse(await controlFile.readFile('utf8')));
      } finally {
        await controlFile.close();
      }
      await extractArchive(inputs.schema, schemaRoot, { maxBytes: 128 * 1024 * 1024 });
      await extractArchive(inputs.web, webRoot);
      template = fixtureTemplate(JSON.parse(await readFile(schemaRoot + '/fixture.json', 'utf8')));
      files = await loadStaticManifest(webRoot);
      publicAnonKey = findPublicAnonKey([...files.values()], template.supabase_host);
    }
    const secrets = fixtureSecrets();
    const env = serviceEnvironments(secrets);
    const pgData = '/var/lib/postgresql/data';
    stage = 'postgresql';
    await supervisor.command(`${pgBin}/initdb`, [
      '-D',
      pgData,
      '-U',
      'supabase_admin',
      '--auth-local=peer',
      '--auth-host=scram-sha-256',
      '--no-locale',
      '--encoding=UTF8',
    ]);
    await writeFile(
      pgData + '/pg_hba.conf',
      'local all all peer map=fixture_users\nhost all all 127.0.0.1/32 scram-sha-256\n'
    );
    await writeFile(
      pgData + '/pg_ident.conf',
      'fixture_users fixture supabase_admin\nfixture_users fixture postgres\n'
    );
    await supervisor.start('postgres', `${pgBin}/postgres`, [
      '-D',
      pgData,
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
      'shared_preload_libraries=pg_stat_statements,pg_cron',
      ...cronPostgresArguments,
      ...managedPostgresArguments,
    ]);
    await supervisor.until(async () => {
      try {
        await supervisor.command(`${pgBin}/pg_isready`, [
          '-h',
          '/run/postgresql',
          '-U',
          'supabase_admin',
        ]);
        return true;
      } catch {
        return false;
      }
    });
    const { default: pg } = await import('pg');
    const connection = {
      host: '/run/postgresql',
      user: 'postgres',
      connectionTimeoutMillis: 5000,
      query_timeout: 5000,
      statement_timeout: 5000,
    };
    db = supervisor.databaseOwner.own(
      new pg.Client({ ...connection, user: 'supabase_admin', database: 'postgres' })
    );
    await db.connect();
    await assertBootstrapPostgresConfiguration(db);
    await createFixtureApplicationOwner(db);
    await db.query(`CREATE DATABASE ${database} OWNER postgres`);
    await db.query('REVOKE CONNECT ON DATABASE postgres, template1 FROM PUBLIC');
    await supervisor.databaseOwner.end(db);
    db = supervisor.databaseOwner.own(
      new pg.Client({ ...connection, user: 'supabase_admin', database })
    );
    await db.connect();
    await db.query(serviceRoleBootstrapSql(secrets.databasePassword));
    stage = 'postgresql-native-cron-install';
    await installFixtureCron(db);
    stage = 'postgresql-safeupdate-configure';
    await configureFixtureSafeupdate(db);
    await supervisor.databaseOwner.end(db);
    db = supervisor.databaseOwner.own(new pg.Client({ ...connection, database }));
    await db.connect();
    stage = 'genuine-auth-migrations';
    await supervisor.command('/usr/local/bin/auth', ['migrate'], env.auth);
    const authBootstrap = supervisor.databaseOwner.own(
      new pg.Client({ ...connection, user: 'supabase_admin', database })
    );
    try {
      await authBootstrap.connect();
      await sealFixtureAuthMigrationLedger(authBootstrap);
      await alignFixtureAuthPlatformHelperGrants(authBootstrap);
    } finally {
      await supervisor.databaseOwner.end(authBootstrap);
    }
    assertFixtureAuthMigrations(
      (await db.query('SELECT version FROM auth.schema_migrations')).rows.map((row) => row.version)
    );
    stage = 'genuine-realtime-migrations';
    await supervisor.command('/app/bin/migrate', [], env.realtime);
    await supervisor.command(
      '/app/bin/realtime',
      ['eval', 'Realtime.Release.seeds(Realtime.Repo)'],
      env.realtime
    );
    // The seed calls genuine tenant migrations, but its process exit alone
    // does not prove they succeeded. Read their exact pinned installed set;
    // never stamp a migration row to make an incomplete service look current.
    const realtimeBootstrap = supervisor.databaseOwner.own(
      new pg.Client({ ...connection, user: 'supabase_admin', database })
    );
    try {
      await realtimeBootstrap.connect();
      await supervisor.until(() => realtimeMigrated(realtimeBootstrap));
    } finally {
      await supervisor.databaseOwner.end(realtimeBootstrap);
    }
    const serviceRoles = await assertNativeServiceRoleBoundary(db);
    stage = 'managed-postgres-event-trigger-boundary';
    const managedPostgres = await assertManagedPostgresBoundary(db);
    if (preimageOnly) {
      stage = 'post-service-catalog-preimage';
      const preimageBootstrap = supervisor.databaseOwner.own(
        new pg.Client({ ...connection, user: 'supabase_admin', database })
      );
      try {
        await preimageBootstrap.connect();
        const captured = await captureFixtureServicePreimage(preimageBootstrap, db.processID);
        await writeFile(root + '/service-preimage.json', captured.serialized, {
          flag: 'wx',
          mode: 0o444,
        });
        process.stdout.write(JSON.stringify(captured.proof) + '\n');
      } finally {
        await supervisor.databaseOwner.end(preimageBootstrap);
      }
      // Docker tmpfs disappears on container stop. Keep this exact bootstrap
      // alive until the outer owner copies the catalog, then shut down normally.
      await writeFile(root + '/service-preimage.ready', '', { flag: 'wx', mode: 0o400 });
      await supervisor.until(async () => {
        try {
          await access(root + '/service-preimage.copied', constants.F_OK);
          return true;
        } catch (error) {
          if (error.code === 'ENOENT') return false;
          throw error;
        }
      });
      return;
    }
    // Application DDL is restored verbatim. The reviewed schema composer
    // must reconcile service-managed objects with the pinned real migrations.
    // Missing/duplicate objects fail here; no migration history is fabricated.
    stage = 'application-schema';
    await supervisor.command(`${pgBin}/psql`, [
      '-X',
      '-v',
      'ON_ERROR_STOP=1',
      '-h',
      '/run/postgresql',
      '-U',
      'postgres',
      '-d',
      database,
      '-f',
      schemaRoot + '/schema.sql',
    ]);
    const applicationOwner = await assertApplicationOwnerBoundary(db);
    await assertFixtureAuthPlatformHelpers(db);
    await assertFixtureCronCatalog(db);
    await assertFixtureAuthPlatformWriteDenied(db);
    await supervisor.start('auth', '/usr/local/bin/auth', ['serve'], env.auth);
    await supervisor.until(() => health('http://127.0.0.1:9999/health'));
    stage = 'real-users-and-financial-seed';
    const api = fixtureAuth({ serviceKey: secrets.serviceKey, jwtSecret: secrets.jwtSecret });
    const users = await api.createUsers();
    users[2] = await api.enrollMfa(users[2]);
    const { seedFixture } = await import('./seed-fixture.mjs');
    const fixture = await seedFixture({
      db,
      actorIds: users.slice(0, 2).map((user) => user.id),
      spectatorId: users[2].id,
      sessionIds: users.map((user) => user.sessionId),
      financialScenario: inputs.financialScenario === true,
    });
    stage = 'disabled-ledger-attribution';
    const attributionId = await api.createLedgerAttributionIdentity();
    await assertLedgerAttributionIdentity(db);
    const attributionSignup = await assertCanonicalSignup(db, [attributionId]);
    await assertAttributionChipSeed(db, attributionId);
    const spectator = users[2];
    stage = 'private-observation-bridge';
    const { startObservationBridge } = await import('./observation-bridge.mjs');
    const observerDb = supervisor.databaseOwner.own(new pg.Client({ ...connection, database }));
    try {
      await observerDb.connect();
    } catch (error) {
      await supervisor.databaseOwner.end(observerDb).catch(() => {});
      throw error;
    }
    // The bridge owns this private connection from invocation through close,
    // including startup failure. The browser has no PostgreSQL identity.
    bridge = await startObservationBridge({
      db: observerDb,
      financialActors: users.slice(0, 2).map((user) => user.id),
      binding: {
        version: 1,
        instance_id: randomUUID(),
        control_sha: control.control_sha,
        table_id: fixture.table_id,
        spectator_user_id: spectator.id,
      },
      onFailure: () => supervisor.fail('observation-bridge'),
    });
    stage = 'service-readiness';
    await supervisor.start('postgrest', '/usr/local/bin/postgrest', [], env.rest);
    await supervisor.until(() =>
      health('http://127.0.0.1:3000/', { authorization: `Bearer ${secrets.serviceKey}` })
    );
    await supervisor.start('realtime', '/app/bin/server', [], env.realtime);
    await supervisor.until(() =>
      jsonHealth('http://127.0.0.1:4000/api/tenants/realtime-dev/health', 'healthy', {
        authorization: `Bearer ${secrets.anonKey}`,
      })
    );
    assertRealtimeHttpListener(
      await readFile('/proc/net/tcp', 'utf8'),
      await readFile('/proc/net/tcp6', 'utf8')
    );
    stage = 'tls-proxy';
    await supervisor.command('/usr/bin/openssl', [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-days',
      '1',
      '-subj',
      '/CN=isolated-component-fixture',
      '-addext',
      `subjectAltName=DNS:smarter.poker,DNS:ca-static.smarter.poker,DNS:engine.smarter.poker,DNS:${template.supabase_host}`,
      '-keyout',
      privateRoot + '/tls.key',
      '-out',
      privateRoot + '/tls.crt',
    ]);
    gateway = createFixtureGateway({
      supabaseHost: template.supabase_host,
      publicAnonKey,
      onFailure: () => supervisor.fail('gateway'),
      localAnonKey: secrets.anonKey,
      files,
      tls: {
        key: await readFile(privateRoot + '/tls.key'),
        cert: await readFile(privateRoot + '/tls.crt'),
      },
    });
    await gateway.listen();
    await writeFile(
      privateRoot + '/engine.json',
      JSON.stringify({
        SUPABASE_URL: 'http://fixture:8000',
        SUPABASE_SERVICE_ROLE_KEY: secrets.serviceKey,
        PORT: '8080',
        NODE_ENV: 'production',
      }),
      { flag: 'wx', mode: 0o600 }
    );
    await writeFile(
      root + '/fixture.json',
      JSON.stringify({
        version: 1,
        scope: capabilities.scope,
        source_contract: template.source_contract,
        bootstrap_proof: {
          service_roles: serviceRoles,
          managed_postgres: managedPostgres,
          application_owner: applicationOwner,
          signup: fixture.signup_proof,
          attribution_signup: attributionSignup,
        },
        observation_bridge: { ...bridge.binding, socket: '/run/fixture-observer/observation.sock' },
        table_id: fixture.table_id,
        spectator_user_id: spectator.id,
        storage_state: browserStorage(spectator.session, template.supabase_host),
        ...(inputs.financialScenario
          ? {
              financial_scenario: financialActorDescriptor(fixture, users.slice(0, 2)),
            }
          : {}),
        base_url: 'https://smarter.poker/hub/club-arena/',
        engine_health_url: 'https://engine.smarter.poker/health',
      }),
      { flag: 'wx', mode: 0o644 }
    );
    await chmod(root + '/fixture.json', 0o644);
    stage = 'engine-start-and-actors';
    await writeFile(privateRoot + '/ready.json', JSON.stringify({ pid: process.pid }), {
      flag: 'wx',
      mode: 0o600,
    });
    // Engine starts only after the driver observes service readiness. This
    // bounded wait does not certify its source; the independent oracle does.
    await supervisor.until(() => jsonHealth('http://engine:8080/health', 'running'), 90000);
    // Financial actions belong to the independent UID1001 observer process.
    // Starting fixture-owned actors here too would race two owners per seat.
    if (!inputs.financialScenario) {
      const { startFixtureActors } = await import('./actors.mjs');
      actors = await startFixtureActors({
        tableId: fixture.table_id,
        users: users.slice(0, 2),
        onFailure: () => supervisor.fail('actors'),
      });
    }
    await supervisor.failed;
    throw new Error('fixture service stopped');
  } catch (error) {
    // Private service logs can include synthetic credentials. Public stderr
    // contains the bounded stage only, never child output or raw SQL/errors.
    process.stderr.write(`FIXTURE_FAILED:${stage}\n`);
    if (preimageOnly) {
      process.stderr.write(
        JSON.stringify(nativeFailureDiagnostic('fixture-service-preimage', error)) + '\n'
      );
    }
    process.exitCode = 1;
  } finally {
    try {
      await closeFixtureResources({
        retireReady: () => rm(privateRoot + '/ready.json', { force: true }),
        actors,
        gateway,
        bridge,
        supervisor,
      });
    } finally {
      process.removeListener('SIGTERM', stop);
      process.removeListener('SIGINT', stop);
    }
  }
}

async function ready() {
  await checkPackage();
  const deadline = Date.now() + 115000;
  for (;;) {
    try {
      const value = JSON.parse(await readFile(privateRoot + '/ready.json', 'utf8'));
      assert.ok(Number.isSafeInteger(value.pid) && value.pid > 1);
      process.kill(value.pid, 0);
      const command = await readFile(`/proc/${value.pid}/cmdline`, 'utf8');
      assert.ok(command.split('\0').includes(packageRoot + '/fixture-server.mjs'));
      if (await health('http://127.0.0.1:9999/health')) return;
    } catch {
      /* Keep the original startup deadline; do not start anything. */
    }
    assert.ok(Date.now() < deadline, 'fixture did not become ready');
    await pause(200);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [command, ...args] = process.argv.slice(2);
    if (command === 'start') await start(args);
    else if (command === 'preimage') await start(args, true);
    else {
      assert.equal(args.length, 0);
      if (command === 'capabilities') {
        await checkPackage();
        process.stdout.write(JSON.stringify(capabilities) + '\n');
      } else if (command === 'ready') await ready();
      else if (command === 'engine-environment') {
        await ready();
        process.stdout.write(await readFile(privateRoot + '/engine.json', 'utf8'));
      } else throw new Error('unsupported fixture command');
    }
  } catch {
    process.stderr.write('FIXTURE_COMMAND_REFUSED\n');
    process.exitCode = 1;
  }
}
