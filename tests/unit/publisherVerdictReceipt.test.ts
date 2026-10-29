import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createReceipt,
  mergePublisherReceipt,
  receiptName,
  validateReceipt,
  PROOFS,
} from '../../scripts/ci/publisher-verdict-receipt.mjs';
const sha = 'a'.repeat(40);
const selected = 'b'.repeat(40);
const repository = 'Smarter-Poker/Smarter-Poker-Club-Arena';
function env(job = 'publish-to-origin', verdict = 'publish') {
  return {
    GITHUB_JOB: job,
    GITHUB_REPOSITORY: repository,
    GITHUB_REPOSITORY_ID: '1132369872',
    GITHUB_WORKFLOW_REF: `${repository}/.github/workflows/publish-club-arena.yml@refs/heads/main`,
    GITHUB_WORKFLOW_SHA: sha,
    GITHUB_SHA: sha,
    GITHUB_RUN_ID: '123',
    GITHUB_RUN_ATTEMPT: '1',
    RECEIPT_SELECTED_SHA: selected,
    RECEIPT_RUNTIME_SHA: verdict === 'publish' ? selected : sha,
    RECEIPT_VERDICT: verdict,
    RECEIPT_VERIFIED_SHA: verdict === 'publish' ? selected : '',
    RECEIPT_OUTCOMES: JSON.stringify(
      job === 'retain-runtime'
        ? ['success', 'success']
        : verdict === 'publish'
          ? ['success', 'success', 'success']
          : ['success', 'skipped', 'skipped']
    ),
    RECEIPT_CONCLUSIONS: JSON.stringify(
      job === 'retain-runtime'
        ? ['success', 'success']
        : verdict === 'publish'
          ? ['success', 'success', 'success']
          : ['success', 'skipped', 'skipped']
    ),
  };
}
function trusted(jobKey = 'publish-to-origin') {
  return {
    repositoryId: '1132369872',
    triggerSha: sha,
    workflowSha: sha,
    run: {
      id: 123,
      run_attempt: 1,
      status: 'completed',
      conclusion: 'success',
      head_branch: 'main',
      head_sha: sha,
      path: '.github/workflows/publish-club-arena.yml',
      repository: { id: 1132369872, full_name: repository },
    },
    job: {
      id: 456,
      run_id: 123,
      run_attempt: 1,
      name: jobKey,
      status: 'completed',
      conclusion: 'success',
      head_sha: sha,
      steps: [] as any[],
    },
    artifact: {
      id: 789,
      expired: false,
      name: receiptName(jobKey, 1),
      workflow_run: {
        id: 123,
        repository_id: 1132369872,
        head_repository_id: 1132369872,
        head_sha: sha,
        head_branch: 'main',
      },
    },
  };
}
describe('original publisher verdict receipt', () => {
  it.each([
    ['publish-to-origin', 'publish'],
    ['publish-to-origin', 'standdown'],
    ['retain-runtime', 'retained'],
  ])('preserves actual %s %s conclusions', (job, verdict) => {
    const receipt = createReceipt(env(job, verdict));
    const merged = mergePublisherReceipt(receipt, trusted(job));
    expect(merged.steps).toEqual(receipt.steps);
    expect(merged.steps.map((s: any) => s.name)).toEqual(PROOFS[job]);
    expect(trusted(job).job.steps).toEqual([]);
  });
  it.each([
    ['publish-to-origin', 'publish'],
    ['publish-to-origin', 'standdown'],
    ['retain-runtime', 'retained'],
  ])('executes the maintained %s %s producer shell with actual bound outputs', (job, verdict) => {
    const dir = mkdtempSync(join(tmpdir(), 'publisher-verdict-wiring-'));
    try {
      const workflow = parse(
        readFileSync('.github/workflows/publish-club-arena-transaction.yml', 'utf8')
      );
      const writer = workflow.jobs[job].steps.find(
        (s: any) =>
          s.name ===
          (job === 'retain-runtime'
            ? 'Preserve original retained runtime verdict evidence'
            : 'Preserve original publisher verdict evidence')
      );
      const e: any = env(job, verdict);
      const results = JSON.parse(e.RECEIPT_OUTCOMES);
      const ids =
        job === 'retain-runtime'
          ? ['retained_verified', 'retained_recorded']
          : ['verdict', 'immutable_publish', 'verified'];
      const bindings: Record<string, string> = {
        'inputs.target_sha': selected,
        'steps.verdict.outputs.verdict': verdict,
        'steps.verified.outputs.sha': e.RECEIPT_VERIFIED_SHA,
        'steps.verdict.outputs.theirs': sha,
      };
      ids.forEach((id, i) => {
        bindings['steps.' + id + '.outcome'] = results[i];
        bindings['steps.' + id + '.conclusion'] = results[i];
      });
      for (const [key, expression] of Object.entries(writer.env)) {
        let text = String(expression);
        if (text.includes(" == 'publish'")) text = e.RECEIPT_RUNTIME_SHA;
        else if (text.includes('format(')) {
          const tokens = text.match(/steps\.[a-z_]+\.(?:outcome|conclusion)/g)!;
          text = JSON.stringify(tokens.map((token) => bindings[token]));
        } else
          text = text.replace(/\$\{\{ ([^}]+) \}\}/g, (_: string, token: string) => {
            if (!(token in bindings)) throw new Error('Unqualified producer binding: ' + token);
            return bindings[token];
          });
        e[key] = text;
      }
      writeFileSync(join(dir, 'retained-runtime.json'), JSON.stringify({ runtimeSha: sha }));
      const isolated = Object.fromEntries(
        Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))
      );
      const command = writer.run.replaceAll(
        'scripts/ci/publisher-verdict-receipt.mjs',
        join(process.cwd(), 'scripts/ci/publisher-verdict-receipt.mjs')
      );
      const result = spawnSync('bash', ['--noprofile', '--norc', '-c', command], {
        cwd: dir,
        env: { ...isolated, ...e },
        encoding: 'utf8',
        timeout: 5000,
      });
      expect(result.status, result.stderr).toBe(0);
      const receipt = JSON.parse(readFileSync(join(dir, 'publisher-verdict.json'), 'utf8'));
      expect(receipt).toEqual(createReceipt(e));
      expect(mergePublisherReceipt(receipt, trusted(job)).steps).toEqual(receipt.steps);
      const consumer = parse(readFileSync('.github/workflows/post-deploy-e2e.yml', 'utf8'));
      const gate = consumer.jobs['publication-gate'].steps.find(
        (s: any) => s.name === 'Read The Origin Job Verdict'
      ).run;
      const program = /<<'NODE'\n([\s\S]*?)\nNODE/.exec(gate)?.[1];
      expect(program).toBeDefined();
      const proof = mergePublisherReceipt(receipt, trusted(job));
      const jobs =
        job === 'retain-runtime'
          ? [
              proof,
              { name: 'publish-to-origin', status: 'completed', conclusion: 'skipped', steps: [] },
            ]
          : [proof];
      const payloadPath = join(dir, 'jobs.json'),
        outputPath = join(dir, 'output');
      writeFileSync(payloadPath, JSON.stringify({ total_count: jobs.length, jobs }));
      writeFileSync(outputPath, '');
      execFileSync(process.execPath, ['-', payloadPath, outputPath], {
        input: program,
        env: isolated,
      });
      expect(readFileSync(outputPath, 'utf8')).toBe(
        job === 'retain-runtime' ? 'should_run=true\nretained=true\n' : 'should_run=true\n'
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('writes actual validated JSON once and refuses overwriting the same attempt', () => {
    const dir = mkdtempSync(join(tmpdir(), 'publisher-verdict-test-'));
    try {
      const path = join(dir, 'receipt.json');
      const command = ['scripts/ci/publisher-verdict-receipt.mjs', 'write', path];
      execFileSync(process.execPath, command, { env: { ...process.env, ...env() } });
      expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(createReceipt(env()));
      expect(() =>
        execFileSync(process.execPath, command, {
          env: { ...process.env, ...env() },
          stdio: 'pipe',
        })
      ).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('preserves an earlier successful origin attempt after an optional rerun failure', () => {
    const t = trusted();
    t.run.run_attempt = 2;
    t.run.conclusion = 'failure';
    expect(mergePublisherReceipt(createReceipt(env()), t).steps).toHaveLength(3);
  });
  it.each(['failure', 'cancelled', 'timed_out', 'action_required', undefined])(
    'never substitutes optional whole-run conclusion %s for the verified origin job',
    (conclusion) => {
      const t = trusted();
      expect(
        mergePublisherReceipt(createReceipt(env()), {
          ...t,
          run: { ...t.run, conclusion },
        }).steps
      ).toHaveLength(3);
    }
  );
  it('preserves completed origin proof after later optional cancellation', () => {
    const t = trusted();
    t.run.conclusion = 'cancelled';
    expect(mergePublisherReceipt(createReceipt(env()), t).steps).toHaveLength(3);
  });
  it('refuses untrusted branch, workflow and replayed artifact attempt', () => {
    const receipt = createReceipt(env());
    for (const change of [
      (t: ReturnType<typeof trusted>) => {
        t.run.head_branch = 'feature';
      },
      (t: ReturnType<typeof trusted>) => {
        t.run.path = '.github/workflows/other.yml';
      },
      (t: ReturnType<typeof trusted>) => {
        t.artifact.name = receiptName('publish-to-origin', 2);
      },
      (t: ReturnType<typeof trusted>) => {
        t.run.status = 'in_progress';
      },
    ]) {
      const t = trusted();
      change(t);
      expect(() => mergePublisherReceipt(receipt, t)).toThrow();
    }
  });
  it('never overwrites matching nonempty metadata', () => {
    const r = createReceipt(env());
    const t = trusted();
    t.job.steps = r.steps;
    expect(mergePublisherReceipt(r, t)).toBe(t.job);
  });
  it.each(['failure', 'cancelled', '', 'unknown'])(
    'refuses an actual original step conclusion %s',
    (status) => {
      const e = env();
      e.RECEIPT_CONCLUSIONS = JSON.stringify(['success', status, 'success']);
      expect(() => createReceipt(e)).toThrow();
    }
  );
  it.each(['run', 'job', 'artifact', 'repo', 'trigger', 'workflow', 'attempt', 'expired', 'fork'])(
    'refuses foreign or ambiguous %s ownership',
    (kind) => {
      const t = trusted();
      if (kind === 'run') t.run.id = 999;
      if (kind === 'job') t.job.conclusion = 'failure';
      if (kind === 'artifact') t.artifact.workflow_run.id = 999;
      if (kind === 'repo') t.run.repository.id = 999;
      if (kind === 'trigger') t.triggerSha = selected;
      if (kind === 'workflow') t.workflowSha = selected;
      if (kind === 'attempt') t.job.run_attempt = 2;
      if (kind === 'expired') t.artifact.expired = true;
      if (kind === 'fork') t.artifact.workflow_run.head_repository_id = 999;
      expect(() => mergePublisherReceipt(createReceipt(env()), t)).toThrow();
    }
  );
  it.each(['duplicate', 'conflicting'])(
    'refuses %s nonempty proof instead of filling it',
    (kind) => {
      const r = createReceipt(env());
      const t = trusted();
      t.job.steps =
        kind === 'duplicate'
          ? [...r.steps, r.steps[0]]
          : r.steps.map((s: any, i: number) => (i ? s : { ...s, conclusion: 'failure' }));
      expect(() => mergePublisherReceipt(r, t)).toThrow();
    }
  );
  it('refuses unknown fields, malformed sources and an invalid named proof', () => {
    const r = createReceipt(env());
    expect(() => validateReceipt({ ...r, extra: true })).toThrow();
    expect(() => validateReceipt({ ...r, runtimeSha: 'not-sha' })).toThrow();
    expect(() =>
      validateReceipt({
        ...r,
        steps: [...r.steps.slice(0, 2), { ...r.steps[2], name: 'Invented Proof' }],
      })
    ).toThrow();
  });
  it.each(['failure', 'cancelled', 'skipped', '', 'unknown'])(
    'refuses masked original outcome %s despite successful conclusion',
    (outcome) => {
      const e = env();
      e.RECEIPT_OUTCOMES = JSON.stringify(['success', outcome, 'success']);
      expect(() => createReceipt(e)).toThrow();
    }
  );
  it.each(['', sha, undefined])(
    'refuses missing or divergent actual verified SHA %s',
    (verified) => {
      expect(() => createReceipt({ ...env(), RECEIPT_VERIFIED_SHA: verified })).toThrow();
    }
  );
  it('refuses old receipts without outcomes or actual verification output', () => {
    const r: any = createReceipt(env());
    r.schema = 1;
    delete r.verifiedSha;
    for (const step of r.steps) delete step.outcome;
    expect(() => validateReceipt(r)).toThrow();
  });
  it('captures original outcomes and genuine verification output in the existing producer', () => {
    const source = readFileSync('.github/workflows/publish-club-arena-transaction.yml', 'utf8');
    expect(source).toContain(
      'steps.verdict.conclusion, steps.immutable_publish.conclusion, steps.verified.conclusion'
    );
    expect(source).toContain(
      'steps.verdict.outcome, steps.immutable_publish.outcome, steps.verified.outcome'
    );
    expect(source).toContain(
      'steps.retained_verified.conclusion, steps.retained_recorded.conclusion'
    );
    expect(source).toContain('steps.retained_verified.outcome, steps.retained_recorded.outcome');
    expect(source).toContain('RECEIPT_VERIFIED_SHA: ${{ steps.verified.outputs.sha }}');
    expect(source).toContain("if: steps.verdict.outputs.verdict == 'publish'");
    expect(source.indexOf('Preserve original publisher verdict evidence')).toBeGreaterThan(
      source.indexOf('Remove origin credentials and control sockets')
    );
  });
});

it('accepts approved organization name only with the original immutable repository ID', () => {
  const e = env();
  e.GITHUB_REPOSITORY = 'Smarter-Software-PIQ/Smarter-Poker-Club-Arena';
  e.GITHUB_WORKFLOW_REF = `${e.GITHUB_REPOSITORY}/.github/workflows/publish-club-arena.yml@refs/heads/main`;
  expect(() => createReceipt(e)).not.toThrow();
  expect(() => createReceipt({ ...e, GITHUB_REPOSITORY_ID: '42' })).toThrow();
  expect(() =>
    createReceipt({ ...e, GITHUB_REPOSITORY: 'evil/Smarter-Poker-Club-Arena' })
  ).toThrow();
});

it('binds the exact transaction display name while keeping logical receipt identity', () => {
  for (const key of ['publish-to-origin', 'retain-runtime']) {
    const t = trusted(key);
    const r = createReceipt(env(key, key === 'retain-runtime' ? 'retained' : 'publish'));
    t.job.name = `production / ${key}`;
    expect(mergePublisherReceipt(r, t).steps).toEqual(r.steps);
    for (const bad of [`other / ${key}`, `production / nested / ${key}`]) {
      t.job.name = bad;
      expect(() => mergePublisherReceipt(r, t)).toThrow();
    }
  }
});
