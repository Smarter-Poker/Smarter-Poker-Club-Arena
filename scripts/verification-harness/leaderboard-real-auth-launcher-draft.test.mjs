// Source safeguard contracts only; these do NOT execute or qualify Auth/REST.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { assertExpiredCredential } from './leaderboard-real-auth-draft.mjs';

test('expiry oracle requires the pinned claims error and exact expiry reason', () => {
  assert.doesNotThrow(() =>
    assertExpiredCredential({ status: 401, data: { code: 'PGRST303', message: 'JWT expired' } })
  );
  for (const response of [
    { status: 401, data: { code: 'PGRST301', message: 'JWT expired' } },
    { status: 401, data: { code: 'PGRST303', message: 'JWT audience invalid' } },
    { status: 401, data: { code: 'PGRST303', message: 'JWT cryptographic verification failed' } },
    { status: 401, data: { code: 'PGRST303', message: 'expired' } },
    { status: 401 },
    { status: 403, data: { code: 'PGRST303', message: 'JWT expired' } },
  ])
    assert.throws(() => assertExpiredCredential(response));
  assert.match(transport, /assertExpiredCredential\(denied\)/);
});
const launcher = readFileSync(
  new URL('./leaderboard-real-auth-launcher-draft.mjs', import.meta.url),
  'utf8'
);
const transport = readFileSync(
  new URL('./leaderboard-real-auth-draft.mjs', import.meta.url),
  'utf8'
);
test('selected official images and serve-only startup are immutable', () => {
  assert.match(
    launcher,
    /supabase\/gotrue@sha256:1736a63078f5922b198c4cbe50f80ab9a2d3b54fe8b7b6cfb2e9dc5dbbc12c6b/
  );
  assert.match(
    launcher,
    /postgrest\/postgrest@sha256:b574528fe109c8343c1247155734d03df8c34b462f342dca0ccc20244fc36ef9/
  );
  assert.match(launcher, /'\/usr\/local\/bin\/auth',\s*\['serve'\]/);
  assert.ok(!launcher.includes("['migrate']"));
  assert.ok(!launcher.includes("'--publish'") && !launcher.includes("'--privileged'"));
});
test('original roles, metadata history and schema are checked independently', () => {
  assert.match(launcher, /ALTER ROLE supabase_auth_admin PASSWORD/);
  assert.match(launcher, /ALTER ROLE authenticator PASSWORD/);
  assert.ok(!/ALTER ROLE[^;]+(?:SUPERUSER|LOGIN|BYPASSRLS|INHERIT)/.test(launcher));
  assert.equal((launcher.match(/assert\.equal\(catalog\(\), expected\)/g) || []).length, 4);
  assert.ok(
    (launcher.match(/assert\.deepEqual\(versions\(\), cfg\.authVersions\)/g) || []).length >= 3
  );
  assert.match(
    transport,
    /assert\.deepEqual\(cfg\.preflight\.authVersions, cfg\.preflight\.candidateAuthVersions\)/
  );
  assert.match(transport, /imageMigrationVersions\.every/);
});
test('source credentials are excluded and owned secret files are removed', () => {
  for (const key of ['DATABASE_URL', 'PGDATABASE', 'PGHOST', 'PGUSER', 'PGPASSWORD'])
    assert.ok(launcher.includes(`'${key}'`));
  assert.match(launcher, /network\.Internal, true/);
  assert.match(launcher, /db\.HostConfig\.PortBindings \?\? \{\}, \{\}/);
  assert.match(launcher, /flag: 'wx'/);
  assert.match(launcher, /unlinkSync\(path\)/);
  assert.match(launcher, /Owned Auth\/REST Draft Cleanup Failed/);
});
