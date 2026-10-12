import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { bounds, profile, query, same } from './leaderboard-isolation-startup-profile.mjs';

const fixture = Object.entries({
  max_connections: '480',
  max_locks_per_transaction: '64',
  max_prepared_transactions: '0',
  autovacuum_max_workers: '3',
  max_worker_processes: '16',
  max_wal_senders: '80',
}).map(([name, setting]) => ({ name, setting }));
test('exact six source values generate only allowlisted integer configuration', () => {
  assert.equal(
    profile(fixture),
    'max_connections = 480\nmax_locks_per_transaction = 64\nmax_prepared_transactions = 0\nautovacuum_max_workers = 3\nmax_worker_processes = 16\nmax_wal_senders = 80\n'
  );
  same(fixture, [...fixture].reverse());
  assert.match(query, /^SELECT .* FROM pg_catalog.pg_settings WHERE name IN /);
  assert.doesNotMatch(query, /INSERT|UPDATE|DELETE|ALTER|CREATE|DROP/);
});
test('missing, duplicate, extra, malformed and out-of-envelope settings refuse', () => {
  for (const invalid of [
    null,
    {},
    fixture.slice(1),
    [...fixture, fixture[0]],
    [fixture[0], fixture[0], ...fixture.slice(2)],
  ])
    assert.throws(() => profile(invalid));
  for (const [name, [minimum, maximum]] of Object.entries(bounds)) {
    for (const setting of [
      '01',
      '-1',
      '1.0',
      '1\nshared_preload_libraries=x',
      String(maximum + 1),
      String(minimum - 1),
      480,
    ]) {
      assert.throws(() =>
        profile(fixture.map((row) => (row.name === name ? { name, setting } : row)))
      );
    }
  }
  assert.throws(() => profile(fixture.map((row, i) => (i ? row : { ...row, secret: 'private' }))));
  assert.throws(() =>
    profile(fixture.map((row, i) => (i ? row : { name: 'unknown', setting: '1' })))
  );
  assert.throws(() =>
    profile(Object.entries(bounds).map(([name, range]) => ({ name, setting: String(range[1]) })))
  );
});
test('independent readback refuses changed startup capacity rather than applying fallback', () => {
  assert.throws(() =>
    same(
      fixture,
      fixture.map((row) => (row.name === 'max_connections' ? { ...row, setting: '100' } : row))
    )
  );
});
test('profile CLI failures never expose private input paths or settings', () => {
  const result = spawnSync(
    process.execPath,
    [
      fileURLToPath(new URL('./leaderboard-isolation-startup-profile.mjs', import.meta.url)),
      'config',
      '/private-do-not-disclose/credential-marker',
    ],
    { encoding: 'utf8' }
  );
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, 'Numeric startup profile refused or differs.\n');
});
test('source profile drift is checked and persistent configuration precedes both verified boots', () => {
  const source = readFileSync(
    new URL('./leaderboard-isolation-preflight.sh', import.meta.url),
    'utf8'
  );
  assert.ok(
    source.indexOf('source_startup >"$scratch/startup-before.json"') <
      source.indexOf('source_client 600 pg_dump')
  );
  assert.ok(
    source.indexOf('source_startup >"$scratch/startup-after.json"') >
      source.indexOf('source_client 600 pg_dump')
  );
  assert.ok(
    source.indexOf('"$scratch/startup-after.json" || failure') <
      source.indexOf('unset DATABASE_URL PGDATABASE PGOPTIONS')
  );
  const boot = source.match(/'\/usr\/lib\/postgresql\/bin\/initdb[^\n]+/)?.[0];
  assert.ok(boot);
  assert.ok(
    boot.indexOf('printf "\\n%s\\n" "$2" >>/tmp/leaderboard-qualification-db/postgresql.conf') <
      boot.indexOf('/usr/lib/postgresql/bin/pg_ctl')
  );
  assert.match(source, /isolated-bootstrap "\$source_bootstrap" "\$startup_config"/);
  for (const phase of ['initial', 'restarted'])
    assert.match(
      source,
      new RegExp(`verify "\\$scratch/startup-before.json" "\\$scratch/startup-${phase}.json"`)
    );
  assert.ok(
    source.indexOf('"$scratch/startup-restarted.json" || failure') <
      source.indexOf('<"$scratch/extensions.sql"')
  );
});
