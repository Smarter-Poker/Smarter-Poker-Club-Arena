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

function runGate(jobs: Job[], conclusion = ''): { output: string; error: string | null } {
  const dir = mkdtempSync(join(tmpdir(), 'post-deploy-gate-'));
  try {
    const payload = join(dir, 'jobs.json');
    const output = join(dir, 'output');
    writeFileSync(payload, JSON.stringify({ total_count: jobs.length, jobs }));
    writeFileSync(output, '');
    try {
      execFileSync(process.execPath, ['-', payload, output], {
        input: program,
        stdio: 'pipe',
        env: { ...process.env, SOURCE_CONCLUSION: conclusion },
      });
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
      'Activate only the prepared independent service',
      'Verify authenticated gateway record delivery',
      'Ensure the reserved gateway canary account is retired',
    ].map((name) => ({ name, status: 'completed', conclusion: 'success' }));
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

describe('read-only gateway inspection is not publication', () => {
  it.each(['success', 'failure'])(
    'preserves the actual %s result without certifying a client',
    (conclusion) => {
      const inspection = job('inspect-record-gateway-host', conclusion);
      inspection.steps = [
        {
          name: 'Read fixed gateway host metadata without changing host state',
          status: 'completed',
          conclusion,
        },
      ];
      const result = runGate([
        job('publish-needed', 'success', 8),
        inspection,
        job('publish-to-origin', 'skipped'),
      ]);
      expect(result.error === null).toBe(conclusion === 'success');
      expect(result.output).not.toContain('should_run=true');
    }
  );
});

describe('gateway certification requires its real consumer proof and cleanup', () => {
  it.each([
    'Verify authenticated gateway record delivery',
    'Ensure the reserved gateway canary account is retired',
  ])('refuses a missing %s step', (missing) => {
    const gateway = job('publish-record-gateway', 'success');
    gateway.steps = [
      'Activate only the prepared independent service',
      'Verify authenticated gateway record delivery',
      'Ensure the reserved gateway canary account is retired',
    ]
      .filter((name) => name !== missing)
      .map((name) => ({ name, status: 'completed', conclusion: 'success' }));
    const result = runGate([
      job('publish-needed', 'success', 8),
      job('build-record-gateway', 'success'),
      gateway,
      job('publish-to-origin', 'skipped'),
    ]);
    expect(result.error).not.toBeNull();
    expect(result.output).not.toContain('should_run=true');
  });
});

describe('exact protected transaction publisher display names', () => {
  const published = (name: string) => ({
    ...job(name, 'success'),
    steps: [
      'Stand down if the origin already serves a newer bundle',
      'Publish through the host-owned immutable transaction',
      'Verify the origin serves this bundle',
    ].map((name) => ({ name, status: 'completed', conclusion: 'success' })),
  });
  it.each([
    'publish-to-origin',
    'production / publish-to-origin',
    'client-publication / production / publish-to-origin',
  ])('accepts the protected origin proof named %s', (name) => {
    const r = runGate([published(name)]);
    expect(r.error).toBeNull();
    expect(r.output).toContain('should_run=true');
  });
  it.each(['cancelled', 'failure', 'success', 'unknown'])(
    'keeps proven web publication independent of the %s run summary',
    (conclusion) => {
      const r = runGate([published('production / publish-to-origin')], conclusion);
      expect(r.error).toBeNull();
      expect(r.output).toContain('should_run=true');
    }
  );
  it('requires the real nested origin proof step to succeed', () => {
    const origin = published('client-publication / production / publish-to-origin');
    origin.steps[2].conclusion = 'failure';
    const result = runGate([origin]);
    expect(result.error).not.toBeNull();
    expect(result.output).not.toContain('should_run=true');
  });
  it.each(['success', 'failure'])(
    'reads nested runtime retention without hiding a %s verdict',
    (conclusion) => {
      const retained = job('client-publication / production / retain-runtime', conclusion);
      retained.steps = [
        'Verify both origins still serve the qualified immutable runtime',
        'Record qualified retained runtime',
      ].map((name) => ({ name, status: 'completed', conclusion }));
      const result = runGate([
        retained,
        job('client-publication / production / publish-to-origin', 'skipped'),
      ]);
      expect(result.error === null).toBe(conclusion === 'success');
      expect(result.output.includes('should_run=true')).toBe(conclusion === 'success');
    }
  );
  it('refuses foreign prefixes and ambiguous logical origin proofs', () => {
    for (const jobs of [
      [published('foreign / publish-to-origin')],
      [published('foreign / client-publication / production / publish-to-origin')],
      [published('client-publication / production / publish-to-origin extra')],
      [
        published('production / publish-to-origin'),
        published('client-publication / production / publish-to-origin'),
      ],
      [published('production / publish-to-origin'), published('publish-to-origin')],
    ])
      expect(runGate(jobs).error).not.toBeNull();
  });
});

describe('superseded preparation never certifies a release', () => {
  const prepared = () => [
    job('publish-needed', 'success'),
    ...tests(),
    job('build-and-store', 'success'),
    job('build-record-gateway', 'skipped'),
  ];
  it('stands down only for cancelled, complete read-only preparation with no transaction child', () => {
    for (const list of [prepared(), [...prepared(), job('production', 'cancelled')]]) {
      const r = runGate(list, 'cancelled');
      expect(r.error).toBeNull();
      expect(r.output).not.toContain('should_run=true');
    }
  });
  it('refuses failed preparation, unknown jobs, duplicate roles and started or renamed transaction children', () => {
    for (const list of [
      [...prepared(), job('renamed-origin', 'success')],
      [...prepared(), job('production / renamed-origin', 'success')],
      [...prepared(), job('production', 'cancelled', 1)],
      [...prepared(), job('publish-needed', 'success')],
      [...prepared(), job('client-tests (1)', 'failure')],
    ])
      expect(runGate(list, 'cancelled').error).not.toBeNull();
    for (const conclusion of ['', 'success', 'failure', 'unknown'])
      expect(runGate(prepared(), conclusion).error).not.toBeNull();
  });
});
