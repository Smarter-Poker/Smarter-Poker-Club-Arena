/**
 * LAW: shared merge automation is event-driven and repository-neutral.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const code = (text: string) =>
  text
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');

describe('shared merge automation has no repository-specific reconciler', () => {
  const autopilot = code(read('.github/workflows/agent-autopilot.yml'));
  const queue = code(read('.github/scripts/queue-pr.sh'));

  it('reacts to pull-request events and carries no timer or sweep dispatch', () => {
    expect(autopilot).toContain('pull_request_target:');
    expect(autopilot).toContain('synchronize');
    expect(autopilot).not.toMatch(/\bschedule:/);
    expect(autopilot).not.toMatch(/\brepository_dispatch:/);
    expect(autopilot).not.toMatch(/update-branch|actions\/runs\?|ci\.yml/);
  });

  it('never gives a fork pull request privileged merge authority', () => {
    expect(autopilot).toContain(
      'github.event.pull_request.head.repo.full_name == github.repository'
    );
  });

  it('uses only a freshly minted App token', () => {
    expect(autopilot).toContain('actions/create-github-app-token@');
    expect(autopilot).toContain('steps.app-token.outputs.token');
    expect(autopilot).not.toMatch(/GH_PAT|AUTOFIX_GITHUB_TOKEN/);
  });

  it('queue-pr refuses direct merge when required checks are absent', () => {
    expect(queue).toContain('required_status_checks');
    expect(queue).toContain('has no required checks; refusing a direct merge');
    expect(queue).not.toMatch(/--admin/);
  });
});
