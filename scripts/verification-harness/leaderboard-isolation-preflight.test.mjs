import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const shell = fileURLToPath(new URL('./leaderboard-isolation-preflight.sh', import.meta.url));
const source = readFileSync(shell, 'utf8');
const catalog = readFileSync(
  new URL('./leaderboard-isolation-catalog.sql', import.meta.url),
  'utf8'
);

test('source safeguard check executes without credentials or production access', () => {
  const result = spawnSync('bash', [shell, '--check'], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /safeguards checked/);
});

test('source export is schema-only and password-free, with drift and isolation refusal', () => {
  assert.match(source, /--schema-only --create --format=custom --no-password --no-subscriptions/);
  assert.match(source, /--database="\$PGDATABASE"/);
  assert.match(
    source,
    /source_client 180 pg_dumpall --roles-only --no-role-passwords --no-password/
  );
  assert.match(source, /default_transaction_read_only=on/);
  assert.match(source, /source schema changed during export/);
  assert.match(source, /unset DATABASE_URL PGDATABASE PGOPTIONS/);
  assert.match(source, /docker network create --internal/);
  assert.match(source, /cron\.launch_active_jobs=off/);
  assert.ok(
    source.indexOf("-c 'DROP DATABASE postgres;'") <
      source.indexOf('shared_preload_libraries=pg_cron,pg_stat_statements')
  );
  assert.match(source, /--schema-only --exit-on-error --use-list/);
  assert.match(source, /isolated catalog differs from current source/);
  assert.doesNotMatch(source, /--data-only|fn_payout_leaderboard|fn_settle_due_leaderboards/);
});

test('catalog fingerprint includes security and financial schema dependencies', () => {
  for (const category of [
    'roles',
    'memberships',
    'schemas',
    'relations',
    'columns',
    'routines',
    'constraints',
    'domain_constraints',
    'indexes',
    'triggers',
    'event_triggers',
    'policies',
    'types',
    'defaults',
    'extensions',
    'database',
    'database_settings',
    'sql_settings',
    'tablespaces',
    'publications',
    'publication_relations',
    'publication_schemas',
  ]) {
    assert.match(catalog, new RegExp(`'${category}'`));
  }
  assert.match(catalog, /relrowsecurity,c\.relforcerowsecurity,c\.relacl/);
  assert.match(catalog, /prosecdef,p\.proconfig,p\.proacl/);
  assert.match(catalog, /pg_get_viewdef/);
  assert.match(catalog, /pg_get_userbyid\(e\.extowner\)/);
  assert.match(catalog, /k\.conrelid=0/);
  assert.doesNotMatch(catalog, /FROM public\.|FROM auth\.|rolpassword/i);
});

test('cleanup must finish before the verdict and source entrypoints cannot initialize a server', () => {
  assert.match(source, /cleanup \|\| failure 'explicit cleanup verification failed'/);
  assert.ok(
    source.indexOf("cleanup || failure 'explicit cleanup verification failed'") <
      source.indexOf('echo "Captured schema/security')
  );
  assert.match(source, /docker run --name "\$source_container" --rm/);
  assert.match(source, /--entrypoint \/bin\/sh/);
  assert.match(source, /exec "\/usr\/lib\/postgresql\/bin\/\$client" --dbname="\$PGDATABASE"/);
  assert.match(source, /docker container inspect/);
  assert.doesNotMatch(source, /docker (rm|network rm).*\|\| true/);
});

test('actual source-client connection wrapper expands URI instead of local socket defaults', () => {
  const wrapper = source.match(/'client=\$1; shift; case[^\n]+'/)?.[0].slice(1, -1);
  assert.ok(wrapper);
  // Synthetic unreachable loopback endpoint only: no source data or credentials.
  // Use installed clients with exactly the maintained argument construction.
  const executable = wrapper.replaceAll('/usr/lib/postgresql/bin/', '');
  const env = {
    PATH: process.env.PATH,
    PGHOST: '/leaderboard-qualification-nonexistent-fixture-socket',
    PGDATABASE: 'postgresql://fixture_user:fixture_password@127.0.0.1:1/postgres?connect_timeout=1',
  };
  const before = spawnSync('psql', ['-XAtq', '--no-password', '-c', 'SELECT 1;'], {
    env,
    encoding: 'utf8',
  });
  assert.equal(before.error, undefined, 'Required PostgreSQL psql client unavailable');
  assert.equal(before.status, 2);
  assert.match(before.stderr, /socket/);
  for (const client of ['psql', 'pg_dump', 'pg_dumpall']) {
    const after = spawnSync('sh', ['-c', executable, 'source-client', client, '--no-password'], {
      env,
      encoding: 'utf8',
    });
    assert.equal(after.error, undefined, 'Required shell unavailable');
    assert.notEqual(after.status, 127, `Required PostgreSQL ${client} client unavailable`);
    assert.ok(after.status !== 0);
    assert.match(after.stderr, /127\.0\.0\.1/);
    assert.doesNotMatch(after.stderr, /on socket/);
  }
});

test('source diagnostics return allowlisted categories without raw error or secrets', () => {
  const samples = [
    [
      2,
      'password authentication failed for postgres://secret:marker@private.example/db',
      'authentication',
    ],
    [2, 'could not translate host name private.example', 'name-resolution'],
    [124, 'postgres://secret:marker@private.example/db', 'bounded-timeout'],
    [2, 'unrecognized raw error secret marker', 'unclassified-source-client'],
  ];
  for (const [status, input, category] of samples) {
    const result = spawnSync('bash', [shell, '--classify-source-error', String(status)], {
      input,
      encoding: 'utf8',
      env: { PATH: process.env.PATH },
    });
    assert.equal(result.status, 0);
    assert.equal(result.stdout.trim(), category);
    assert.equal(result.stderr, '');
  }
});
