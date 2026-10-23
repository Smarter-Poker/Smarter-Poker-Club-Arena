// Cashier-specific native acceptance. Never a full component/product certificate.
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
import { chromium } from '/opt/qualification/node_modules/playwright/index.mjs';
import { browserStorage } from '/opt/qualification/runtime/auth-fixture.mjs';
import {
  prepareRealtimeCookie,
  realtimeMigrated,
} from '/opt/qualification/runtime/fixture-server.mjs';
import {
  createFixtureGateway,
  loadStaticManifest,
  findPublicAnonKey,
} from '/opt/qualification/runtime/gateway.mjs';

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
let browser;
let observedPages = [];
const resourceFailures = [];
const networkFailures = [];
const safeUiText = (value) =>
  value
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[redacted]')
    .replace(/[A-Za-z0-9_-]{32,}/g, '[opaque]')
    .slice(0, 2500);
const restFailures = [];
function setStage(value) {
  assert.match(value, /^[a-zA-Z0-9_.-]{1,100}$/);
  stage = value;
  console.log(JSON.stringify({ scope: 'cashier-realtime-native-lifecycle', kind: 'stage', stage }));
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function ready(check, budget = 60000) {
  const end = Date.now() + budget;
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
  const log = await open(`/run/cashier/${name}.log`, 'wx', 0o600);
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
  await mkdir('/tmp/fixture/realtime', { recursive: true, mode: 0o700 });
  await prepareRealtimeCookie();
  await mkdir('/run/cashier', { recursive: true, mode: 0o700 });
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
    '-c',
    'wal_level=logical',
    '-c',
    'output_plugin_libraries=pgoutput,wal2json',
    '-c',
    'max_replication_slots=20',
    '-c',
    'max_wal_senders=20',
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
  // Read-only production ACL capture confirms postgres already has both rights.
  // Keep Auth-owned tables native; grant only the application owner's needed boundary.
  await bootstrap.query('GRANT SELECT, REFERENCES ON auth.users TO postgres');
  const db = await connect('postgres');
  assertFixtureAuthMigrations(
    (await db.query('SELECT version FROM auth.schema_migrations')).rows.map((r) => r.version)
  );
  setStage('application-schema');
  for (const [name, sql] of JSON.parse(await readFile('/cashier/chunks.json', 'utf8'))) {
    setStage(`schema-${name}`);
    await db.query(sql);
  }
  setStage('captured-authority-readback');
  const authorities = (
    await Promise.all(
      ['functions', 'helpers'].map((n) => readFile('/cashier/' + n + '.jsonl', 'utf8'))
    )
  ).flatMap((s) => s.trim().split('\n').map(JSON.parse));
  for (const f of authorities) {
    const sig = f.signature.startsWith(f.schema_name + '.')
      ? f.signature
      : f.schema_name + '.' + f.signature;
    const actual = (
      await db.query(
        'SELECT md5(prosrc) AS body_md5,pg_get_userbyid(proowner) AS owner FROM pg_proc WHERE oid=$1::regprocedure',
        [sig]
      )
    ).rows[0];
    assert.deepEqual(actual, { body_md5: f.body_md5, owner: f.owner });
  }
  setStage('genuine-authenticated-users');
  await start('auth', '/usr/local/bin/auth', ['serve'], authEnv);
  await ready(() => healthy('http://127.0.0.1:9999/health'));
  const api = fixtureAuth({ serviceKey: secrets.serviceKey, jwtSecret: secrets.jwtSecret });
  await api.createLedgerAttributionIdentity();
  const [owner, player, outsider] = await api.createUsers();
  const club = randomUUID();
  let seed = await readFile('/cashier/seed.sql', 'utf8');
  for (const [key, id] of Object.entries({ owner: owner.id, player: player.id, club })) {
    assert.match(id, /^[a-f0-9-]{36}$/);
    seed = seed.replaceAll('{{' + key + '}}', id);
  }
  assert.ok(!seed.includes('{{'));
  // Baseline-only replication mode belongs to initdb, never an application caller.
  await bootstrap.query(seed);
  await db.query(
    `UPDATE public.profiles SET onboarding_complete=true,age_verified=true,age_verified_at=now(),over_18_attested_at=now(),club_arena_tos_accepted_at=now(),jurisdiction_country='US',jurisdiction_region='IL',jurisdiction_acknowledged_at=now(),arena_avatar_url='/avatars/table/free_samurai@2x.webp' WHERE id=ANY($1::uuid[])`,
    [[owner.id, player.id]]
  );
  await db.query(
    'CREATE PUBLICATION supabase_realtime FOR TABLE public.cashout_requests,public.club_members,public.agents'
  );
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
  await ready(() =>
    healthy('http://127.0.0.1:3000/clubs?select=id&limit=0', {
      authorization: `Bearer ${secrets.serviceKey}`,
    })
  );
  setStage('realtime-native-services');
  const rt = {
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
    RELEASE_DISTRIBUTION: 'name',
    DNS_NODES: "''",
    RLIMIT_NOFILE: '10000',
  };
  await command('/app/bin/migrate', [], {
    env: { ...process.env, ...rt },
    maxBuffer: 8 * 1024 * 1024,
  });
  await command('/app/bin/realtime', ['eval', 'Realtime.Release.seeds(Realtime.Repo)'], {
    env: { ...process.env, ...rt },
    maxBuffer: 8 * 1024 * 1024,
  });
  await ready(() => realtimeMigrated(bootstrap));
  await start('realtime', '/app/bin/server', [], rt);
  await ready(() =>
    healthy('http://127.0.0.1:4000/api/tenants/realtime-dev/health', {
      authorization: `Bearer ${secrets.anonKey}`,
    })
  );
  setStage('immutable-candidate-client');
  const files = await loadStaticManifest('/cashier/web');
  const published = JSON.parse(files.get('build-info.json').toString());
  const expected = JSON.parse(await readFile('/cashier/expected-client.json', 'utf8'));
  assert.equal(published.ca_sha, expected.ca_sha);
  assert.equal(String(published.run_id), String(expected.run_id));
  const host = 'kuklfnapbkmacvwxktbh.supabase.co';
  const publicKey = findPublicAnonKey([...files.values()], host);
  await command('/usr/bin/openssl', [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-days',
    '1',
    '-subj',
    '/CN=cashier-native-fixture',
    '-addext',
    `subjectAltName=DNS:smarter.poker,DNS:ca-static.smarter.poker,DNS:engine.smarter.poker,DNS:${host}`,
    '-keyout',
    '/run/cashier/tls.key',
    '-out',
    '/run/cashier/tls.crt',
  ]);
  gateway = createFixtureGateway({
    supabaseHost: host,
    publicAnonKey: publicKey,
    localAnonKey: secrets.anonKey,
    files,
    tls: {
      key: await readFile('/run/cashier/tls.key'),
      cert: await readFile('/run/cashier/tls.crt'),
    },
    engineHost: '127.0.0.1',
  });
  await gateway.listen();
  setStage('chromium-launch');
  browser = await chromium.launch({ headless: true });
  const contexts = [];
  setStage('genuine-browser-sessions');
  for (const actor of [owner, player]) {
    const storage = browserStorage(actor.session, host);
    // The real SPA uses the shared Hub SSO key, not the SDK default key.
    storage.origins[0].localStorage.push({
      name: 'smarter-poker-auth',
      value: JSON.stringify(actor.session),
    });
    contexts.push(
      await browser.newContext({
        ignoreHTTPSErrors: true,
        storageState: browserStorage(actor.session, host),
        viewport: { width: 393, height: 852 },
      })
    );
  }
  const [agentPage, playerPage] = await Promise.all(contexts.map((c) => c.newPage()));
  observedPages = [agentPage, playerPage];
  const errors = [];
  function observe(page, topic) {
    const state = { joins: 0, changes: [] };
    page.on('pageerror', (e) => errors.push(e.name));
    page.on('requestfailed', (r) =>
      networkFailures.push({
        path: new URL(r.url()).pathname.replace(/[a-f0-9-]{36}/g, ':id').slice(0, 160),
        code: /\bERR_[A-Z_]+\b/.exec(r.failure()?.errorText || '')?.[0] ?? null,
      })
    );
    page.on('response', async (r) => {
      if (r.status() < 400) return;
      const url = new URL(r.url());
      resourceFailures.push({
        status: r.status(),
        path: url.pathname
          .replace(/[a-f0-9-]{36}/g, ':id')
          .replace(/[^A-Za-z0-9_:/.-]/g, '')
          .slice(0, 160),
      });
      if (!r.url().includes('/rest/v1/')) return;
      const body = await r.json().catch(() => null);
      restFailures.push({
        status: r.status(),
        code: /^(PGRST[0-9]{3}|[A-Z0-9]{5})$/.test(body?.code || '') ? body.code : null,
        route: new URL(r.url()).pathname
          .replace(/^.*\/rest\/v1\//, '')
          .replace(/[^A-Za-z0-9_/]/g, '')
          .slice(0, 100),
      });
    });
    page.on('websocket', (socket) =>
      socket.on('framereceived', (frame) => {
        let m;
        try {
          m = JSON.parse(String(frame.payload));
        } catch {
          return;
        }
        // Only this rendered component's binding can admit its action.
        // A parent queue subscription cannot stand in for the open dialog.
        if (m.topic !== topic) return;
        if (
          m.event === 'phx_reply' &&
          m.payload?.status === 'ok' &&
          m.payload.response?.postgres_changes?.some((c) => c.table === 'cashout_requests')
        )
          state.joins++;
        const record = m.payload?.data?.record;
        if (
          m.event === 'postgres_changes' &&
          m.payload?.data?.table === 'cashout_requests' &&
          record
        )
          state.changes.push({ id: record.id, status: record.status });
      })
    );
    return state;
  }
  const agentEvents = observe(agentPage, `realtime:agent-cashouts-${owner.id}-${club}`),
    playerEvents = observe(playerPage, `realtime:cashout-request-status:${player.id}:${club}`);
  setStage('cashier-route-navigation');
  await Promise.all(
    [agentPage, playerPage].map((p) =>
      p.goto(`https://smarter.poker/hub/club-arena/clubs/${club}/cashier`, {
        waitUntil: 'domcontentloaded',
        timeout: 30000,
      })
    )
  );
  const openRequest = playerPage.getByRole('button', { name: 'Request Cash Out', exact: true });
  setStage('player-request-control');
  await openRequest.waitFor({ state: 'visible', timeout: 45000 });
  const queueButton = agentPage.getByRole('button', { name: /Cash Out Requests/ });
  setStage('agent-queue-control');
  await queueButton.waitFor({ state: 'visible', timeout: 45000 });
  // Open the agent queue before the other browser writes: a refresh cannot stand in for Realtime.
  await queueButton.click();
  await agentPage.getByRole('heading', { name: 'Pending Cashouts', exact: true }).waitFor();
  await ready(() => agentEvents.joins > 0);
  const observations = [];
  async function assertMoney(playerBalance, agentBalance, held, events) {
    const r = (
      await db.query(
        `SELECT (SELECT chip_balance::text FROM club_members WHERE club_id=$1 AND user_id=$2) AS player,(SELECT agent_wallet_balance::text FROM agents WHERE club_id=$1 AND user_id=$3) AS agent,(SELECT coalesce(sum(amount),0)::text FROM chip_escrow WHERE club_id=$1 AND released_at IS NULL) AS held,(SELECT count(*)::int FROM accounting_cashier_events WHERE club_id=$1) AS events,(SELECT count(*)::int FROM chip_ledger WHERE club_id=$1) AS legs,(SELECT bool_and(settlement_locked) FROM clubs WHERE id=$1) AS locked`,
        [club, player.id, owner.id]
      )
    ).rows[0];
    assert.equal(Number(r.player), playerBalance);
    assert.equal(Number(r.agent), agentBalance);
    assert.equal(Number(r.held), held);
    assert.equal(r.events, events);
    assert.equal(r.legs, events);
    assert.equal(r.locked, true);
    assert.equal(Number(r.player) + Number(r.agent) + Number(r.held), 100);
  }
  async function rpc(actor, name, body) {
    const response = await fetch('http://127.0.0.1:3000/rpc/' + name, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${actor.session.access_token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
    });
    return { status: response.status, body: await response.json() };
  }
  for (const [decision, amount, expectedPlayer] of [
    ['approval', '10.25', 89.75],
    ['decline', '12.75', 89.75],
  ]) {
    setStage('browser-' + decision + '-request');
    const requestJoins = playerEvents.joins;
    await openRequest.click();
    await ready(() => playerEvents.joins > requestJoins);
    await playerPage.getByLabel('Amount', { exact: true }).fill(amount);
    const submit = playerPage.getByRole('button', {
      name: 'Check Or Request Cashout',
      exact: true,
    });
    await submit.waitFor();
    const requestWire = playerPage.waitForResponse(
      (r) => r.url().endsWith('/rpc/fn_cashout_request_v2') && r.request().method() === 'POST',
      { timeout: 20000 }
    );
    await submit.click();
    const response = await requestWire;
    assert.equal(response.status(), 200);
    const hold = await response.json();
    assert.equal(hold.success, true);
    assert.equal(hold.event_kind, 'hold');
    const holdBody = response.request().postDataJSON();
    const start = performance.now();
    await ready(
      () => agentEvents.changes.some((r) => r.id === hold.cashout_id && r.status === 'pending'),
      5000
    );
    const approve = agentPage.getByRole('button', { name: 'Approve Cashout', exact: true });
    await approve.waitFor({ state: 'visible', timeout: 5000 });
    assert.ok(performance.now() - start < 5000, 'request status exceeded realtime budget');
    observations.push({
      stage: decision + '.request_cross_browser',
      latency_ms: Math.round(performance.now() - start),
    });
    await assertMoney(
      decision === 'approval' ? 89.75 : 77,
      decision === 'approval' ? 0 : 10.25,
      Number(amount),
      decision === 'approval' ? 1 : 3
    );
    const replay = await rpc(player, 'fn_cashout_request_v2', holdBody);
    assert.equal(replay.status, 200);
    assert.equal(replay.body.replayed, true);
    assert.equal(replay.body.event_id, hold.event_id);
    const wrong = await rpc(outsider, 'fn_cashout_approve_v2', {
      p_club_id: club,
      p_cashout_id: hold.cashout_id,
      p_amount: amount,
      p_expected_actor_id: outsider.id,
      p_op_id: randomUUID(),
      p_note: null,
    });
    assert.ok(wrong.status === 401 || wrong.status === 403);
    // The success sheet closes on its own; reopen the same real player modal
    // before the independent agent decides, so its update must arrive over Realtime.
    await playerPage.getByRole('dialog').waitFor({ state: 'hidden', timeout: 5000 });
    const priorJoins = playerEvents.joins;
    await openRequest.click();
    await ready(() => playerEvents.joins > priorJoins);
    await playerPage
      .getByRole('button', { name: 'Cancel', exact: true })
      .waitFor({ state: 'visible', timeout: 5000 });
    await playerPage.getByLabel('Amount', { exact: true }).fill('80');
    await playerPage.getByLabel('Note (Optional)', { exact: true }).fill('Keep the decision draft');
    setStage('browser-' + decision + '-decision');
    const rpcName = decision === 'approval' ? 'fn_cashout_approve_v2' : 'fn_cashout_release_v2';
    const decisionWire = agentPage.waitForResponse(
      (r) => r.url().endsWith('/rpc/' + rpcName) && r.request().method() === 'POST',
      { timeout: 20000 }
    );
    await agentPage
      .getByRole('button', {
        name: decision === 'approval' ? 'Approve Cashout' : 'Reject',
        exact: true,
      })
      .click();
    const decided = await decisionWire;
    assert.equal(decided.status(), 200);
    const receipt = await decided.json();
    assert.equal(receipt.success, true);
    assert.equal(receipt.event_kind, decision);
    const changed = performance.now();
    await ready(
      () =>
        playerEvents.changes.some(
          (r) =>
            r.id === hold.cashout_id &&
            r.status === (decision === 'approval' ? 'approved' : 'rejected')
        ),
      5000
    );
    await agentPage
      .getByText('No Pending Cashout Requests', { exact: true })
      .waitFor({ timeout: 5000 });
    // The player's open modal must remove the pending row from the other browser's decision.
    await playerPage
      .getByRole('button', { name: 'Cancel', exact: true })
      .waitFor({ state: 'hidden', timeout: 5000 });
    assert.ok(performance.now() - changed < 5000, 'decision status exceeded realtime budget');
    observations.push({
      stage: decision + '.decision_cross_browser',
      latency_ms: Math.round(performance.now() - changed),
    });
    await ready(
      async () =>
        (await playerPage.locator('#cashier-cashout-balance').textContent())?.includes(
          expectedPlayer.toFixed(2)
        ),
      Math.max(1, 5000 - (performance.now() - changed))
    );
    assert.ok(performance.now() - changed < 5000, 'returned balance exceeded realtime budget');
    assert.equal(await playerPage.getByLabel('Amount', { exact: true }).inputValue(), '80');
    assert.equal(
      await playerPage.getByLabel('Note (Optional)', { exact: true }).inputValue(),
      'Keep the decision draft'
    );
    await ready(
      async () =>
        await playerPage
          .getByRole('button', { name: 'Check Or Request Cashout', exact: true })
          .isEnabled(),
      5000
    );
    observations.push({
      stage: decision + '.balance_cross_browser',
      latency_ms: Math.round(performance.now() - changed),
    });
    await assertMoney(expectedPlayer, 10.25, 0, decision === 'approval' ? 2 : 4);
    const again = await rpc(owner, rpcName, decided.request().postDataJSON());
    assert.equal(again.status, 200);
    assert.equal(again.body.replayed, true);
    assert.equal(again.body.event_id, receipt.event_id);
    await assertMoney(expectedPlayer, 10.25, 0, decision === 'approval' ? 2 : 4);
    const close = playerPage.getByRole('button', { name: 'Close Cashout Request', exact: true });
    if (await close.isVisible()) await close.click();
  }
  assert.deepEqual(errors, [], 'published cashier raised a browser runtime error');
  assert.equal(
    (
      await db.query(
        'SELECT is_active AND unlock_at>now() AS locked FROM settlement_locks WHERE club_id=$1',
        [club]
      )
    ).rows[0].locked,
    true
  );
  console.log(
    JSON.stringify({
      scope: 'cashier-realtime-native-lifecycle',
      status: 'passed',
      product_certificate: false,
      candidate_client_sha: published.ca_sha,
      source_boundary: 'candidate-components-genuine-auth-rest-postgres-realtime',
      settlement_locked_throughout: true,
      request_approval_rejection: true,
      duplicate_replay: true,
      unauthorized_refused: true,
      conserved_opening_chips: 100,
      observations,
    })
  );
} catch (error) {
  console.error(
    JSON.stringify({
      scope: 'cashier-realtime-native-lifecycle',
      status: 'failed',
      product_certificate: false,
      stage,
      rest_failures: restFailures.slice(-20),
      resources: [...resourceFailures.slice(0, 15), ...resourceFailures.slice(-15)],
      network_failures: networkFailures.slice(0, 20),
      ui_states: await Promise.all(
        observedPages.map(async (p) => {
          try {
            return safeUiText(
              (await p.locator('h1,h2,[role=alert],[role=status]').allTextContents()).join(' | ')
            );
          } catch {
            return 'unavailable';
          }
        })
      ),
      page_paths: observedPages.map((p) => {
        try {
          return new URL(p.url()).pathname
            .replace(/[a-f0-9-]{36}/g, ':id')
            .replace(/[^A-Za-z0-9_:/.-]/g, '')
            .slice(0, 160);
        } catch {
          return 'unavailable';
        }
      }),
      error_name: ['Error', 'TimeoutError', 'TypeError', 'AssertionError'].includes(error.name)
        ? error.name
        : 'Error',
      network_code: /\bERR_[A-Z_]+\b/.exec(String(error.message))?.[0] ?? null,
      error_code: /^[A-Z0-9_]{3,50}$/.test(error.code || '')
        ? error.code
        : 'ASSERTION_OR_RUNTIME_FAILURE',
    })
  );
  process.exitCode = 1;
} finally {
  if (browser)
    await browser.close().catch(() => {
      process.exitCode = 1;
    });
  if (gateway)
    await gateway.close().catch(() => {
      process.exitCode = 1;
    });
  for (const c of connections.reverse())
    await c.end().catch(() => {
      process.exitCode = 1;
    });
  for (const c of children.reverse()) if (c.exitCode === null) c.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 500));
  for (const c of children) if (c.exitCode === null) c.kill('SIGKILL');
}
