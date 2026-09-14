// Called only by the socket-only authority native runner. No network DSN accepted.
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const fixtureRoot = resolve(
  process.env.CA_TOURNAMENT_AUTHORITY_SOURCE ?? join(root, '../codex-pipeline-maintenance-db')
);
const evidence = resolve(process.argv[3]);
const state = JSON.parse(await readFile(process.argv[2], 'utf8'));
assert.match(state.socket, /^\/(?:private\/)?tmp\/ca-e2-owned-[^/]+\/socket$/);
assert.equal(state.database, 'e2_bee519fa');
const files = [
  'server/src/tournament/TournamentManagerBase.ts',
  'server/src/tournament/TournamentOperationClock.native.test.ts',
  'server/src/maintenance/OperationTournament.ts',
  'server/src/maintenance/OperationMaintenanceRuntime.ts',
  'server/src/maintenance/operationMaintenanceStore.ts',
  'server/src/maintenance/operationPolicy.ts',
  'server/src/maintenance/operationPolicy.json',
  'server/src/maintenance/freezeState.ts',
  'tests/maintenance/tournament-manager-composition.mjs',
];
const external = ['tests/maintenance/integration.mjs', 'tests/maintenance/runtime-fixture.mjs'];
const hashes = {};
for (const path of [
  ...files.map((p) => join(root, p)),
  ...external.map((p) => join(fixtureRoot, p)),
])
  hashes[path] = createHash('sha256')
    .update(await readFile(path))
    .digest('hex');
await mkdir(join(evidence, 'authority'), { recursive: true });
const execute = promisify(execFile);
const env = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key]) =>
      !key.startsWith('GIT_') &&
      !key.startsWith('PG') &&
      !['DATABASE_URL', 'SUPABASE_DB_URL'].includes(key)
  )
);
const authority = await execute(
  process.execPath,
  [
    join(fixtureRoot, 'tests/maintenance/integration.mjs'),
    process.argv[2],
    join(evidence, 'authority'),
  ],
  { env, maxBuffer: 8e6 }
);
await writeFile(join(evidence, 'authority/native.log'), authority.stdout);
const authorityCases = JSON.parse(await readFile(join(evidence, 'authority/cases.json'), 'utf8'));
assert.equal(authorityCases.length, 17);
let failure;
try {
  const result = await execute(
    process.execPath,
    [
      join(root, 'server/node_modules/vitest/vitest.mjs'),
      'run',
      'src/tournament/TournamentOperationClock.native.test.ts',
      '--reporter=json',
      '--outputFile=' + join(evidence, 'vitest.json'),
    ],
    {
      cwd: join(root, 'server'),
      maxBuffer: 8e6,
      env: {
        ...env,
        CA_TOURNAMENT_NATIVE_CLUSTER: resolve(process.argv[2]),
        CA_TOURNAMENT_AUTHORITY_SOURCE: fixtureRoot,
        CA_TOURNAMENT_NATIVE_EVIDENCE: evidence,
      },
    }
  );
  await writeFile(join(evidence, 'manager.log'), result.stdout + result.stderr);
} catch (error) {
  failure = error;
  await writeFile(join(evidence, 'manager.log'), (error.stdout ?? '') + (error.stderr ?? ''));
}
for (const [path, digest] of Object.entries(hashes))
  assert.equal(
    createHash('sha256')
      .update(await readFile(path))
      .digest('hex'),
    digest,
    'source changed: ' + path
  );
await writeFile(
  join(evidence, 'manager-inputs.json'),
  JSON.stringify({ root, fixtureRoot, node: process.version, hashes }, null, 2)
);
const result = JSON.parse(await readFile(join(evidence, 'vitest.json'), 'utf8'));
const cases = result.testResults.flatMap((s) =>
  s.assertionResults.map((t) => ({
    name: t.fullName,
    status: t.status,
    message: t.failureMessages.join('\n'),
  }))
);
await writeFile(join(evidence, 'cases.json'), JSON.stringify(cases, null, 2));
if (failure) throw failure;
assert.ok(cases.length >= 3 && cases.every((c) => c.status === 'passed'));
console.log(
  JSON.stringify({ authority: authorityCases.length, manager: cases.length, status: 'passed' })
);
