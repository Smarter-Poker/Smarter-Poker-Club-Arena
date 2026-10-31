/** Exact historical-runtime fixture qualification; no installation or host transport. */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../../../..');
const EED = 'eed06fe51dea622069c661a6213d5b031ff3a9e3';
const nativeImage = process.argv.find((x) => x.startsWith('--native-census-image='))?.split('=')[1];
const nativeAddon = process.argv.find((x) => x.startsWith('--native-census-addon='))?.split('=')[1];
if (process.argv.slice(2).some((x) => !/^--native-census-(?:image|addon)=/.test(x)) ||
    (nativeImage && nativeAddon) || (nativeImage && !/^sha256:[0-9a-f]{64}$/.test(nativeImage)) ||
    (nativeAddon && !isAbsolute(nativeAddon))) throw Error('Invalid native composition input');
const nativeMode = Boolean(nativeImage || nativeAddon);
const qualificationDeadline = performance.now() + (nativeMode ? 180000 : 120000);
const CASES = nativeMode ? ['RetainedWholeGuard.test.ts'] : [
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
  need(remaining > 0, 'historical qualification total budget exhausted');
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
    `historical qualification command failed: ${program} (${result.status ?? 'unknown'})\n` +
      `${result.error?.message ?? ''}\n${result.stdout ?? ''}\n${result.stderr ?? ''}`.slice(-24000)
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
  pins.length === 29 &&
    new Set(pins.map(([path]) => path)).size === 29 &&
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
  run(
    'git',
    ['archive', '--format=tar', '--output=' + archive, EED, 'server', 'package.json'],
    ROOT
  );
  // All historical server source/config/data and root ESM metadata come from the fixed Git object.
  // Unrelated client assets and migration archives cannot consume the native proof budget.
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
  const fixtureEnv = {
    GIT_COMMIT_SHA: EED,
    RETAINED_CHECKPOINT_GUARD_URL: new URL('../../retained-original-checkpoint-guard.mjs', import.meta.url).href,
    RETAINED_CHECKPOINT_DIST_ROOT: join(server, 'dist'),
    RETAINED_NATIVE_CENSUS_ADDON: nativeMode ? (nativeImage ? '/app/native/legacy-census/legacy-census.node' : nativeAddon) : '',
    RETAINED_NATIVE_CENSUS_TRANSPORT_URL: nativeMode ? new URL('../../legacy-engine-checkpoint.mjs', import.meta.url).href : '',
  };
  const fixtureArgs = [join(serverDependencies, 'vitest/vitest.mjs'), 'run',
    ...CASES.map((name) => 'src/engine/' + name), '--cache=false', '--reporter=json',
    ...(nativeMode ? ['--testNamePattern=whole guard uses actual EED owners: detached-(drained|job-during-await)$'] : [])];
  let output;
  if (nativeImage) {
    const container = `eed-native-guard-${process.pid}`;
    const nativeScratch = join(folder, 'native-tmp');
    mkdirSync(nativeScratch);
    // Locked Vite bundles its config beside the input before loading it.
    // Keep historical inputs read-only; only the byte-exact config copy and
    // generated bundle live in owned scratch. Its relative source stays RO.
    const nativeConfig = join(nativeScratch, 'vitest.config.ts');
    copyFileSync(join(server, 'vitest.config.ts'), nativeConfig);
    symlinkSync(join(server, 'src'), join(nativeScratch, 'src'), 'dir');

    try {
      output = run('docker', ['run', '--rm', '--name', container, '--network', 'none',
        '--memory', '2g', '--memory-swap', '2g', '--read-only',
        '--mount', `type=bind,src=${ROOT},dst=${ROOT},readonly`,
        '--mount', `type=bind,src=${serverDependencies},dst=${serverDependencies},readonly`,
        '--mount', `type=bind,src=${folder},dst=${folder},readonly`,
        '--mount', `type=bind,src=${nativeScratch},dst=${nativeScratch}`,
        '--workdir', server, '--env', `TMPDIR=${nativeScratch}`,
        '--env', 'SUPABASE_URL=https://supabase.invalid',
        '--env', 'SUPABASE_SERVICE_ROLE_KEY=unit-test-placeholder-key',
        ...Object.entries(fixtureEnv).flatMap(([key, value]) => ['--env', `${key}=${value}`]),
        '--entrypoint', 'node', nativeImage, '--max-old-space-size=512', ...fixtureArgs,
        '--config', nativeConfig], server, 60000);
    } finally {
      // An expired Docker client is not evidence that its child stopped.
      spawnSync('docker', ['rm', '--force', container], { timeout:5000, encoding:'utf8' });
      const state = spawnSync('docker', ['inspect', container], { timeout:5000, encoding:'utf8' });
      need(!state.error && state.status === 1 && /No such (?:container|object)/i.test(state.stderr ?? ''),
        'native guard fixture cleanup unconfirmed');
    }
  } else output = run(process.execPath, fixtureArgs, server, nativeMode ? 60000 : 120000, fixtureEnv);
  const start = output.indexOf('{');
  need(start >= 0, 'native fixture result unavailable');
  const result = JSON.parse(output.slice(start));
  need(
    result.success === true &&
      result.numTotalTests === (nativeMode ? 25 : 33) &&
      result.numPassedTests === (nativeMode ? 2 : 33) &&
      (!nativeMode || result.numPendingTests === 23) &&
      result.numFailedTests === 0,
    nativeMode ? 'both actual native census/EED guard cases must pass' : 'all thirty-three exact EED fixture cases must actually pass'
  );
  need(
    hash(readFileSync(guardPath)) === hash(guardBytes),
    'guard pins changed during qualification'
  );
  need(
    performance.now() < qualificationDeadline,
    'historical qualification total budget exhausted'
  );
  console.log(
    JSON.stringify(
      {
        schema: nativeMode ? 'exact-eed-native-census-guard-qualification/v1' : 'exact-eed-checkpoint-qualification/v1',
        nativeImage: nativeImage ?? null,
        nativeAddon: nativeAddon ?? null,
        readOnlyProduction: true,
        historicalRevision: EED,
        guardSha256: hash(guardBytes),
        pins: actualPins,
        fixtures: CASES.map((name) => ({ name, sha256: hash(readFileSync(join(HERE, name))) })),
        actualTests: result.numTotalTests,
        passedTests: result.numPassedTests,
        skippedTests: result.numPendingTests,
        ...(nativeMode ? {cases: result.testResults.flatMap(row => row.assertionResults)
          .filter(row => row.status !== 'skipped').map(row => ({name:row.fullName,status:row.status}))} : {}),
        status: 'passed',
        limitation: nativeMode ? 'isolated native census and historical guard; no production invocation' :
          'isolated historical native behavior; no production or checkpoint invocation',
      },
      null,
      2
    )
  );
} finally {
  rmSync(folder, { recursive: true, force: true });
}
