import { it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';

it('runs the native feature-ablation-assemble.mjs receipt and attempt boundary in required client CI', () => {
  const owned = mkdtempSync(join(resolve(__dirname, '../..'), '.feature-ablation-test-'));
  try {
    const result = spawnSync(
      process.execPath,
      [
        '--test',
        resolve(__dirname, '../operations/feature-ablation-assemble.test.mjs'),
        resolve(__dirname, '../operations/feature-ablation-artifact-custody.test.mjs'),
      ],
      {
        encoding: 'utf8',
        timeout: 20000,
        env: { ...process.env, TMPDIR: owned },
      }
    );
    expect(result.error, result.stderr).toBeUndefined();
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(Number(result.stdout.match(/(?:# )?pass (\d+)/)?.[1])).toBeGreaterThanOrEqual(10);
  } finally {
    rmSync(owned, { recursive: true, force: true });
  }
}, 25000);

it('keeps horse-feature-ablation-qualification.yml manual, bounded and unable to publish or touch production credentials', async () => {
  const { readFileSync } = await import('node:fs');
  const { parse } = await import('yaml');
  const text = readFileSync(
    resolve(__dirname, '../../.github/workflows/horse-feature-ablation-qualification.yml'),
    'utf8'
  );
  const workflow = parse(text);
  expect(Object.keys(workflow.on)).toEqual(['workflow_dispatch']);
  expect(workflow.permissions).toEqual({
    contents: 'read',
    actions: 'read',
    'pull-requests': 'read',
  });
  expect(workflow.jobs.cell.strategy).toMatchObject({ 'fail-fast': false, 'max-parallel': 64 });
  expect(workflow.jobs.cell['timeout-minutes']).toBe(240);
  expect(workflow.jobs.cell.steps.find((s: { id?: string }) => s.id === 'evaluate').env).toEqual({
    GITHUB_TOKEN: '${{ github.token }}',
  });
  expect(workflow.jobs.plan.if).toContain("github.ref == 'refs/heads/main'");
  expect(workflow.jobs.cell.if).toContain("github.ref == 'refs/heads/main'");
  expect(workflow.jobs.assemble.if).toContain("github.ref == 'refs/heads/main'");
  expect(text).toContain('p.matrix.length>256');
  expect(text).toContain('git merge-base --is-ancestor');
  expect(text).toContain('--prepare');
  expect(text).toContain('--finish');
  expect(text).toContain('--assemble');
  expect(text).toContain('gzip -n --');
  expect(text).not.toMatch(
    /secrets\.|repository_dispatch|workflow_run|schedule:|git push|deploy-club-arena/
  );
});
