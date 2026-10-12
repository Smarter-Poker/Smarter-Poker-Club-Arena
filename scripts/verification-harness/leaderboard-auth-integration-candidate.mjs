// UNQUALIFIED SOURCE PREPARATION ONLY. Emits a separate Auth qualification
// script; never executes Docker, source SQL, the launcher, or writes a file.
// Future integration must materialize output beside the maintained preflight.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export function buildAuthCandidate(source) {
  function replaceOnce(anchor, replacement) {
    assert.equal(source.split(anchor).length, 2, 'Reviewed preflight anchor changed');
    source = source.replace(anchor, replacement);
  }
  assert.equal(source.split('for command in docker timeout sha256sum cmp node; do').length, 2);
  replaceOnce(
    'export PGDATABASE="$DATABASE_URL"',
    `auth_versions() {
  source_client 30 psql -XAtq --no-password -v ON_ERROR_STOP=1 \\
    -c 'SELECT jsonb_agg(version ORDER BY version) FROM auth.schema_migrations;'
}
export PGDATABASE="$DATABASE_URL"`
  );
  replaceOnce(
    'source_catalog >"$scratch/source-before.json"',
    'auth_versions >"$scratch/auth-versions-before.json" 2>"$scratch/source-error.log" || failure \'Auth migration metadata unavailable\'\nsource_catalog >"$scratch/source-before.json"'
  );
  replaceOnce(
    'unset DATABASE_URL PGDATABASE PGOPTIONS',
    `auth_versions >"$scratch/auth-versions-after.json" 2>"$scratch/source-error.log" || failure 'Auth migration metadata recheck unavailable'
cmp -s "$scratch/auth-versions-before.json" "$scratch/auth-versions-after.json" || failure 'Auth migration history changed during export'
unset DATABASE_URL PGDATABASE PGOPTIONS PGHOST PGUSER PGPASSWORD`
  );
  replaceOnce(
    "cleanup || failure 'explicit cleanup verification failed'",
    `# Actual Auth runs only AFTER full current catalog equivalence, BEFORE owner cleanup.
# Launcher performs exact local metadata insertion/readback; no Auth users copied.
node --input-type=module - "$container" "$scratch" <<'AUTH_INPUT' | node "$here/leaderboard-real-auth-launcher-draft.mjs" || failure 'isolated actual Auth qualification failed'
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
const [container, scratch] = process.argv.slice(2);
const authVersions = JSON.parse(readFileSync(join(scratch, 'auth-versions-before.json'), 'utf8'));
process.stdout.write(JSON.stringify({ container, scratch, sourceCatalog: join(scratch, 'source-before.json'), authVersions }));
AUTH_INPUT
cleanup || failure 'explicit cleanup verification failed'`
  );
  replaceOnce(
    "echo 'This preflight does not qualify Supabase service/auth runtime, synthetic configuration, authorization, funding, payouts, recovery, reconciliation or worker execution.'",
    "echo 'Selected isolated Auth/REST authorization matrix and owner cleanup completed; production binary/config parity, payouts, recovery and worker qualification remain excluded.'"
  );
  return source;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const source = readFileSync(
      new URL('./leaderboard-isolation-preflight.sh', import.meta.url),
      'utf8'
    );
    process.stdout.write(buildAuthCandidate(source));
  } catch {
    console.error('Auth integration source preparation refused; reviewed preflight changed');
    process.exitCode = 1;
  }
}
