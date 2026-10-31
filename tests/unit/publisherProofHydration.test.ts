import { expect, it, vi } from 'vitest';
import { createReceipt, receiptName } from '../../scripts/ci/publisher-verdict-receipt.mjs';
import {
  hydratePublisherProofs,
  downloadPublisherReceipt,
} from '../../scripts/ci/read-publisher-jobs.mjs';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const repository = 'Smarter-Poker/Smarter-Poker-Club-Arena';
const sha = 'a'.repeat(40);
function fixture() {
  const run = {
    id: 123,
    run_attempt: 2,
    status: 'completed',
    conclusion: 'failure',
    head_branch: 'main',
    head_sha: sha,
    path: '.github/workflows/publish-club-arena.yml',
    repository: { id: 1132369872, full_name: repository },
  };
  const job = {
    id: 456,
    run_id: 123,
    run_attempt: 1,
    name: 'publish-to-origin',
    status: 'completed',
    conclusion: 'success',
    head_sha: sha,
    steps: [],
  };
  const artifact = {
    id: 789,
    expired: false,
    name: receiptName(job.name, 1),
    workflow_run: {
      id: 123,
      repository_id: 1132369872,
      head_repository_id: 1132369872,
      head_sha: sha,
      head_branch: 'main',
    },
  };
  const receipt = createReceipt({
    GITHUB_JOB: job.name,
    GITHUB_REPOSITORY: repository,
    GITHUB_REPOSITORY_ID: '1132369872',
    GITHUB_WORKFLOW_REF: `${repository}/.github/workflows/publish-club-arena.yml@refs/heads/main`,
    GITHUB_WORKFLOW_SHA: sha,
    GITHUB_SHA: sha,
    GITHUB_RUN_ID: '123',
    GITHUB_RUN_ATTEMPT: '1',
    RECEIPT_SELECTED_SHA: sha,
    RECEIPT_RUNTIME_SHA: sha,
    RECEIPT_VERDICT: 'publish',
    RECEIPT_VERIFIED_SHA: sha,
    RECEIPT_OUTCOMES: '["success","success","success"]',
    RECEIPT_CONCLUSIONS: '["success","success","success"]',
  });
  const request = vi.fn(async (path: string) =>
    path.endsWith('/123') ? run : { total_count: 1, artifacts: [artifact] }
  );
  const download = vi.fn(async () => receipt);
  const invoke = () =>
    hydratePublisherProofs({ total_count: 1, jobs: [job] }, repository, '123', '1132369872', sha, {
      request,
      download,
      now: () => 0,
      deadline: 29000,
    });
  return { run, job, artifact, receipt, request, download, invoke };
}
it('hydrates missing original proof from exact publisher-owned receipt and preserves optional failure', async () => {
  const f = fixture();
  const result = await f.invoke();
  expect(result.jobs[0].steps.map((s: { name: string }) => s.name)).toEqual([
    'Stand down if the origin already serves a newer bundle',
    'Publish through the host-owned immutable transaction',
    'Verify the origin serves this bundle',
  ]);
  expect(f.job.steps).toEqual([]);
  expect(f.download).toHaveBeenCalledWith(repository, 789, 29000);
});
it.each([
  'run',
  'branch',
  'repository',
  'artifact',
  'fork',
  'expired',
  'absent',
  'ambiguous',
  'truncated',
])('refuses %s ownership before downloading any archive', async (kind) => {
  const f = fixture();
  if (kind === 'run') f.run.id = 999;
  if (kind === 'branch') f.run.head_branch = 'other';
  if (kind === 'repository') f.run.repository.id = 999;
  if (kind === 'artifact') f.artifact.workflow_run.id = 999;
  if (kind === 'fork') f.artifact.workflow_run.head_repository_id = 999;
  if (kind === 'expired') f.artifact.expired = true;
  if (['absent', 'ambiguous', 'truncated'].includes(kind))
    f.request.mockImplementation(async (path) =>
      path.endsWith('/123')
        ? f.run
        : {
            total_count: kind === 'absent' ? 0 : 2,
            artifacts:
              kind === 'absent'
                ? []
                : kind === 'ambiguous'
                  ? [f.artifact, { ...f.artifact, id: 790 }]
                  : [f.artifact],
          }
    );
  await expect(f.invoke()).rejects.toThrow();
  expect(f.download).not.toHaveBeenCalled();
});
it('keeps present metadata intact and never treats an unsuccessful job as receipt proof', async () => {
  const f = fixture();
  f.job.status = 'in_progress';
  const result = await f.invoke();
  expect(result.jobs[0]).toBe(f.job);
  expect(f.request).not.toHaveBeenCalled();
  expect(f.download).not.toHaveBeenCalled();
});
it('does not reset the original admission deadline before downloading proof', async () => {
  const f = fixture();
  let clock = 0;
  f.request.mockImplementation(async () => {
    clock = 29000;
    return f.run;
  });
  await expect(
    hydratePublisherProofs(
      { total_count: 1, jobs: [f.job] },
      repository,
      '123',
      '1132369872',
      sha,
      {
        request: f.request,
        download: f.download,
        now: () => clock,
        deadline: 29000,
      }
    )
  ).rejects.toThrow(/budget/);
  expect(f.download).not.toHaveBeenCalled();
});
it('reads one physical receipt ZIP without extracting archive paths and refuses extra files', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'publisher-proof-zip-'));
  const originalPath = process.env.PATH;
  try {
    const f = fixture();
    writeFileSync(join(directory, 'publisher-verdict.json'), JSON.stringify(f.receipt));
    const archive = join(directory, 'proof.zip');
    execFileSync('zip', ['-q', archive, 'publisher-verdict.json'], { cwd: directory });
    const executable = join(directory, 'gh');
    writeFileSync(
      executable,
      `#!${process.execPath}\nconst fs=require('node:fs');fs.writeFileSync(${JSON.stringify(join(directory, 'args.json'))},JSON.stringify(process.argv.slice(2)));process.stdout.write(fs.readFileSync(${JSON.stringify(archive)}));\n`
    );
    chmodSync(executable, 0o700);
    process.env.PATH = `${directory}:${originalPath}`;
    expect(await downloadPublisherReceipt(repository, 789, 5000)).toEqual(f.receipt);
    expect(JSON.parse(readFileSync(join(directory, 'args.json'), 'utf8'))).toEqual([
      'api',
      '--method',
      'GET',
      `repos/${repository}/actions/artifacts/789/zip`,
    ]);
    writeFileSync(join(directory, 'extra.json'), '{}');
    execFileSync('zip', ['-q', archive, 'extra.json'], { cwd: directory });
    await expect(downloadPublisherReceipt(repository, 789, 5000)).rejects.toThrow(
      /unavailable or malformed/
    );
  } finally {
    process.env.PATH = originalPath;
    rmSync(directory, { recursive: true, force: true });
  }
});

it('fills only missing exact proofs in partial metadata and preserves unrelated original steps', async () => {
  const f = fixture();
  const setup = { name: 'Set up job', status: 'completed', conclusion: 'success' };
  f.job.steps = [setup, f.receipt.steps[0]] as never[];
  const result = await f.invoke();
  expect(f.download).toHaveBeenCalledTimes(1);
  expect(result.jobs[0].steps).toEqual([setup, f.receipt.steps[0], ...f.receipt.steps.slice(1)]);
  expect(f.job.steps).toHaveLength(2);
});
it.each(['duplicate', 'conflict', 'malformed'])(
  'refuses %s partial proof metadata rather than concealing it',
  async (kind) => {
    const f = fixture();
    f.job.steps = (
      kind === 'duplicate'
        ? [f.receipt.steps[0], f.receipt.steps[0]]
        : kind === 'conflict'
          ? [{ ...f.receipt.steps[0], conclusion: 'failure' }]
          : [null]
    ) as never[];
    await expect(f.invoke()).rejects.toThrow();
  }
);
it('uses reordered complete original metadata without a receipt download', async () => {
  const f = fixture();
  f.job.steps = [...f.receipt.steps].reverse() as never[];
  const result = await f.invoke();
  expect(result.jobs[0]).toBe(f.job);
  expect(f.request).not.toHaveBeenCalled();
  expect(f.download).not.toHaveBeenCalled();
});
it.each(['complete-duplicate', 'status', 'nonarray', 'receipt-contradiction'])(
  'refuses %s original metadata without replacing present evidence',
  async (kind) => {
    const f = fixture();
    f.job.steps = (
      kind === 'complete-duplicate'
        ? [...f.receipt.steps, f.receipt.steps[0]]
        : kind === 'status'
          ? [{ ...f.receipt.steps[0], status: 'in_progress' }]
          : kind === 'nonarray'
            ? null
            : [{ ...f.receipt.steps[0], conclusion: 'skipped' }]
    ) as never[];
    await expect(f.invoke()).rejects.toThrow();
    if (kind !== 'receipt-contradiction') expect(f.download).not.toHaveBeenCalled();
  }
);
