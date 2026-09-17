import { fork, execFileSync, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { expect, it } from 'vitest';

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

it('verifies the Linux inherited-priority boundary with explicit remaining qualification limits', async () => {
  expect(process.platform).toBe('linux');
  expect(Number(process.versions.node.split('.')[0])).toBe(22);
  const serverRoot = fileURLToPath(new URL('../../', import.meta.url));
  const candidateRoot = fileURLToPath(new URL('../', import.meta.url));
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
  const outputDirectory = mkdtempSync(join(tmpdir(), 'ca-cpu40752-'));
  const runtimePaths = [
    'HorseLeagueComputeWorkerClient.ts',
    'HorseLeagueComputeProcess.ts',
    'HorseLeagueComputeWorker.ts',
    'HorseLeagueComputeProtocol.ts',
    'HorseLeagueProcessPriority.ts',
    'HorseLeagueComputeWorker.test.ts',
    'HorseLeagueProcessPriority.test.ts',
    'HorseLeagueComputeProcessBoundary.test.ts',
  ].map((name) => `benchmark/${name}`);
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
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', NODE_ENV: 'test', EQUITY_GOVERNOR: 'off' },
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
        150_000
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
}, 170_000);
