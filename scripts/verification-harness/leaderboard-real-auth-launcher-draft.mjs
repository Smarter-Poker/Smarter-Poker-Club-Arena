// UNQUALIFIED DRAFT: finite local-only launch AFTER faithful catalog restoration.
// Input: {container,scratch,sourceCatalog,authVersions}. No credentials accepted.
// Root one-shot owner destroys database/network after this helper returns.
import assert from 'node:assert/strict';
import { delegationFixture } from './leaderboard-delegated-role-matrix.mjs';
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  readFileSync,
  writeFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  existsSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const authImage =
  'supabase/gotrue@sha256:1736a63078f5922b198c4cbe50f80ab9a2d3b54fe8b7b6cfb2e9dc5dbbc12c6b';
const restImage =
  'postgrest/postgrest@sha256:b574528fe109c8343c1247155734d03df8c34b462f342dca0ccc20244fc36ef9';
const nodeImage = 'node@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402';
const phases = new Set([
  'input',
  'runtime-admission',
  'fresh-data',
  'catalog-before',
  'auth-ledger',
  'original-roles',
  'synthetic-passwords',
  'private-environment',
  'local-hba',
  'database-restart',
  'catalog-after-restart',
  'service-create',
  'image-migrations',
  'binary-version',
  'service-start',
  'service-health',
  'catalog-after-start',
  'signup',
  'signup-fixture',
  'delegation-join',
  'financial-before',
  'issued-token-expiry',
  'authorization-matrix',
  'overseer-appoint',
  'overseer-admitted',
  'overseer-revoke',
  'overseer-refused',
  'final-readback',
]);
let phase = 'input',
  failureKind = 'assertion-or-input';
export function authFailureDiagnostic(stage, kind) {
  const safeStage = phases.has(stage) ? stage : 'unknown';
  const safeKind = ['docker-timeout', 'docker-exit', 'assertion-or-input'].includes(kind)
    ? kind
    : 'unknown';
  return `Isolated Auth Failure: phase=${safeStage}; kind=${safeKind}`;
}
export function authCommandFailure(result) {
  if (result.error?.code === 'ETIMEDOUT') return 'docker-timeout';
  if (result.error || result.status !== 0) return 'docker-exit';
  return null;
}
function stage(name) {
  assert.ok(phases.has(name));
  phase = name;
  console.log(`Isolated Auth Stage: ${name}`);
}
const owned = new Set();
const ownedSecrets = new Set();
function reserve(name) {
  assert.equal(
    command(['container', 'ls', '-a', '--filter', `name=^/${name}$`, '--format', '{{.Names}}']),
    ''
  );
  owned.add(name);
}
function command(args, input = '', timeout = 90000) {
  const result = spawnSync('docker', args, {
    input,
    encoding: 'utf8',
    timeout,
    maxBuffer: 8 * 1024 * 1024,
    env: process.env,
  });
  const failed = authCommandFailure(result);
  if (failed) failureKind = failed;
  assert.equal(failed, null, 'Isolated Docker stage failed');
  return result.stdout.trim();
}
let cfg;
function sql(text) {
  return command(
    [
      'exec',
      '-i',
      cfg.container,
      'psql',
      '-h',
      '/tmp',
      '-XAtq',
      '-U',
      'leaderboard_qualification_bootstrap',
      '-d',
      'postgres',
      '-v',
      'ON_ERROR_STOP=1',
    ],
    text
  );
}
function catalog() {
  return sql(readFileSync(join(here, 'leaderboard-isolation-catalog.sql'), 'utf8'));
}
function versions() {
  return JSON.parse(sql('SELECT jsonb_agg(version ORDER BY version) FROM auth.schema_migrations;'));
}
function driver(source, input) {
  const name = `${cfg.container}-http-${randomBytes(5).toString('hex')}`;
  reserve(name);
  const out = command(
    [
      'run',
      '--name',
      name,
      '--rm',
      '-i',
      '--network',
      `${cfg.container}-network`,
      '--read-only',
      '--tmpfs',
      '/tmp',
      '-v',
      `${here}:/harness:ro`,
      '--entrypoint',
      'node',
      nodeImage,
      source,
    ],
    JSON.stringify(input),
    240000
  );
  owned.delete(name);
  return out;
}
function inline(source, input) {
  const name = `${cfg.container}-http-${randomBytes(5).toString('hex')}`;
  reserve(name);
  const out = command(
    [
      'run',
      '--name',
      name,
      '--rm',
      '-i',
      '--network',
      `${cfg.container}-network`,
      '--read-only',
      '--tmpfs',
      '/tmp',
      '--entrypoint',
      'node',
      nodeImage,
      '--input-type=module',
      '-e',
      source,
    ],
    JSON.stringify(input),
    240000
  );
  owned.delete(name);
  return out;
}
async function main() {
  for (const key of ['DATABASE_URL', 'PGDATABASE', 'PGHOST', 'PGUSER', 'PGPASSWORD'])
    assert.ok(!process.env[key], 'Source connection environment must be unset');
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  cfg = JSON.parse(input);
  assert.deepEqual(Object.keys(cfg).sort(), [
    'authVersions',
    'container',
    'scratch',
    'sourceCatalog',
  ]);
  assert.match(cfg.container, /^leaderboard-isolation-[A-Za-z0-9_-]+$/);
  cfg.scratch = resolve(cfg.scratch);
  assert.ok(statSync(cfg.scratch).isDirectory() && (statSync(cfg.scratch).mode & 0o077) === 0);
  assert.equal(cfg.authVersions.length, 82);
  assert.equal(
    createHash('md5').update(cfg.authVersions.join(',')).digest('hex'),
    'a39a6625824a961c445673001a211a1d'
  );
  assert.ok(cfg.authVersions.every((v) => /^(00|[0-9]{14})$/.test(v)));
  stage('runtime-admission');
  const db = JSON.parse(command(['inspect', cfg.container]))[0];
  assert.equal(db.Config.Image, 'supabase/postgres:17.6.1.063');
  assert.equal(Object.keys(db.NetworkSettings.Networks).length, 1);
  assert.equal(db.HostConfig.NetworkMode, `${cfg.container}-network`);
  assert.deepEqual(db.HostConfig.PortBindings ?? {}, {});
  const network = JSON.parse(command(['network', 'inspect', `${cfg.container}-network`]))[0];
  assert.equal(network.Internal, true);
  const subnet = network.IPAM.Config[0].Subnet;
  assert.match(subnet, /^(10\.|172\.(1[6-9]|2[0-9]|3[01])\.|192\.168\.)[0-9./]+$/);
  stage('fresh-data');
  sql(
    "DO $$ BEGIN IF session_user<>'leaderboard_qualification_bootstrap' OR current_user<>session_user OR inet_server_addr() IS NOT NULL THEN RAISE EXCEPTION 'Isolated socket required'; END IF; IF EXISTS(SELECT 1 FROM auth.users) OR EXISTS(SELECT 1 FROM public.clubs) OR EXISTS(SELECT 1 FROM auth.schema_migrations) THEN RAISE EXCEPTION 'Fresh empty restored data required'; END IF; END $$;"
  );
  stage('catalog-before');
  const expected = readFileSync(cfg.sourceCatalog, 'utf8').trim();
  assert.equal(catalog(), expected);
  stage('auth-ledger');
  sql(
    `INSERT INTO auth.schema_migrations(version) VALUES ${cfg.authVersions.map((v) => `('${v}')`).join(',')};`
  );
  assert.deepEqual(versions(), cfg.authVersions);
  const secret = randomBytes(48).toString('base64url');
  const authPassword = randomBytes(32).toString('base64url');
  const restPassword = randomBytes(32).toString('base64url');
  stage('original-roles');
  sql(
    "DO $$ BEGIN IF (SELECT count(*) FROM pg_roles WHERE rolname IN('supabase_auth_admin','authenticator') AND rolcanlogin)<>2 THEN RAISE EXCEPTION 'Original login roles unavailable'; END IF; END $$;"
  );
  // Passwords are newly synthetic; role attributes/memberships/grants unchanged.
  stage('synthetic-passwords');
  sql(
    `SET password_encryption='scram-sha-256'; ALTER ROLE supabase_auth_admin PASSWORD '${authPassword}'; ALTER ROLE authenticator PASSWORD '${restPassword}';`
  );
  stage('private-environment');
  const authEnv = join(cfg.scratch, 'real-auth.env'),
    restEnv = join(cfg.scratch, 'real-rest.env');
  writeFileSync(
    authEnv,
    [
      'GOTRUE_API_HOST=0.0.0.0',
      'GOTRUE_API_PORT=9999',
      'GOTRUE_DB_DRIVER=postgres',
      `GOTRUE_DB_DATABASE_URL=postgres://supabase_auth_admin:${authPassword}@${cfg.container}:5432/postgres?sslmode=disable`,
      'GOTRUE_DB_NAMESPACE=auth',
      'API_EXTERNAL_URL=http://leaderboard-auth:9999',
      'GOTRUE_SITE_URL=http://leaderboard-auth:9999',
      'GOTRUE_DISABLE_SIGNUP=false',
      'GOTRUE_EXTERNAL_EMAIL_ENABLED=true',
      'GOTRUE_EXTERNAL_PHONE_ENABLED=false',
      'GOTRUE_MAILER_AUTOCONFIRM=true',
      'GOTRUE_JWT_ADMIN_ROLES=service_role',
      'GOTRUE_JWT_AUD=authenticated',
      'GOTRUE_JWT_DEFAULT_GROUP_NAME=authenticated',
      'GOTRUE_JWT_EXP=60',
      `GOTRUE_JWT_SECRET=${secret}`,
      'GOTRUE_LOG_LEVEL=error',
    ].join('\n') + '\n',
    { mode: 0o600, flag: 'wx' }
  );
  ownedSecrets.add(authEnv);
  writeFileSync(
    restEnv,
    [
      `PGRST_DB_URI=postgres://authenticator:${restPassword}@${cfg.container}:5432/postgres?sslmode=disable`,
      'PGRST_DB_SCHEMAS=public',
      'PGRST_DB_ANON_ROLE=anon',
      `PGRST_JWT_SECRET=${secret}`,
      'PGRST_DB_USE_LEGACY_GUCS=false',
      'PGRST_SERVER_HOST=0.0.0.0',
      'PGRST_SERVER_PORT=3000',
      'PGRST_LOG_LEVEL=error',
    ].join('\n') + '\n',
    { mode: 0o600, flag: 'wx' }
  );
  ownedSecrets.add(restEnv);
  // Local-only HBA is narrowed to these unchanged original roles and subnet.
  stage('local-hba');
  command(
    [
      'exec',
      '-i',
      cfg.container,
      'sh',
      '-c',
      'cat >> /tmp/leaderboard-qualification-db/pg_hba.conf',
    ],
    `\nhost postgres supabase_auth_admin ${subnet} scram-sha-256\nhost postgres authenticator ${subnet} scram-sha-256\n`
  );
  stage('database-restart');
  command([
    'exec',
    cfg.container,
    'pg_ctl',
    // Restart must redirect postgres descendants; otherwise captured pipes stay open.
    '-l',
    '/tmp/postgres.log',
    '-D',
    '/tmp/leaderboard-qualification-db',
    '-o',
    "-c listen_addresses='*' -c unix_socket_directories=/tmp -c shared_preload_libraries=pg_cron,pg_stat_statements,pg_net -c cron.database_name=postgres -c cron.launch_active_jobs=off",
    '-w',
    'restart',
  ]);
  stage('catalog-after-restart');
  assert.equal(catalog(), expected);
  const authName = `${cfg.container}-auth`,
    restName = `${cfg.container}-rest`;
  stage('service-create');
  for (const [name, alias, image, env, entry, args] of [
    [authName, 'leaderboard-auth', authImage, authEnv, '/usr/local/bin/auth', ['serve']],
    [restName, 'leaderboard-rest', restImage, restEnv, '/bin/postgrest', []],
  ]) {
    reserve(name);
    command([
      'create',
      '--name',
      name,
      '--network',
      `${cfg.container}-network`,
      '--network-alias',
      alias,
      '--read-only',
      '--tmpfs',
      '/tmp',
      '--env-file',
      env,
      '--entrypoint',
      entry,
      image,
      ...args,
    ]);
  }
  stage('image-migrations');
  const migrationDir = join(cfg.scratch, 'real-auth-image-migrations');
  assert.ok(!existsSync(migrationDir));
  command(['cp', `${authName}:/usr/local/etc/auth/migrations`, migrationDir]);
  const imageMigrationVersions = [
    ...new Set(
      readdirSync(migrationDir)
        .filter((n) => n.endsWith('.up.sql'))
        .map((n) => n.split('_')[0])
    ),
  ].sort();
  assert.equal(imageMigrationVersions.length, 75);
  assert.ok(imageMigrationVersions.every((v) => cfg.authVersions.includes(v)));
  // Explicit metadata command has no DB configuration or network; bare Auth
  // startup is never used. Require the actual pinned binary's reported version.
  stage('binary-version');
  const versionName = `${cfg.container}-auth-version`;
  reserve(versionName);
  const binaryVersion = command([
    'run',
    '--name',
    versionName,
    '--rm',
    '--network',
    'none',
    '--read-only',
    '--entrypoint',
    '/usr/local/bin/auth',
    authImage,
    'version',
  ]);
  assert.match(binaryVersion, /(^|\s)v?2\.197\.0(\s|$)/);
  owned.delete(versionName);
  stage('service-start');
  command(['start', authName, restName]);
  stage('service-health');
  inline(
    "for(let i=0;i<50;i++){try{let a=await fetch('http://leaderboard-auth:9999/health',{signal:AbortSignal.timeout(1000)}),b=await fetch('http://leaderboard-rest:3000/',{signal:AbortSignal.timeout(1000)});if(a.ok&&b.ok)process.exit(0);}catch{}await new Promise(r=>setTimeout(r,100));}process.exit(1);",
    {}
  );
  stage('catalog-after-start');
  assert.equal(catalog(), expected);
  assert.deepEqual(versions(), cfg.authVersions);
  const accounts = Array.from({ length: 5 }, (_, i) => ({
    email: `lb-real-auth-${i + 1}@example.invalid`,
    password: randomBytes(32).toString('base64url'),
  }));
  const preflight = {
    catalogEquivalent: true,
    noProductionData: true,
    internalNetwork: true,
    authCatalogUnchangedAfterStartup: true,
    authServeOnlyVerified: true,
    authVersionsFingerprint: 'a39a6625824a961c445673001a211a1d',
    authVersions: cfg.authVersions,
    candidateAuthVersions: versions(),
    imageMigrationVersions,
    authImage,
    restImage,
  };
  const transport = '/harness/leaderboard-real-auth-draft.mjs';
  const base = { kind: 'synthetic-leaderboard-real-auth-v1', accounts, preflight };
  stage('signup');
  const signup = JSON.parse(driver(transport, { ...base, mode: 'signup' }));
  stage('signup-fixture');
  const generated = spawnSync(
    process.execPath,
    [join(here, 'leaderboard-signup-fixture-draft.mjs')],
    { input: JSON.stringify(signup), encoding: 'utf8', timeout: 15000 }
  );
  assert.equal(generated.status, 0);
  sql(generated.stdout);
  stage('delegation-join');
  sql(delegationFixture('join', signup.ids));
  const financialQuery =
    "SELECT md5(jsonb_build_object('ledger',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM public.chip_ledger t),'issuance',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM public.ca_mint_ledger t),'chips',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM public.chip_transactions t),'wallet_history',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM public.wallet_transactions t),'clubs',(SELECT jsonb_agg(jsonb_build_object('id',id,'treasury',chip_treasury,'promo',promo_balance) ORDER BY id) FROM public.clubs),'members',(SELECT jsonb_agg(jsonb_build_object('club',club_id,'user',user_id,'chips',chip_balance,'promo',promo_balance) ORDER BY club_id,user_id) FROM public.club_members),'union_wallets',(SELECT jsonb_agg(to_jsonb(t) ORDER BY union_id) FROM public.union_wallets t))::text);";
  stage('financial-before');
  const financialBefore = sql(financialQuery);
  stage('issued-token-expiry');
  const expiry = inline(
    "let s='';for await(const c of process.stdin)s+=c;let a=JSON.parse(s),r=await fetch('http://leaderboard-auth:9999/token?grant_type=password',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(a),signal:AbortSignal.timeout(15000)});if(!r.ok)process.exit(1);let j=await r.json(),t=j.access_token,c=JSON.parse(Buffer.from(t.split('.')[1],'base64url'));let wait=(c.exp+61)*1000-Date.now();if(wait<0||wait>130000)process.exit(1);await new Promise(r=>setTimeout(r,wait));console.log(JSON.stringify({token:t}));",
    accounts[0]
  );
  stage('authorization-matrix');
  driver(transport, {
    ...base,
    mode: 'matrix',
    fixtureUserIds: signup.ids,
    expiredIssuedToken: JSON.parse(expiry).token,
  });
  const publicationQuery =
    "SELECT md5(jsonb_build_object('programs',(SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM public.leaderboard_reward_program_versions p),'settings',(SELECT jsonb_agg(to_jsonb(s) ORDER BY club_id) FROM public.club_leaderboard_settings s),'audit',(SELECT jsonb_agg(to_jsonb(a) ORDER BY id) FROM public.audit_trail a))::text);";
  stage('overseer-appoint');
  sql(delegationFixture('appoint', signup.ids));
  // Overseer admission/revocation uses fresh actual sessions for the SAME
  // identities. Only owner RPC phases inside the driver prove same-token use.
  stage('overseer-admitted');
  driver(transport, { ...base, mode: 'overseer-admitted', fixtureUserIds: signup.ids });
  stage('overseer-revoke');
  sql(delegationFixture('revoke', signup.ids));
  const publicationBeforeRefusal = sql(publicationQuery);
  stage('overseer-refused');
  driver(transport, { ...base, mode: 'overseer-revoked', fixtureUserIds: signup.ids });
  stage('final-readback');
  assert.equal(
    sql(publicationQuery),
    publicationBeforeRefusal,
    'Revoked overseer changed publication state'
  );
  assert.equal(catalog(), expected);
  assert.deepEqual(versions(), cfg.authVersions);
  assert.equal(sql(financialQuery), financialBefore, 'HTTP matrix changed financial state');
  sql(
    "DO $$ BEGIN IF (SELECT count(*) FROM public.leaderboard_reward_program_versions)<>6 OR EXISTS(SELECT 1 FROM public.leaderboard_reward_program_versions WHERE rewards_enabled OR overlay_enabled) OR (SELECT max(version) FROM public.leaderboard_reward_program_versions WHERE club_id='92000000-0000-4000-8000-000000000001') IS DISTINCT FROM 4 OR (SELECT max(version) FROM public.leaderboard_reward_program_versions WHERE club_id='92000000-0000-4000-8000-000000000002') IS DISTINCT FROM 2 OR EXISTS(SELECT 1 FROM public.club_members WHERE chip_balance<>0) OR EXISTS(SELECT 1 FROM public.clubs WHERE promo_balance<>0) OR EXISTS(SELECT 1 FROM public.union_wallets WHERE promo_wallet<>0) OR EXISTS(SELECT 1 FROM public.leaderboard_payout_batches) THEN RAISE EXCEPTION 'HTTP persistence/financial refusal readback failed'; END IF; END $$;"
  );
  sql(
    `DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM public.leaderboard_reward_program_versions WHERE club_id='92000000-0000-4000-8000-000000000001' AND funding_owner_type='union' AND funding_union_id='91000000-0000-4000-8000-000000000001' AND published_by='${signup.ids[0]}') OR NOT EXISTS(SELECT 1 FROM public.leaderboard_reward_program_versions WHERE club_id='92000000-0000-4000-8000-000000000002' AND funding_owner_type='club' AND funding_union_id IS NULL AND published_by='${signup.ids[1]}') THEN RAISE EXCEPTION 'HTTP funding-owner persistence identity mismatch'; END IF; END $$;`
  );
  // Independent persisted publication sequence catches writes by any refused
  // phase, including extra versions hidden behind the latest setup response.
  sql(`DO $$ BEGIN IF EXISTS(
    SELECT 1 FROM public.leaderboard_reward_program_versions p
    FULL JOIN (VALUES
      ('92000000-0000-4000-8000-000000000001'::uuid,1,'${signup.ids[0]}'::uuid,'union','91000000-0000-4000-8000-000000000001'::uuid),
      ('92000000-0000-4000-8000-000000000001'::uuid,2,'${signup.ids[3]}'::uuid,'union','91000000-0000-4000-8000-000000000001'::uuid),
      ('92000000-0000-4000-8000-000000000001'::uuid,3,'${signup.ids[3]}'::uuid,'union','91000000-0000-4000-8000-000000000001'::uuid),
      ('92000000-0000-4000-8000-000000000001'::uuid,4,'${signup.ids[4]}'::uuid,'union','91000000-0000-4000-8000-000000000001'::uuid),
      ('92000000-0000-4000-8000-000000000002'::uuid,1,'${signup.ids[1]}'::uuid,'club',NULL::uuid),
      ('92000000-0000-4000-8000-000000000002'::uuid,2,'${signup.ids[3]}'::uuid,'club',NULL::uuid)
    ) e(club_id,version,publisher,funding_type,funding_union)
    ON p.club_id=e.club_id AND p.version=e.version
    WHERE p.id IS NULL OR e.club_id IS NULL OR p.published_by IS DISTINCT FROM e.publisher
      OR p.funding_owner_type IS DISTINCT FROM e.funding_type
      OR p.funding_union_id IS DISTINCT FROM e.funding_union
      OR p.rewards_enabled IS DISTINCT FROM false OR p.overlay_enabled IS DISTINCT FROM false
      OR p.weekly_prizes IS DISTINCT FROM '[]'::jsonb OR p.monthly_prizes IS DISTINCT FROM '[]'::jsonb
      OR p.payout_metric IS DISTINCT FROM 'profit' OR p.payout_currency IS DISTINCT FROM 'chips'
  ) THEN RAISE EXCEPTION 'Delegated publication sequence mismatch'; END IF; END $$;`);
  console.log(
    'Unqualified Draft Real Auth Matrix Completed; Production Binary Parity Unknown; Root Database Cleanup Required'
  );
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main()
    .catch(() => {
      console.error(authFailureDiagnostic(phase, failureKind));
      console.error('Real Auth Launcher Draft Failed; No Qualification Claimed');
      process.exitCode = 1;
    })
    .finally(() => {
      let failed = false;
      for (const name of owned) {
        const before = spawnSync(
          'docker',
          ['container', 'ls', '-a', '--filter', `name=^/${name}$`, '--format', '{{.Names}}'],
          { encoding: 'utf8', timeout: 15000 }
        );
        if (before.status !== 0) {
          failed = true;
          continue;
        }
        if (before.stdout.trim()) {
          const result = spawnSync('docker', ['rm', '-f', name], {
            encoding: 'utf8',
            timeout: 30000,
          });
          if (result.status !== 0) failed = true;
        }
        const remains = spawnSync(
          'docker',
          ['container', 'ls', '-a', '--filter', `name=^/${name}$`, '--format', '{{.Names}}'],
          { encoding: 'utf8', timeout: 15000 }
        );
        if (remains.status !== 0 || remains.stdout.trim()) failed = true;
      }
      for (const path of ownedSecrets) {
        try {
          unlinkSync(path);
          if (existsSync(path)) failed = true;
        } catch {
          failed = true;
        }
      }
      if (failed) {
        console.error('Owned Auth/REST Draft Cleanup Failed');
        process.exitCode = 1;
      }
    });
