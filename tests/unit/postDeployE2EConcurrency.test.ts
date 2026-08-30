import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const workflow = readFileSync(
  resolve(__dirname, '../../.github/workflows/post-deploy-e2e.yml'),
  'utf8'
);

describe('post-deploy E2E concurrency', () => {
  it('does not let a skipped workflow_run cancel a real production check', () => {
    const concurrency = workflow.match(/concurrency:\n([\s\S]*?)\n\njobs:/)?.[1] ?? '';

    expect(concurrency).toContain("github.event.workflow_run.conclusion != 'success'");
    expect(concurrency).toContain("format('noop-{0}', github.run_id)");
    expect(concurrency).toContain("'production'");
  });

  it('still serializes genuine production checks so authenticated writes cannot overlap', () => {
    const concurrency = workflow.match(/concurrency:\n([\s\S]*?)\n\njobs:/)?.[1] ?? '';

    expect(concurrency).toContain('cancel-in-progress: false');
    expect(concurrency).not.toContain('manual-');
  });
});
