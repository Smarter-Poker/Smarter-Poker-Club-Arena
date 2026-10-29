/** Exact historical-runtime fixture qualification; no installation or host transport. */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../../../..');
const EED = 'eed06fe51dea622069c661a6213d5b031ff3a9e3';
const qualificationDeadline = performance.now() + 120000;
const CASES = [
  'RetainedOriginalCheckpointProbe.test.ts',
  'RetainedOriginalResumeCapture.test.ts',
  'CashMaintenanceParkCapture.test.ts',
  'RetainedWholeGuard.test.ts',
];
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
function need(value, reason) {
  if (!value) throw new Error(reason);
}
// Git hooks export repository-local coordinates. Filesystem discovery in the
// external scratch directory must not inherit the caller's repository binding.
function isolatedEnvironment(extra = {}) {
  const env = { ...process.env };
  for (const name of Object.keys(env)) if (name.startsWith('GIT_')) delete env[name];
  return { ...env, GIT_NO_LAZY_FETCH: '1', ...extra };
}
function run(program, args, cwd, timeout = 120000, extraEnv = {}) {
  const remaining = Math.floor(qualificationDeadline - performance.now());
  need(remaining > 0, 'historical qualification total 120-second budget exhausted');
  const result = spawnSync(program, args, {
    cwd,
    encoding: 'utf8',
    timeout: Math.min(timeout, remaining),
    maxBuffer: 8 * 1024 * 1024,
    env: {
      ...isolatedEnvironment(),
      SUPABASE_URL: 'https://supabase.invalid',
      SUPABASE_SERVICE_ROLE_KEY: 'unit-test-placeholder-key',
      ...extraEnv,
    },
  });
  if (result.status !== 0 && args.includes('--reporter=json')) {
    const codes = [...new Set((result.stdout ?? '').match(/retained_[a-z_]+/g) ?? [])];
    let cases = [];
    try {
      const report = JSON.parse(result.stdout.slice(result.stdout.indexOf('{')));
      cases = (report.testResults ?? [])
        .filter((row) => row.status !== 'passed')
        .map((row) => ({
          file: row.name.split('/').pop(),
          failedTests: (row.assertionResults ?? [])
            .filter((test) => test.status === 'failed')
            .map((test) => test.fullName ?? test.title),
          errors: [
            row.message,
            ...(row.assertionResults ?? []).flatMap((test) => test.failureMessages ?? []),
          ]
            .filter(Boolean)
            .map((message) => String(message).split('\n').find(Boolean) ?? '')
            .map((line) =>
              line
                .replace(/AssertionError:.*/, 'AssertionError: fixture assertion failed')
                .slice(0, 180)
            ),
          assertionLocations: [
            ...new Set(
              (row.assertionResults ?? [])
                .flatMap((test) => test.failureMessages ?? [])
                .flatMap(
                  (message) => message.match(/RetainedWholeGuard\.test\.ts:[0-9]+:[0-9]+/g) ?? []
                )
            ),
          ],
        }));
    } catch {}
    console.error(JSON.stringify({ failedNativeFixture: true, refusalCodes: codes, cases }));
  }
  need(
    !result.error && result.status === 0,
    `historical qualification command failed: ${program} (${result.status ?? 'unknown'})`
  );
  return result.stdout;
}
const guardPath = join(ROOT, 'server/scripts/retained-original-checkpoint-guard.mjs');
const guardBytes = readFileSync(guardPath);
const pinText = guardBytes.toString().match(/const pins = (\[[\s\S]*?\]);/);
need(pinText, 'fixed deployed pin census unavailable');
// The maintained formatter may choose either JS string delimiter. Every
// decoded value is still restricted to the fixed ASCII path/hash schema below.
const pins = JSON.parse(pinText[1].replace(/'/g, '"').replace(/,\s*]/g, ']'));
need(
  pins.length === 24 &&
    new Set(pins.map(([path]) => path)).size === 24 &&
    pins.every(
      ([path, sha]) => /^\/app\/dist\/[A-Za-z0-9/]+\.js$/.test(path) && /^[a-f0-9]{64}$/.test(sha)
    ),
  'fixed deployed pin census refused'
);
const candidate =
  process.env.GITHUB_ACTIONS === 'true' ? process.env.RUNNER_TEMP : process.env.TMPDIR;
need(candidate && isAbsolute(candidate), 'external TMPDIR or CI RUNNER_TEMP required');
const tempRoot = realpathSync(candidate);
need(
  process.env.GITHUB_ACTIONS === 'true' || tempRoot.startsWith('/Volumes/SmarterWork/agent-work/'),
  'local qualification must use external SSD'
);
need(
  relative(ROOT, tempRoot).startsWith('..'),
  'qualification temporary directory must be outside checkout'
);
const withinGit = spawnSync('git', ['-C', tempRoot, 'rev-parse', '--is-inside-work-tree'], {
  encoding: 'utf8',
  env: isolatedEnvironment(),
});
need(
  withinGit.status !== 0,
  'qualification temporary directory must be outside all Git repositories'
);
run('git', ['cat-file', '-e', EED + '^{commit}'], ROOT);
const serverDependencies = realpathSync(join(ROOT, 'server/node_modules'));
need(existsSync(serverDependencies), 'existing locked server dependencies required');
const folder = mkdtempSync(join(tempRoot, 'eed-checkpoint-'));
try {
  const archive = join(folder, 'exact-eed.tar');
  run('git', ['archive', '--format=tar', '--output=' + archive, EED], ROOT);
  // The archive is created from the fixed local Git object, never caller input.
  run('tar', ['-xf', archive, '-C', folder], ROOT);
  rmSync(archive);
  const server = join(folder, 'server');
  // Historical server sources use the same locked server package at both resolution roots.
  symlinkSync(serverDependencies, join(folder, 'node_modules'), 'dir');
  symlinkSync(serverDependencies, join(server, 'node_modules'), 'dir');
  run(
    process.execPath,
    [join(serverDependencies, 'typescript/bin/tsc'), '--project', join(server, 'tsconfig.json')],
    server
  );
  const actualPins = pins.map(([path, expected]) => {
    const bytes = readFileSync(join(server, path.slice('/app/'.length)));
    need(hash(bytes) === expected, 'exact EED compiled deployed pin differs: ' + path);
    return { path, sha256: expected, bytes: bytes.length };
  });
  for (const name of CASES) copyFileSync(join(HERE, name), join(server, 'src/engine', name));
  const output = run(
    process.execPath,
    [
      join(serverDependencies, 'vitest/vitest.mjs'),
      'run',
      ...CASES.map((name) => 'src/engine/' + name),
      '--cache=false',
      '--reporter=json',
    ],
    server,
    120000,
    {
      GIT_COMMIT_SHA: EED,
      RETAINED_CHECKPOINT_GUARD_URL: new URL(
        '../../retained-original-checkpoint-guard.mjs',
        import.meta.url
      ).href,
      RETAINED_CHECKPOINT_DIST_ROOT: join(server, 'dist'),
    }
  );
  const start = output.indexOf('{');
  need(start >= 0, 'native fixture result unavailable');
  const result = JSON.parse(output.slice(start));
  need(
    result.success === true &&
      result.numTotalTests === 19 &&
      result.numPassedTests === 19 &&
      result.numFailedTests === 0,
    'all nineteen exact EED fixture cases must actually pass'
  );
  need(
    hash(readFileSync(guardPath)) === hash(guardBytes),
    'guard pins changed during qualification'
  );
  need(
    performance.now() < qualificationDeadline,
    'historical qualification total 120-second budget exhausted'
  );
  console.log(
    JSON.stringify(
      {
        schema: 'exact-eed-checkpoint-qualification/v1',
        readOnlyProduction: true,
        historicalRevision: EED,
        guardSha256: hash(guardBytes),
        pins: actualPins,
        fixtures: CASES.map((name) => ({ name, sha256: hash(readFileSync(join(HERE, name))) })),
        actualTests: result.numTotalTests,
        passedTests: result.numPassedTests,
        status: 'passed',
        limitation: 'isolated historical native behavior; no production or checkpoint invocation',
      },
      null,
      2
    )
  );
} finally {
  rmSync(folder, { recursive: true, force: true });
}
