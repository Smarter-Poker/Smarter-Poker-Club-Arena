import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * The publication gate reads the source publisher's jobs and decides whether
 * there is a production release to certify. These cases are the exact job
 * shapes GitHub returned for real publisher runs on 2026-10-17..19.
 *
 * 39275112750 was cancelled while its read-only retain-runtime job was still
 * verifying, so publish-to-origin was skipped with no steps and nothing reached
 * the origin. The gate threw "missing one of its release-verdict steps" and
 * Post-Deploy E2E 39283184506 went red without a browser ever starting.
 * A publisher whose own client tests FAILED (39253428772, 39055100292) is a
 * real publisher fault and must stay red.
 */
const workflow = parse(readFileSync('.github/workflows/post-deploy-e2e.yml', 'utf8'));
const gate = workflow.jobs['publication-gate'].steps.find(
  (s: { name?: string }) => s.name === 'Read The Origin Job Verdict'
).run as string;
const program = /<<'NODE'\n([\s\S]*?)\nNODE/.exec(gate)?.[1] ?? '';

type Job = { name: string; status: string; conclusion: string; steps: unknown[] };
const job = (name: string, conclusion: string, steps = 0): Job => ({
  name,
  status: 'completed',
  conclusion,
  steps: Array.from({ length: steps }, (_, i) => ({
    name: `step ${i}`,
    status: 'completed',
    conclusion,
  })),
});

function runGate(jobs: Job[]): { output: string; error: string | null } {
  const dir = mkdtempSync(join(tmpdir(), 'post-deploy-gate-'));
  try {
    const payload = join(dir, 'jobs.json');
    const output = join(dir, 'output');
    writeFileSync(payload, JSON.stringify({ total_count: jobs.length, jobs }));
    writeFileSync(output, '');
    try {
      execFileSync(process.execPath, ['-', payload, output], { input: program, stdio: 'pipe' });
      return { output: readFileSync(output, 'utf8'), error: null };
    } catch (error) {
      return { output: readFileSync(output, 'utf8'), error: String((error as any).stderr) };
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const tests = (conclusion = 'success') =>
  [1, 2, 3, 4].map((n) => job(`client-tests (${n})`, conclusion, 10));

describe('the publication gate and a publisher that never reached the origin', () => {
  it('has the gate program to run', () => {
    expect(program).toContain('publish-to-origin');
  });

  it('stands down when the publisher was cancelled before its origin door opened (39275112750)', () => {
    const result = runGate([
      job('publish-needed', 'success', 8),
      ...tests(),
      job('build-and-store', 'skipped'),
      job('retain-runtime', 'cancelled', 9),
      job('publish-to-origin', 'skipped'),
      job('Publish the app bundle (Capgo OTA)', 'skipped'),
    ]);
    expect(result.error).toBeNull();
    expect(result.output).not.toContain('should_run=true');
  });

  it('stands down when publish-to-origin itself was cancelled before it started', () => {
    const result = runGate([
      job('publish-needed', 'success', 8),
      ...tests(),
      job('build-and-store', 'success', 21),
      job('retain-runtime', 'skipped'),
      job('publish-to-origin', 'cancelled'),
    ]);
    expect(result.error).toBeNull();
    expect(result.output).not.toContain('should_run=true');
  });

  it('still refuses a publish-to-origin that started and was cancelled mid-transaction', () => {
    const result = runGate([
      job('publish-needed', 'success', 8),
      ...tests(),
      job('build-and-store', 'success', 21),
      job('retain-runtime', 'skipped'),
      job('publish-to-origin', 'cancelled', 4),
    ]);
    expect(result.error).not.toBeNull();
    expect(result.output).not.toContain('should_run=true');
  });

  it('still fails red when the publisher itself failed (39253428772)', () => {
    const result = runGate([
      job('publish-needed', 'success', 8),
      ...tests().slice(0, 3),
      job('client-tests (4)', 'failure', 10),
      job('build-and-store', 'skipped'),
      job('retain-runtime', 'skipped'),
      job('publish-to-origin', 'skipped'),
    ]);
    expect(result.error).not.toBeNull();
    expect(result.output).not.toContain('should_run=true');
  });

  it('still fails red when nothing was cancelled and nothing published', () => {
    const result = runGate([
      job('publish-needed', 'success', 8),
      ...tests(),
      job('build-and-store', 'success', 21),
      job('retain-runtime', 'skipped'),
      job('publish-to-origin', 'skipped'),
    ]);
    expect(result.error).not.toBeNull();
  });

  it('still fails red when the retained-runtime verification failed', () => {
    const result = runGate([
      job('publish-needed', 'success', 8),
      ...tests(),
      job('retain-runtime', 'failure', 5),
      job('publish-to-origin', 'skipped'),
      job('Publish the app bundle (Capgo OTA)', 'cancelled'),
    ]);
    expect(result.error).not.toBeNull();
  });
});

describe('a gateway component is not a static client publication', () => {
  it('leaves client certification unclaimed after a qualified gateway-only publication', () => {
    const gateway = job('publish-record-gateway', 'success');
    gateway.steps = [
      {
        name: 'Activate only the prepared independent service',
        status: 'completed',
        conclusion: 'success',
      },
    ];
    const result = runGate([
      job('publish-needed', 'success', 8),
      job('build-record-gateway', 'success', 5),
      gateway,
      job('publish-to-origin', 'skipped'),
      job('retain-runtime', 'skipped'),
    ]);
    expect(result.error).toBeNull();
    expect(result.output).not.toContain('should_run=true');
  });
  it('does not hide an incomplete gateway installation as a successful client standdown', () => {
    const result = runGate([
      job('publish-needed', 'success', 8),
      job('build-record-gateway', 'success', 5),
      job('publish-record-gateway', 'failure', 2),
      job('publish-to-origin', 'skipped'),
      job('retain-runtime', 'skipped'),
    ]);
    expect(result.error).not.toBeNull();
    expect(result.output).not.toContain('should_run=true');
  });
});
