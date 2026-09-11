// Real binaries and protocols in one disposable, network=none Linux container.
// This deliberately does not emit a product semantic certificate.
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile, readFile, access, open, readdir } from 'node:fs/promises';
import pg from 'pg';
import { chromium } from '@playwright/test';
import { fixtureSecrets, fixtureAuth } from './auth-fixture.mjs';

const exec = promisify(execFile);
const root = '/run/native-smoke';
const pgBin = '/usr/lib/postgresql/17/bin';
const database = 'club_arena_qualification';
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let stage = 'initialization';
const children = [];

async function eventually(check, milliseconds = 60000) {
  const deadline = Date.now() + milliseconds;
  for (;;) {
    assert.ok(
      children.every(
        (child) => !child.nativeFailed && child.exitCode === null && child.signalCode === null
      ),
      'a native service exited'
    );
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
        signal: AbortSignal.timeout(1000),
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
    stdio: ['ignore', log.fd, log.fd],
  });
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
    timeout: 90000,
    maxBuffer: 8 * 1024 * 1024,
  });
}

async function oracle() {
  stage = 'observer-user-isolation';
  assert.equal(process.getuid(), 1001);
  await mkdir('/tmp/qualification', { recursive: true, mode: 0o700 });
  await assert.rejects(readFile(`${root}/private/service.json`), {
    code: 'EACCES',
  });
  await assert.rejects(readFile('/app/releases/COOKIE'), { code: 'EACCES' });
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
  const reader = new pg.Client({
    host: '/run/postgresql',
    database,
    user: 'qualification_reader',
  });
  await reader.connect();
  try {
    await reader.query('SET row_security=off');
    const roles = await reader.query(
      'SELECT current_user, rolsuper, rolcreaterole FROM pg_roles WHERE rolname=current_user'
    );
    assert.equal(roles.rows[0].current_user, 'qualification_reader');
    assert.equal(roles.rows[0].rolsuper, false);
    assert.equal(roles.rows[0].rolcreaterole, false);
    assert.equal(
      (await reader.query('SELECT count(*)::int AS n FROM public.fixture_smoke')).rows[0].n,
      2
    );
    await assert.rejects(reader.query('DELETE FROM public.fixture_smoke'), {
      code: '42501',
    });
    await assert.rejects(reader.query('SET ROLE postgres'), { code: '42501' });
  } finally {
    await reader.end();
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
      browser: 'chromium',
      retries: 0,
    })
  );
}

async function services() {
  assert.equal(process.getuid(), 1000);
  assert.equal(process.version, 'v22.23.2');
  await mkdir(root, { recursive: true, mode: 0o755 });
  await mkdir(`${root}/private`, { mode: 0o700 });
  await mkdir('/tmp/fixture/realtime', { recursive: true, mode: 0o700 });
  await mkdir('/run/postgresql', { mode: 0o755 });
  const secrets = { ...fixtureSecrets(), realtimeCookie: randomBytes(48).toString('hex') };
  await writeFile(`${root}/private/service.json`, JSON.stringify(secrets), {
    mode: 0o600,
  });
  const password = secrets.databasePassword;
  assert.match(password, /^[a-f0-9]{64}$/);
  const data = '/var/lib/postgresql/data';
  stage = 'postgresql-17-extensions';
  const version = await command(`${pgBin}/postgres`, ['--version']);
  assert.match(version.stdout, /PostgreSQL\) 17\.11\b/);
  const restVersion = await command('/usr/local/bin/postgrest', ['--version']);
  assert.match(restVersion.stdout, /\b14\.5\b/);
  const authVersion = await command('/usr/local/bin/auth', ['version']);
  assert.match(authVersion.stdout + authVersion.stderr, /\b2\.196\.0\b/);
  await command(`${pgBin}/initdb`, [
    '-D',
    data,
    '-U',
    'postgres',
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
    'fixture_users fixture postgres\nfixture_users qualification qualification_reader\n'
  );
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
    'max_replication_slots=20',
    '-c',
    'max_wal_senders=20',
    '-c',
    'shared_preload_libraries=pg_stat_statements',
  ]);
  await eventually(async () => {
    try {
      await command(`${pgBin}/pg_isready`, ['-h', '/run/postgresql', '-U', 'postgres']);
      return true;
    } catch {
      return false;
    }
  });
  const admin = new pg.Client({
    host: '/run/postgresql',
    user: 'postgres',
    database: 'postgres',
  });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${database}`);
  await admin.query('REVOKE CONNECT ON DATABASE postgres, template1 FROM PUBLIC');
  await admin.end();
  const db = new pg.Client({
    host: '/run/postgresql',
    user: 'postgres',
    database,
  });
  await db.connect();
  try {
    stage = 'postgresql-wal2json-native-slot';
    // Load the real output plugin through PostgreSQL. Its presence on disk
    // alone does not prove Realtime can create its required logical slot.
    const slot = await db.query(
      "SELECT slot_name FROM pg_create_logical_replication_slot('fixture_wal2json_probe','wal2json',true)"
    );
    assert.equal(slot.rows[0]?.slot_name, 'fixture_wal2json_probe');
    const installed = await db.query(
      "SELECT plugin,temporary FROM pg_replication_slots WHERE slot_name='fixture_wal2json_probe'"
    );
    assert.deepEqual(installed.rows, [{ plugin: 'wal2json', temporary: true }]);
    await db.query("SELECT pg_drop_replication_slot('fixture_wal2json_probe')");
    await db.query(`
      CREATE ROLE dashboard_user NOLOGIN;
      CREATE ROLE anon NOLOGIN;
      CREATE ROLE authenticated NOLOGIN;
      CREATE ROLE service_role NOLOGIN BYPASSRLS;
      CREATE ROLE authenticator LOGIN NOINHERIT PASSWORD '${password}';
      GRANT anon, authenticated, service_role TO authenticator;
      CREATE ROLE supabase_auth_admin LOGIN CREATEROLE PASSWORD '${password}';
      CREATE ROLE supabase_admin LOGIN SUPERUSER PASSWORD '${password}';
      GRANT anon, authenticated, service_role TO supabase_admin WITH ADMIN OPTION;
      CREATE ROLE qualification_reader LOGIN NOINHERIT BYPASSRLS;
      CREATE SCHEMA auth AUTHORIZATION supabase_auth_admin;
      GRANT CREATE ON DATABASE ${database} TO supabase_auth_admin;
      CREATE SCHEMA extensions;
      CREATE SCHEMA _realtime AUTHORIZATION supabase_admin;
      CREATE EXTENSION dblink;
      CREATE EXTENSION pg_stat_statements WITH SCHEMA extensions;
      CREATE EXTENSION pg_trgm;
      CREATE EXTENSION pgcrypto WITH SCHEMA extensions;
      CREATE EXTENSION "uuid-ossp" WITH SCHEMA extensions;
      CREATE EXTENSION vector WITH SCHEMA extensions;
    `);
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
    await command('/usr/local/bin/auth', ['migrate'], authEnv);
    assert.ok(
      (await db.query('SELECT count(*)::int AS n FROM auth.schema_migrations')).rows[0].n > 0
    );
    const auth = await start('auth', '/usr/local/bin/auth', ['serve'], authEnv);
    await eventually(() => healthy('http://127.0.0.1:9999/health'));
    const api = fixtureAuth({
      serviceKey: secrets.serviceKey,
      jwtSecret: secrets.jwtSecret,
    });
    const users = await api.createUsers();
    const user = await api.enrollMfa(users[0]);
    assert.equal(
      (await db.query("SELECT count(*)::int AS n FROM auth.mfa_factors WHERE status='verified'"))
        .rows[0].n,
      1
    );

    stage = 'postgrest-14-5-authentication-and-rls';
    // Small native protocol fixture only; the full schema artifact is qualified separately.
    await db.query(`
      CREATE TABLE public.fixture_smoke (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, owner_id uuid NOT NULL REFERENCES auth.users(id), payload text NOT NULL);
      ALTER TABLE public.fixture_smoke ENABLE ROW LEVEL SECURITY;
      CREATE POLICY own_rows ON public.fixture_smoke FOR SELECT TO authenticated USING (owner_id::text = current_setting('request.jwt.claims',true)::json->>'sub');
      GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role, qualification_reader;
      GRANT SELECT ON public.fixture_smoke TO anon, authenticated, service_role, qualification_reader;
      GRANT CONNECT ON DATABASE ${database} TO qualification_reader;
      CREATE PUBLICATION supabase_realtime FOR TABLE public.fixture_smoke;
    `);
    await db.query('INSERT INTO public.fixture_smoke(owner_id,payload) VALUES($1,$2)', [
      users[1].id,
      'hidden-other-user',
    ]);
    await start('postgrest', '/usr/local/bin/postgrest', [], {
      PGRST_DB_URI: `postgres://authenticator:${password}@127.0.0.1:5432/${database}`,
      PGRST_DB_SCHEMAS: 'public',
      PGRST_DB_ANON_ROLE: 'anon',
      PGRST_JWT_SECRET: secrets.jwtSecret,
      PGRST_SERVER_HOST: '127.0.0.1',
      PGRST_SERVER_PORT: '3000',
      PGRST_LOG_LEVEL: 'error',
    });
    await eventually(() => healthy('http://127.0.0.1:3000/'));
    const anonymous = await fetch('http://127.0.0.1:3000/fixture_smoke');
    assert.equal(anonymous.status, 200);
    assert.deepEqual(await anonymous.json(), []);
    assert.equal(
      (
        await fetch('http://127.0.0.1:3000/fixture_smoke', {
          headers: { authorization: 'Bearer invalid-fixture-token' },
        })
      ).status,
      401
    );
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
      RELEASE_COOKIE: secrets.realtimeCookie,
      RELEASE_DISTRIBUTION: 'none',
      DNS_NODES: "''",
      RLIMIT_NOFILE: '10000',
    };
    await command('/app/bin/migrate', [], realtimeEnv);
    await command(
      '/app/bin/realtime',
      ['eval', 'Realtime.Release.seeds(Realtime.Repo)'],
      realtimeEnv
    );
    assert.equal(
      (
        await db.query(
          "SELECT count(*)::int AS n FROM _realtime.tenants WHERE external_id='realtime-dev'"
        )
      ).rows[0].n,
      1
    );
    await start('realtime', '/app/bin/server', [], realtimeEnv);
    await eventually(() =>
      healthy('http://127.0.0.1:4000/api/tenants/realtime-dev/health', {
        authorization: `Bearer ${secrets.anonKey}`,
      })
    );
    const socket = new WebSocket(
      `ws://realtime-dev.supabase-realtime:4000/socket/websocket?apikey=${encodeURIComponent(secrets.anonKey)}&vsn=1.0.0`
    );
    const messages = [];
    let socketError = false;
    socket.addEventListener('error', () => {
      socketError = true;
    });
    socket.addEventListener('message', (event) => {
      try {
        messages.push(JSON.parse(event.data));
      } catch {
        socketError = true;
      }
    });
    try {
      await eventually(async () => {
        assert.equal(socketError, false);
        return socket.readyState === WebSocket.OPEN;
      }, 15000);
      socket.send(
        JSON.stringify({
          topic: 'realtime:native-smoke',
          event: 'phx_join',
          ref: '1',
          payload: {
            config: {
              broadcast: { ack: false, self: false },
              presence: { key: '' },
              postgres_changes: [{ event: 'INSERT', schema: 'public', table: 'fixture_smoke' }],
              private: false,
            },
            access_token: user.session.access_token,
          },
        })
      );
      await eventually(async () => {
        assert.equal(socketError, false);
        return messages.some(
          (m) =>
            m.event === 'system' &&
            m.payload?.extension === 'postgres_changes' &&
            m.payload?.status === 'ok'
        );
      });
      assert.ok(
        messages.some((m) => m.event === 'phx_reply' && m.ref === '1' && m.payload?.status === 'ok')
      );
      const inserted = await db.query(
        'INSERT INTO public.fixture_smoke(owner_id,payload) VALUES($1,$2) RETURNING id',
        [user.id, 'native-realtime-change']
      );
      await eventually(async () =>
        messages.some(
          (m) =>
            m.event === 'postgres_changes' &&
            m.payload?.data?.record?.payload === 'native-realtime-change'
        )
      );
      const changed = messages.find(
        (m) =>
          m.event === 'postgres_changes' &&
          m.payload?.data?.record?.payload === 'native-realtime-change'
      );
      assert.equal(String(changed.payload.data.record.id), inserted.rows[0].id);
      assert.equal(changed.payload.data.record.owner_id, user.id);
    } finally {
      socket.close();
    }
    stage = 'observer-and-browser-handoff';
    await writeFile(
      `${root}/oracle.json`,
      JSON.stringify({
        auth_pid: auth.pid,
        private_arg_hashes: Object.entries(secrets)
          .filter(([key]) => key !== 'anonKey')
          .map(([, value]) => createHash('sha256').update(value).digest('hex')),
        user_id: user.id,
        access_token: user.session.access_token,
      }),
      { mode: 0o644 }
    );
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
    console.log(
      JSON.stringify({
        scope: 'native-service-smoke',
        postgres: '17.11',
        extensions: 6,
        auth: '2.196.0',
        mfa: 'aal2',
        postgrest: '14.5',
        realtime: '2.134.10',
        change: 'observed',
        retries: 0,
      })
    );
  } finally {
    await db.end();
  }
}

let timer;
try {
  timer = setTimeout(() => {
    console.error(JSON.stringify({ status: 'failed', stage, reason: 'deadline' }));
    process.exit(1);
  }, 300000);
  if (process.argv.length === 3 && process.argv[2] === '--oracle') await oracle();
  else {
    assert.equal(process.argv.length, 2);
    await services();
  }
} catch (error) {
  // Keep raw service output, SQL, JWTs, session objects, and URLs out of CI logs.
  console.error(JSON.stringify({ status: 'failed', stage, error: error.name }));
  process.exitCode = 1;
} finally {
  clearTimeout(timer);
  for (const child of children.toReversed()) if (child.exitCode === null) child.kill('SIGTERM');
  await pause(500);
  for (const child of children) if (child.exitCode === null) child.kill('SIGKILL');
}
