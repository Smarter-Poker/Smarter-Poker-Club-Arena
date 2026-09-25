import { fork, execFileSync, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { expect, it } from 'vitest';

import { sliceYamlBlock } from '../testHelpers/sourceWindow.js';

const requiredCases = [
  'original scalar READY negative control',
  'candidate default factory and PID-bound READY',
  'direct candidate launch refuses before READY',
  'direct Worker entry cannot substitute for bootstrap proof',
  'independent unprivileged priority denial and fail-closed bootstrap',
  'advanced IPC and later libuv threads',
  'fixed-allocation CPU and actual GC observation',
  'missing launcher spawn failure has a real close receipt',
  'nonexecutable launcher refuses without fallback',
  'unexpected signal exit before READY',
  'unexpected signal exit after READY',
  'pre-READY waiters reject while repeated shutdown joins TERM-to-KILL',
];
const conditionalCase = 'independent unprivileged priority denial and fail-closed bootstrap';

// ---------------------------------------------------------------------------
// WHY THIS CASE IS GATED, AND WHAT STOPS THE GATE FROM SWALLOWING IT.
//
// This one is not arithmetic. It forks a real child under a real inherited
// nice, reads real /proc/<tid>/stat, and pins a real Node 22 runtime hash.
// There is no honest way to run it on macOS, and the file used to say so with
// `expect(process.platform).toBe('linux')` - which reports "this host cannot
// answer the question" as "the HORSE priority boundary is broken", on every
// developer machine, every time. Fifteen more of those lived in the unit file
// next door; between them they were the whole of this benchmark's red.
//
// The instinct behind that line was right, though, and it is kept: a
// qualification that can be skipped quietly is a qualification that stops
// running. So the gate below is paired with UNCONDITIONAL cases that run
// everywhere - one reads .github/workflows/ci.yml and fails if the job that
// runs this suite ever stops being a Linux Node 22 runner, the other proves
// every file the qualification hashes is still where it says it is. Skipping
// is therefore only ever local: the moment CI could skip this, the build goes
// red and names the workflow that did it.
// ---------------------------------------------------------------------------
const QUALIFICATION_HOST = { platform: 'linux', nodeMajor: 22 } as const;
const hostQualifies =
  process.platform === QUALIFICATION_HOST.platform &&
  Number(process.versions.node.split('.')[0]) === QUALIFICATION_HOST.nodeMajor;

// ONE number, and a margin derived from it. The deadline this test imposes on
// the forked fixture and the ceiling vitest kills this test at used to be two
// unrelated literals, 150_000 and 170_000, free to drift into the shape
// src/testing/waitBudget.ts was written about: a wait handed exactly the
// ceiling it lives under, which dies anonymously instead of saying what it was
// waiting for. They are now the same budget plus a fixed diagnostic margin, so
// the gap cannot close by accident. This file legitimately runs past the global
// TEST_TIMEOUT_MS because it supervises a forked qualification rather than an
// engine event, which is why the pair is pinned here and asserted below.
const FIXTURE_DEADLINE_MS = 150_000;
const FIXTURE_DIAGNOSTIC_MARGIN_MS = 20_000;
const FIXTURE_CEILING_MS = FIXTURE_DEADLINE_MS + FIXTURE_DIAGNOSTIC_MARGIN_MS;

const serverRoot = fileURLToPath(new URL('../../', import.meta.url));
const candidateRoot = fileURLToPath(new URL('../', import.meta.url));
const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url));
const qualifier = fileURLToPath(
  new URL(
    '../../../scripts/qualification/horse-league-process-priority-native.mjs',
    import.meta.url
  )
);
const fixture = fileURLToPath(
  new URL(
    '../../../scripts/qualification/fixtures/horse-league-process-priority/child.mjs',
    import.meta.url
  )
);
const runtimePaths = [
  'HorseLeagueComputeWorkerClient.ts',
  'HorseLeagueComputeProcess.ts',
  'HorseLeagueComputeWorker.ts',
  'HorseLeagueComputeProtocol.ts',
  'HorseLeagueProcessPriority.ts',
  'HorseLeagueComputeWorker.test.ts',
  'HorseLeagueProcessPriority.test.ts',
  'HorseLeagueComputeProcessBoundary.test.ts',
]
  .map((name) => `benchmark/${name}`)
  .concat('hub/ChannelHub.ts');
const sha = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function groupExists(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
}

async function finishIsolatedGroup(child: ChildProcess): Promise<void> {
  if (!child.pid || !groupExists(child.pid)) return;
  // This process group belongs only to this finite fixture. Production fork
  // arguments remain unchanged/non-detached. A timeout never means termination.
  process.kill(-child.pid, 'SIGTERM');
  await delay(5_000);
  if (groupExists(child.pid)) {
    process.kill(-child.pid, 'SIGKILL');
    await delay(1_000);
  }
  if (groupExists(child.pid))
    throw new Error('isolated CPU40752 fixture group termination is unconfirmed');
}

it.runIf(hostQualifies)(
  'verifies the Linux inherited-priority boundary with explicit remaining qualification limits',
  async () => {
    const outputDirectory = mkdtempSync(join(tmpdir(), 'ca-cpu40752-'));
    const sourceRevision = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: serverRoot,
      encoding: 'utf8',
      timeout: 5_000,
    }).trim();
    const request = {
      executionId: randomUUID(),
      sourceRevision,
      candidateRoot,
      outputDirectory,
      candidateFiles: runtimePaths.map((path) => ({
        path,
        sha256: sha(readFileSync(join(candidateRoot, path))),
      })),
      fixtureFiles: { qualifier: sha(readFileSync(qualifier)), child: sha(readFileSync(fixture)) },
    };
    const requestPath = join(outputDirectory, 'request.json');
    writeFileSync(requestPath, JSON.stringify(request), { flag: 'wx', mode: 0o600 });
    // Reuse the exact public tsx registration API already used by the existing
    // worker parity test; inherited --import reaches the actual default factory.
    const tsxApi = pathToFileURL(createRequire(import.meta.url).resolve('tsx/esm/api')).href;
    const loader = `data:text/javascript,${encodeURIComponent(`import { register } from ${JSON.stringify(tsxApi)}; register();`)}`;
    let child: ChildProcess | undefined;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    let stdout = '';
    let stderr = '';
    let outputExceeded = false;
    let receiptLogged = false;
    try {
      child = fork(qualifier, [requestPath], {
        cwd: serverRoot,
        execArgv: ['--import', loader],
        env: {
          PATH: process.env.PATH ?? '/usr/bin:/bin',
          NODE_ENV: 'test',
          EQUITY_GOVERNOR: 'off',
        },
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        detached: true,
      });
      const capture = (chunk: Buffer, current: string): string => {
        if (Buffer.byteLength(current) + chunk.length > 262_144) {
          outputExceeded = true;
          return current;
        }
        return current + chunk.toString('utf8');
      };
      child.stdout!.on('data', (chunk: Buffer) => {
        stdout = capture(chunk, stdout);
      });
      child.stderr!.on('data', (chunk: Buffer) => {
        stderr = capture(chunk, stderr);
      });
      const terminal = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
        (resolve, reject) => {
          child!.once('error', reject);
          child!.once('exit', (code, signal) => resolve({ code, signal }));
        }
      );
      const bounded = new Promise<never>((_, reject) => {
        deadline = setTimeout(
          () => reject(new Error('CPU40752 finite fixture deadline; terminal outcome unknown')),
          FIXTURE_DEADLINE_MS
        );
      });
      const outcome = await Promise.race([terminal, bounded]);
      clearTimeout(deadline);
      expect(outputExceeded, 'fixture output cap').toBe(false);
      expect(outcome, `${stdout}\n${stderr}`).toEqual({ code: 0, signal: null });
      const result = JSON.parse(
        readFileSync(join(outputDirectory, 'horse-league-process-priority-results.json'), 'utf8')
      );
      // The complete sanitized receipt enters the existing hosted test log. It
      // states its narrow scope and retains every unavailable proof explicitly.
      console.info('CPU40752_SCOPED_PROCESS_RECEIPT', JSON.stringify({ request, result }));
      receiptLogged = true;
      expect(result.executionId).toBe(request.executionId);
      expect(result.sourceRevision).toBe(sourceRevision);
      expect(result.status).toBe('SCOPED_CONTROLS_PASSED_LIMITS_REMAIN');
      expect(result.cases.map((entry: { name: string }) => entry.name)).toEqual(requiredCases);
      for (const entry of result.cases) {
        if (entry.name === conditionalCase && entry.status === 'CONTROL_UNAVAILABLE') {
          expect(entry.evidence.unsupported).toBe(true);
          expect(result.remainingQualificationLimits).toContain(entry.evidence.limitation);
        } else expect(entry.status, entry.name).toBe('CONTROL_PASSED');
      }
      expect(result.remainingQualificationLimits.length).toBeGreaterThan(0);
      expect(result.parent.finalNice).toBe(result.parent.nice);
      expect(result.runtimeAfter.nodeSha256).toBe(result.runtime.nodeSha256);
      expect(result.runtimeAfter.niceSha256).toBe(result.runtime.niceSha256);
      expect(result.sourceFiles).toEqual(request.candidateFiles);
      expect(result.cleanup.length).toBeGreaterThan(0);
      expect(result.cleanup.every((entry: { confirmed: boolean }) => entry.confirmed)).toBe(true);
      expect(result.supervisorCleanup).toEqual({ parityChannelHubClosed: true });
      expect(
        child.pid && groupExists(child.pid),
        'no owned process remains after successful receipt'
      ).toBe(false);
    } finally {
      clearTimeout(deadline);
      let groupConfirmedTerminal = false;
      try {
        if (child) await finishIsolatedGroup(child);
        groupConfirmedTerminal = true;
      } finally {
        const resultPath = join(outputDirectory, 'horse-league-process-priority-results.json');
        if (!receiptLogged && existsSync(resultPath)) {
          // Preserve failed/inconclusive case evidence in the same hosted log.
          console.info(
            'CPU40752_PARTIAL_PROCESS_RECEIPT',
            JSON.stringify({
              request,
              result: JSON.parse(readFileSync(resultPath, 'utf8')),
            })
          );
        }
        if (groupConfirmedTerminal) rmSync(outputDirectory, { recursive: true, force: true });
        else console.error('CPU40752_UNCONFIRMED_GROUP_EVIDENCE_RETAINED', outputDirectory);
      }
    }
  },
  FIXTURE_CEILING_MS
);

// ---------------------------------------------------------------------------
// THE TWO CASES ABOVE THE GATE. These run on every host, including the ones
// that cannot fork the qualification, because they are what make the gate safe
// to have.
// ---------------------------------------------------------------------------

it('the fixture deadline fits under the ceiling that kills this test', () => {
  // Same law as src/testing/waitBudget.ts, applied to this file's own pair:
  // a bounded wait needs room to throw its diagnostic before vitest kills the
  // test, or CI prints a timeout that names nothing. Derived from one number,
  // so the only way to change the gap is to change the margin on purpose.
  expect(FIXTURE_CEILING_MS).toBeGreaterThan(FIXTURE_DEADLINE_MS);
  expect(
    FIXTURE_CEILING_MS - FIXTURE_DEADLINE_MS,
    'the fixture deadline needs headroom under the ceiling to report its own failure'
  ).toBeGreaterThanOrEqual(5_000);
});

it('every file the qualification hashes is still where the request says it is', () => {
  // The gated case reads each of these with readFileSync to build its request,
  // so a rename turns into an ENOENT that only a Linux host would ever see.
  // Checking existence unconditionally means a rename is caught by whoever
  // makes it, on whatever machine they are sitting at.
  const missing = [
    ...runtimePaths.map((path) => join(candidateRoot, path)),
    qualifier,
    fixture,
  ].filter((path) => !existsSync(path));
  expect(
    missing,
    'the CPU40752 qualification hashes these paths; a rename here fails the fork ' +
      'on Linux only, long after the commit that caused it.\n' +
      missing.join('\n')
  ).toEqual([]);
});

it('CI still runs this suite on a host where the gated qualification can run', () => {
  // This is the promise the old `expect(process.platform).toBe('linux')` was
  // really making, kept in the one place it can actually be kept. A gate is
  // only honest while somewhere is still obliged to pass through it.
  const workflow = readFileSync(join(repositoryRoot, '.github/workflows/ci.yml'), 'utf8')
    .split('\n')
    .filter((line) => !line.trim().startsWith('#'))
    .join('\n');
  // Bounded by the job's own indentation, never by a byte count - see
  // ../testHelpers/sourceWindow.ts and tests/unit/noFixedSizeSourceWindows.
  const job = sliceYamlBlock(workflow, 'server_shards:');
  expect(job, 'server_shards no longer runs the server test suite').toContain('npm test --');
  expect(
    job,
    `the qualification above only runs on ${QUALIFICATION_HOST.platform}; if this job ` +
      'moves to another runner it will skip silently on every host, forever'
  ).toMatch(/runs-on:\s*ubuntu-/);
  expect(
    job,
    `the qualification above pins Node ${QUALIFICATION_HOST.nodeMajor}; a runner on any ` +
      'other major skips it silently on every host, forever'
  ).toMatch(new RegExp(`node-version:\\s*'?${QUALIFICATION_HOST.nodeMajor}'?\\s*$`, 'm'));
});
