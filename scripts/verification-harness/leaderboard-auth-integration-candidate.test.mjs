import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { buildAuthCandidate } from './leaderboard-auth-integration-candidate.mjs';
const original = readFileSync(
  new URL('./leaderboard-isolation-preflight.sh', import.meta.url),
  'utf8'
);
test('materialized Auth-only script matches the reviewed generated candidate', () => {
  const materialized = readFileSync(
    new URL('./leaderboard-isolated-auth-qualification.sh', import.meta.url),
    'utf8'
  );
  assert.equal(materialized, buildAuthCandidate(original));
});
test('separate candidate parses and source reads only migration-version metadata', () => {
  const candidate = buildAuthCandidate(original);
  assert.equal(spawnSync('bash', ['-n'], { input: candidate }).status, 0);
  assert.match(
    candidate,
    /SELECT jsonb_agg\(version ORDER BY version\) FROM auth.schema_migrations/
  );
  assert.match(candidate, /Auth migration history changed during export/);
  assert.match(candidate, /auth_versions\(\) \{\n  source_client 30 psql/);
  assert.match(candidate, /--dbname="\$PGDATABASE"/);
  assert.match(candidate, /source-client "\$client" "\$@"/);
  assert.doesNotMatch(candidate, /SELECT.*FROM auth.users/);
  assert.match(candidate, /unset DATABASE_URL PGDATABASE PGOPTIONS PGHOST PGUSER PGPASSWORD/);
});
test('real launcher is after equivalence and before verified owning cleanup', () => {
  const candidate = buildAuthCandidate(original);
  const compare = candidate.indexOf('isolated catalog differs from current source');
  const launch = candidate.indexOf('node "$here/leaderboard-real-auth-launcher-draft.mjs"');
  const cleanup = candidate.indexOf("cleanup || failure 'explicit cleanup verification failed'");
  assert.ok(compare < launch && launch < cleanup);
  assert.match(candidate, /sourceCatalog: join\(scratch, 'source-before.json'\), authVersions/);
  assert.match(candidate, /isolated actual Auth qualification failed/);
  assert.ok(!original.includes('leaderboard-real-auth-launcher'));
});
test('changed or duplicate preflight anchors refuse source preparation', () => {
  assert.throws(() =>
    buildAuthCandidate(
      original.replace('unset DATABASE_URL PGDATABASE PGOPTIONS', 'unset DATABASE_URL')
    )
  );
  assert.throws(() => buildAuthCandidate(original + '\nexport PGDATABASE="$DATABASE_URL"\n'));
});
