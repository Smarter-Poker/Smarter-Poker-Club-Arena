import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, writeFile, readFile, open, access, rm, chmod, lstat } from 'node:fs/promises';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { fixtureSecrets, fixtureAuth, browserStorage } from './auth-fixture.mjs';
import { createFixtureGateway, loadStaticManifest, findPublicAnonKey } from './gateway.mjs';
import {
  extractArchive,
  startArguments,
  fixtureTemplate,
  observationControl,
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

async function realtimeMigrated(db) {
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
  } catch {
    return false;
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
    'runtime-files.mjs',
    'gateway.mjs',
    'auth-fixture.mjs',
    'actors.mjs',
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

async function start(args) {
  const inputs = startArguments(args);
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
    const controlFile = await open(
      '/inputs/observation-control.json',
      constants.O_RDONLY | constants.O_NOFOLLOW
    );
    let control;
    try {
      const details = await controlFile.stat();
      assert.ok(
        details.isFile() && details.size > 0 && details.size <= 1024 && (details.mode & 0o222) === 0
      );
      control = observationControl(JSON.parse(await controlFile.readFile('utf8')));
    } finally {
      await controlFile.close();
    }
    const schemaRoot = privateRoot + '/schema';
    const webRoot = privateRoot + '/web';
    await extractArchive(inputs.schema, schemaRoot, { maxBytes: 128 * 1024 * 1024 });
    await extractArchive(inputs.web, webRoot);
    const template = fixtureTemplate(
      JSON.parse(await readFile(schemaRoot + '/fixture.json', 'utf8'))
    );
    const files = await loadStaticManifest(webRoot);
    const publicAnonKey = findPublicAnonKey([...files.values()], template.supabase_host);
    const secrets = fixtureSecrets();
    const env = serviceEnvironments(secrets);
    const pgData = '/var/lib/postgresql/data';
    stage = 'postgresql';
    await supervisor.command(`${pgBin}/initdb`, [
      '-D',
      pgData,
      '-U',
      'postgres',
      '--auth-local=peer',
      '--auth-host=scram-sha-256',
      '--no-locale',
      '--encoding=UTF8',
    ]);
    await writeFile(
      pgData + '/pg_hba.conf',
      'local all all peer map=fixture_users\nhost all all 127.0.0.1/32 scram-sha-256\n'
    );
    await writeFile(pgData + '/pg_ident.conf', 'fixture_users fixture postgres\n');
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
      'max_replication_slots=20',
      '-c',
      'max_wal_senders=20',
      '-c',
      'shared_preload_libraries=pg_stat_statements',
    ]);
    await supervisor.until(async () => {
      try {
        await supervisor.command(`${pgBin}/pg_isready`, [
          '-h',
          '/run/postgresql',
          '-U',
          'postgres',
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
    db = new pg.Client({ ...connection, database: 'postgres' });
    await db.connect();
    await db.query(`CREATE DATABASE ${database}`);
    await db.query('REVOKE CONNECT ON DATABASE postgres, template1 FROM PUBLIC');
    await db.end();
    db = new pg.Client({ ...connection, database });
    await db.connect();
    await db.query(`CREATE ROLE anon NOLOGIN NOBYPASSRLS;
      CREATE ROLE authenticated NOLOGIN NOBYPASSRLS;
      CREATE ROLE service_role NOLOGIN BYPASSRLS;
      CREATE ROLE authenticator LOGIN NOINHERIT PASSWORD '${secrets.databasePassword}';
      GRANT anon, authenticated, service_role TO authenticator;
      CREATE ROLE supabase_auth_admin LOGIN CREATEROLE PASSWORD '${secrets.databasePassword}';
      CREATE ROLE supabase_admin LOGIN SUPERUSER PASSWORD '${secrets.databasePassword}';
      CREATE ROLE dashboard_user NOLOGIN;
      GRANT anon, authenticated, service_role TO supabase_admin WITH ADMIN OPTION;
      CREATE SCHEMA auth AUTHORIZATION supabase_auth_admin;
      GRANT CREATE ON DATABASE ${database} TO supabase_auth_admin;
      CREATE SCHEMA _realtime AUTHORIZATION supabase_admin;`);
    stage = 'genuine-auth-migrations';
    await supervisor.command('/usr/local/bin/auth', ['migrate'], env.auth);
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
    await supervisor.until(() => realtimeMigrated(db));
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
    await supervisor.start('auth', '/usr/local/bin/auth', ['serve'], env.auth);
    await supervisor.until(() => health('http://127.0.0.1:9999/health'));
    stage = 'real-users-and-financial-seed';
    const api = fixtureAuth({ serviceKey: secrets.serviceKey, jwtSecret: secrets.jwtSecret });
    const users = await api.createUsers();
    const { seedFixture } = await import('./seed-fixture.mjs');
    const fixture = await seedFixture({
      db,
      actorIds: users.slice(0, 2).map((user) => user.id),
      spectatorId: users[2].id,
    });
    const spectator = await api.enrollMfa(users[2]);
    stage = 'private-observation-bridge';
    const { startObservationBridge } = await import('./observation-bridge.mjs');
    const observerDb = new pg.Client({ ...connection, database });
    try {
      await observerDb.connect();
    } catch (error) {
      await observerDb.end().catch(() => {});
      throw error;
    }
    // The bridge owns this private connection from invocation through close,
    // including startup failure. The browser has no PostgreSQL identity.
    bridge = await startObservationBridge({
      db: observerDb,
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
        observation_bridge: { ...bridge.binding, socket: '/run/fixture-observer/observation.sock' },
        table_id: fixture.table_id,
        spectator_user_id: spectator.id,
        storage_state: browserStorage(spectator.session, template.supabase_host),
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
    const { startFixtureActors } = await import('./actors.mjs');
    actors = await startFixtureActors({
      tableId: fixture.table_id,
      users: users.slice(0, 2),
      onFailure: () => supervisor.fail('actors'),
    });
    await supervisor.failed;
    throw new Error('fixture service stopped');
  } catch {
    // Private service logs can include synthetic credentials. Public stderr
    // contains the bounded stage only, never child output or raw SQL/errors.
    process.stderr.write(`FIXTURE_FAILED:${stage}\n`);
    process.exitCode = 1;
  } finally {
    await rm(privateRoot + '/ready.json', { force: true });
    await actors?.close();
    await gateway?.close();
    await bridge?.close();
    await supervisor.close();
    await db?.end().catch(() => {});
    process.removeListener('SIGTERM', stop);
    process.removeListener('SIGINT', stop);
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
