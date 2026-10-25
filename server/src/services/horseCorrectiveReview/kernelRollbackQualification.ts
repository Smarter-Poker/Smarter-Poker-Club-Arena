/** Explicit finite synthetic rollback mechanism proof. No strategy/population
 * qualification, signer, caller report or external credentials enter the child. */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join, isAbsolute } from 'node:path';
import { lstatSync, realpathSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { evidenceDigest } from './authority.js';
import {
  correctiveKernelPolicyDigestOf,
  correctiveKernelBaselineSelectionsDigest,
} from './kernelPolicyDigest.js';

export const CORRECTIVE_ROLLBACK_VERSION = 'horse-phase14-executed-rollback-v1';
export const CORRECTIVE_ROLLBACK_FILES = Object.freeze([
  'src/engine/horseDecision/phase14Worker.test.ts',
  'src/engine/horseDecision/phase14Client.test.ts',
  'src/engine/HorsePhase14Acceptance.test.ts',
  'src/engine/horseDecision/phase14Controller.test.ts',
  'src/engine/horseDecision/phase14Replay.test.ts',
  'src/engine/horseDecision/phase14Tournament.test.ts',
]);
const REQUIRED: readonly (readonly [string, string])[] = Object.freeze([
  [
    CORRECTIVE_ROLLBACK_FILES[0]!,
    'retires captured nonempty reference plans for the actual corrective fold/call family selected=true',
  ],
  [
    CORRECTIVE_ROLLBACK_FILES[0]!,
    'retires captured nonempty reference plans for the actual corrective fold/call family selected=false',
  ],
  [CORRECTIVE_ROLLBACK_FILES[0]!, 'withdraws while queued before evaluating a correction'],
  [
    CORRECTIVE_ROLLBACK_FILES[0]!,
    'reuses the FAST original frame for DEEP and retires authority before second look',
  ],
  [
    CORRECTIVE_ROLLBACK_FILES[1]!,
    'retires a correction withdrawn while FAST_RESULT is pending at the actual IPC boundary',
  ],
  [
    CORRECTIVE_ROLLBACK_FILES[1]!,
    'retires a correction withdrawn while DEEP_RESULT is pending at the actual IPC boundary',
  ],
  [
    CORRECTIVE_ROLLBACK_FILES[2]!,
    'reselects the original baseline and updates the pending witness after withdrawal',
  ],
  [
    CORRECTIVE_ROLLBACK_FILES[2]!,
    'withdraws a candidate locally if the actual controller witness is coerced',
  ],
  [
    CORRECTIVE_ROLLBACK_FILES[3]!,
    'accepts only the authority-selected real controller action after pending IPC withdrawal=false with chips conserved',
  ],
  [
    CORRECTIVE_ROLLBACK_FILES[3]!,
    'accepts only the authority-selected real controller action after pending IPC withdrawal=true with chips conserved',
  ],
  [
    CORRECTIVE_ROLLBACK_FILES[4]!,
    'restores the recorded epoch even for applied=true, without taking authority from recorded flags',
  ],
  [
    CORRECTIVE_ROLLBACK_FILES[4]!,
    'restores the recorded epoch even for applied=false, without taking authority from recorded flags',
  ],
  [
    CORRECTIVE_ROLLBACK_FILES[4]!,
    'exactly replays the bound accepted DEEP decision with original FAST selected=false',
  ],
  [
    CORRECTIVE_ROLLBACK_FILES[4]!,
    'exactly replays the bound accepted DEEP decision with original FAST selected=true',
  ],
  [
    CORRECTIVE_ROLLBACK_FILES[5]!,
    'executes actual FAST/DEEP v2 with retained FAST hashes and selected Phase8 baseline receipt',
  ],
  [
    CORRECTIVE_ROLLBACK_FILES[5]!,
    'withdrawal of selected phase8: prevents DEEP correction using the earlier original',
  ],
  [
    CORRECTIVE_ROLLBACK_FILES[5]!,
    'withdrawal of selected phase14:nlh-spin prevents DEEP correction using the earlier original',
  ],
  [
    CORRECTIVE_ROLLBACK_FILES[5]!,
    'feeds actual accepted DEEP v2 callback bytes through SQLite fleet without claiming unobserved horses',
  ],
  [
    CORRECTIVE_ROLLBACK_FILES[5]!,
    'keeps missing original tournament capture unknown and only known nonriver geometry outside',
  ],
]);
export interface CorrectiveRollbackBinding {
  sourceRelease: string;
  policyDigest: string;
  baselineSelectionsDigest: string;
}
export interface CorrectiveKernelRollbackEvidence extends CorrectiveRollbackBinding {
  version: typeof CORRECTIVE_ROLLBACK_VERSION;
  testSourceDigest: string;
  reportDigest: string;
  rollbackDigest: string;
  mechanismOnly: true;
  effectsScope: 'fold-call-reference-plans-retired';
  replayScope: 'exact-worker-answer-and-withdrawn-controller-join';
  strategyQualified: false;
  populationQualified: false;
  activationAllowed: false;
}
const executed = new WeakSet<object>();
const object = (x: unknown): x is Record<string, unknown> =>
  !!x && typeof x === 'object' && !Array.isArray(x);
const digest = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');

/** Pure transport check only: never brands reports supplied by callers. */
export function correctiveRollbackReportIsComplete(value: unknown, serverRoot: string): boolean {
  if (
    !object(value) ||
    value.success !== true ||
    !Array.isArray(value.testResults) ||
    value.numFailedTests !== 0 ||
    value.numPendingTests !== 0 ||
    value.numTodoTests !== 0 ||
    value.numFailedTestSuites !== 0 ||
    value.testResults.length !== CORRECTIVE_ROLLBACK_FILES.length
  )
    return false;
  const found = new Set<string>();
  let count = 0;
  for (const suite of value.testResults) {
    if (
      !object(suite) ||
      suite.status !== 'passed' ||
      typeof suite.name !== 'string' ||
      !Array.isArray(suite.assertionResults) ||
      !suite.assertionResults.length
    )
      return false;
    const file = CORRECTIVE_ROLLBACK_FILES.find((file) => join(serverRoot, file) === suite.name);
    if (!file || found.has(file)) return false;
    found.add(file);
    const names = new Set<string>();
    for (const test of suite.assertionResults) {
      if (
        !object(test) ||
        test.status !== 'passed' ||
        typeof test.title !== 'string' ||
        names.has(test.title) ||
        !Array.isArray(test.failureMessages) ||
        test.failureMessages.length
      )
        return false;
      names.add(test.title);
      count++;
    }
    for (const [requiredFile, title] of REQUIRED)
      if (requiredFile === file && !names.has(title)) return false;
  }
  return (
    value.numTotalTests === count && value.numPassedTests === count && count >= REQUIRED.length
  );
}

export function isExecutedCorrectiveKernelRollback(
  value: unknown,
  expected?: CorrectiveRollbackBinding
): value is CorrectiveKernelRollbackEvidence {
  return (
    object(value) &&
    executed.has(value) &&
    (!expected ||
      (value.sourceRelease === expected.sourceRelease &&
        value.policyDigest === expected.policyDigest &&
        value.baselineSelectionsDigest === expected.baselineSelectionsDigest))
  );
}

export function executeCorrectiveKernelRollback(
  expected: CorrectiveRollbackBinding,
  scratchRoot: string
):
  | { status: 'verified_rollback_mechanism'; evidence: CorrectiveKernelRollbackEvidence }
  | { status: 'unavailable'; reason: string } {
  let temporary: string | undefined;
  const no = (reason: string) => ({ status: 'unavailable' as const, reason });
  try {
    const binding = Object.freeze({ ...expected });
    if (
      !/^[a-f0-9]{40}$/.test(binding.sourceRelease) ||
      ![binding.policyDigest, binding.baselineSelectionsDigest].every((x) =>
        /^[a-f0-9]{64}$/.test(x)
      )
    )
      return no('rollback_binding_invalid');
    const root = fileURLToPath(new URL('../../../../', import.meta.url)),
      server = join(root, 'server');
    const safeEnvironment = Object.freeze({
      PATH: '/usr/bin:/bin',
      TZ: 'UTC',
      LANG: 'C',
      EQUITY_GOVERNOR: 'off',
      SUPABASE_URL: 'https://supabase.invalid',
      SUPABASE_SERVICE_ROLE_KEY: 'rollback-offline-placeholder',
    });
    const git = (args: string[]) =>
      execFileSync('/usr/bin/git', ['--no-optional-locks', '-C', root, ...args], {
        encoding: 'utf8',
        timeout: 5000,
        maxBuffer: 128 * 1024,
        env: safeEnvironment,
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim();
    const sourceSnapshot = () => {
      if (git(['rev-parse', 'HEAD']) !== binding.sourceRelease) throw Error();
      git(['diff', '--quiet', '--no-ext-diff', 'HEAD', '--']);
      if (git(['ls-files', '--others', '--exclude-standard', '--', 'server/src'])) throw Error();
      const files = [
        ...CORRECTIVE_ROLLBACK_FILES,
        'vitest.config.ts',
        'package-lock.json',
        'src/services/horseCorrectiveReview/kernelRollbackQualification.ts',
      ];
      git(['ls-files', '--error-unmatch', ...files.map((f) => 'server/' + f)]);
      const hashes = files.map((file) => ({
        file,
        sha256: digest(readFileSync(join(server, file))),
      }));
      const policyDigest = correctiveKernelPolicyDigestOf((file) =>
        readFileSync(join(server, file))
      );
      if (
        policyDigest !== binding.policyDigest ||
        correctiveKernelBaselineSelectionsDigest() !== binding.baselineSelectionsDigest
      )
        throw Error();
      return evidenceDigest(hashes);
    };
    const testSourceDigest = sourceSnapshot();
    if (
      !isAbsolute(scratchRoot) ||
      (process.platform === 'darwin' &&
        !scratchRoot.startsWith('/Volumes/SmarterWork/agent-work/')) ||
      realpathSync(scratchRoot) !== scratchRoot
    )
      return no('rollback_scratch_invalid');
    const stat = lstatSync(scratchRoot);
    if (
      !stat.isDirectory() ||
      (stat.mode & 0o077) !== 0 ||
      (process.getuid && stat.uid !== process.getuid())
    )
      return no('rollback_scratch_invalid');
    temporary = mkdtempSync(join(scratchRoot, 'rollback-'));
    const report = join(temporary, 'report.json');
    execFileSync(
      process.execPath,
      [
        join(server, 'node_modules/vitest/vitest.mjs'),
        'run',
        ...CORRECTIVE_ROLLBACK_FILES,
        '--pool=threads',
        '--minWorkers=1',
        '--maxWorkers=1',
        '--reporter=json',
        '--outputFile=' + report,
      ],
      {
        cwd: server,
        env: { ...safeEnvironment, TMPDIR: temporary },
        timeout: 60000,
        maxBuffer: 2 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    );
    const reportStat = lstatSync(report);
    if (
      !reportStat.isFile() ||
      reportStat.isSymbolicLink() ||
      reportStat.size < 1 ||
      reportStat.size > 2 * 1024 * 1024
    )
      return no('rollback_report_bounds');
    const bytes = readFileSync(report);
    if (!correctiveRollbackReportIsComplete(JSON.parse(bytes.toString('utf8')), server))
      return no('rollback_report_incomplete');
    if (sourceSnapshot() !== testSourceDigest) return no('rollback_source_changed');
    const fields = {
      version: CORRECTIVE_ROLLBACK_VERSION as typeof CORRECTIVE_ROLLBACK_VERSION,
      ...binding,
      testSourceDigest,
      reportDigest: digest(bytes),
      mechanismOnly: true as const,
      effectsScope: 'fold-call-reference-plans-retired' as const,
      replayScope: 'exact-worker-answer-and-withdrawn-controller-join' as const,
      strategyQualified: false as const,
      populationQualified: false as const,
      activationAllowed: false as const,
    };
    const evidence = Object.freeze({ ...fields, rollbackDigest: evidenceDigest(fields) });
    executed.add(evidence);
    return { status: 'verified_rollback_mechanism', evidence };
  } catch {
    return no('rollback_execution_unavailable');
  } finally {
    if (temporary) rmSync(temporary, { recursive: true, force: true });
  }
}
