import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const all = () => ({ src: true, server: true, tests: true, phase4: true, fixture: true });
const wide =
  /^(package(-lock)?\.json|vite\.config|vitest\.config|tsconfig|\.npmrc|\.nvmrc|\.node-version|\.github\/workflows\/|scripts\/ci\/(classify-ci-changes|fixture-native-gate)\.mjs)/;
const phase4 =
  /^(\.github\/workflows\/ci\.yml|scripts\/ci\/classify-ci-changes\.mjs|scripts\/ci\/probes\/horse-phase4-certified-solver\/|supabase\/migrations\/20260909(165541|170039|170749|171644|172537|175000|180000)_|server\/src\/(benchmark\/(HorseLeague|HorseSolverAgreementV31)|engine\/(GtoDecisionContext|GtoPostflopV31|GtoV31|HorseDataLedger|HorseLogic|LiveHorseDecisionWorkerHealth|horseDecision\/)|services\/GtoPostflopV31Loader))/;
const fixture =
  /^(operations\/release\/(fixture\/|native\/|ci\/fixture-smoke\.py)|\.github\/workflows\/(ci|component-fixture-native-smoke|release-component-qualification)\.yml|scripts\/ci\/(fixture-native-gate|classify-ci-changes)\.mjs|tests\/(operations\/(fixture-|financial-|component-source-contract|native-component-semantics|fixtures\/realtime-launcher\/)|unit\/fixtureNativeCi\.test\.ts)|package(-lock)?\.json|\.npmrc|\.nvmrc|\.node-version)/;

// Spin qualification and every reviewed input use the existing accounting job.
const spinExpiry =
  /^(supabase\/components\/spin-expiry-lock-order(?:\.rollback)?\.sql$|scripts\/qualification\/spin-expiry-|scripts\/ci\/(?:test-spin-expiry-postgres\.py$|test_spin_expiry_wrapper\.py$|probes\/spin-expiry\/)|tests\/unit\/fixtureNativeCi\.test\.ts$)/;

export function classifyChangedPaths(paths) {
  if (!Array.isArray(paths) || paths.some((p) => typeof p !== 'string' || !p || p.includes('\0'))) {
    return all();
  }
  const matches = (pattern) => paths.some((p) => pattern.test(p));
  const broad = matches(wide);
  return {
    src: broad || matches(/^src\//),
    server: broad || matches(/^(server\/|supabase\/migrations\/|scripts\/dev\/)/) || matches(spinExpiry),
    tests: broad || matches(/^(tests\/|supabase\/migrations\/|server\/|scripts\/dev\/)/) || matches(spinExpiry),
    phase4: matches(phase4),
    fixture: matches(fixture),
  };
}

export function classifyGitChanges({ cwd, base, head }) {
  const uncertain = () => ({
    complete: false,
    reason: 'immutable_git_diff_unavailable',
    flags: all(),
  });
  if (![base, head].every((sha) => typeof sha === 'string' && /^[0-9a-f]{40}$/.test(sha)))
    return uncertain();
  const git = (...args) =>
    execFileSync('git', args, {
      cwd,
      maxBuffer: 16 * 1024 * 1024,
      timeout: 30000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  try {
    if (git('rev-parse', 'HEAD').toString().trim() !== head) return uncertain();
    for (const sha of [base, head]) git('cat-file', '-e', `${sha}^{commit}`);
    // Multiple merge bases, missing shallow history or failed enumeration are
    // uncertainty, never evidence that the fixture did not change.
    const mergeBase = git('merge-base', '--all', base, head).toString().trim();
    if (!/^[0-9a-f]{40}$/.test(mergeBase)) return uncertain();
    // Disabling rename detection deliberately emits both deleted old and added
    // new paths. NUL framing preserves whitespace/newlines and has no API cap.
    const bytes = git('diff', '--name-only', '--no-renames', '-z', `${mergeBase}..${head}`, '--');
    const decoded = bytes.toString('utf8');
    if (!Buffer.from(decoded, 'utf8').equals(bytes) || (bytes.length && !decoded.endsWith('\0')))
      return uncertain();
    const paths = bytes.length ? decoded.slice(0, -1).split('\0') : [];
    if (
      paths.some((p) => !p || p.startsWith('/') || p.split('/').includes('..')) ||
      new Set(paths).size !== paths.length
    )
      return uncertain();
    return { complete: true, base, head, mergeBase, paths, flags: classifyChangedPaths(paths) };
  } catch {
    return uncertain();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const result = classifyGitChanges({
    cwd: process.cwd(),
    base: process.env.CI_BASE_SHA,
    head: process.env.CI_HEAD_SHA,
  });
  if (!result.complete)
    console.log('::notice::Immutable changed-file evidence unavailable; running every suite.');
  else console.log(`Classified ${result.paths.length} paths from exact base/head Git commits.`);
  appendFileSync(
    process.env.GITHUB_OUTPUT,
    Object.entries(result.flags)
      .map(([key, value]) => `${key}=${value}\n`)
      .join('')
  );
}
