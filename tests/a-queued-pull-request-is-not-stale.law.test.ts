/**
 * Pull-request lifecycle is owned by native GitHub events and branch
 * protection. Scheduled stale-label and queue-reconciliation writers are
 * retired so they cannot relabel or close reviewed work behind the author.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(__dirname, '..');

describe('LAW: pull requests are not managed by scheduled reconcilers', () => {
  it('retires the stale workflow and queued-label mutator', () => {
    expect(existsSync(resolve(root, '.github/workflows/stale.yml'))).toBe(false);
    expect(existsSync(resolve(root, '.github/scripts/label-queued-pull-requests.mjs'))).toBe(false);
  });

  it('leaves no workflow command that labels a pull request as queued or stale', () => {
    const workflowDir = resolve(root, '.github/workflows');
    const workflows = readdirSync(workflowDir)
      .filter((name) => /\.ya?ml$/.test(name))
      .map((name) => readFileSync(resolve(workflowDir, name), 'utf8'))
      .join('\n');

    expect(workflows).not.toContain('label-queued-pull-requests.mjs');
    expect(workflows).not.toMatch(/gh\s+(?:pr|issue)\s+edit[^\n]*--add-label\s+["']?queued/);
    expect(workflows).not.toMatch(/actions\/stale@/);
  });

  it('uses native pull-request events for merge evaluation', () => {
    const autopilot = readFileSync(resolve(root, '.github/workflows/agent-autopilot.yml'), 'utf8');
    expect(autopilot).toContain('pull_request_target:');
    expect(autopilot).toContain(
      'github.event.pull_request.head.repo.full_name == github.repository'
    );
    expect(autopilot).not.toMatch(/^\s*schedule:/m);
  });
});
