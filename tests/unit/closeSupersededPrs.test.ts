/** Automatic pull-request closure is a reconciler, so it is retired outright. */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const SCRIPT = resolve(__dirname, '../../.github/scripts/close-superseded-prs.sh');
const WORKFLOW = resolve(__dirname, '../../.github/workflows/close-superseded-prs.yml');

describe('automatic pull-request closure is absent', () => {
  it('removes both the scheduled workflow and its mutating script', () => {
    expect(existsSync(SCRIPT)).toBe(false);
    expect(existsSync(WORKFLOW)).toBe(false);
  });

  it('no remaining workflow invokes or reimplements automatic PR closure', () => {
    const workflowDir = resolve(__dirname, '../../.github/workflows');
    const source = readdirSync(workflowDir)
      .filter((name) => /\.ya?ml$/.test(name))
      .map((name) => readFileSync(resolve(workflowDir, name), 'utf8'))
      .join('\n');
    expect(source).not.toContain('close-superseded-prs.sh');
    expect(source).not.toMatch(/gh\s+pr\s+close/);
  });
});
