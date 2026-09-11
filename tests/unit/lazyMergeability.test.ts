/**
 * LAW: the branch-to-PR chain is native-event driven, not a periodic repair.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const read = (path: string) => readFileSync(resolve(__dirname, '../..', path), 'utf8');

describe('event-driven branch proposal and protected merge', () => {
  const signal = read('.github/workflows/agent-branch-proposal.yml');
  const opener = read('.github/workflows/agent-open-pr.yml');
  const autopilot = read('.github/workflows/agent-autopilot.yml');

  it('the branch-authored signal has read-only contents and no secret reference', () => {
    expect(signal).toMatch(/permissions:\s*\n\s*contents:\s*read/);
    expect(signal).not.toMatch(/secrets\.|pull-requests:\s*write|contents:\s*write/);
  });

  it('the trusted opener consumes only a completed signal from this repository', () => {
    expect(opener).toContain("workflows: ['Agent Branch Proposal']");
    expect(opener).toContain('head_repository.full_name == github.repository');
    expect(opener).toContain("conclusion == 'success'");
  });

  it('preview branches are excluded by both producer and privileged consumer', () => {
    expect(signal).toContain("'preview/**'");
    expect(opener).toContain("'preview/'");
  });

  it('native pull-request events replace the old sweep and branch rewrites', () => {
    expect(autopilot).toContain('pull_request_target:');
    expect(autopilot).toContain(
      'github.event.pull_request.head.repo.full_name == github.repository'
    );
    expect(autopilot).not.toMatch(/\bschedule:|update-branch|re-trigger checks/);
    const executable = opener
      .split('\n')
      .filter((line) => !/^\s*#/.test(line))
      .join('\n');
    expect(executable).not.toMatch(/GITHUB_TOKEN_FALLBACK|GH_PAT|\bsweep\b/);
  });
});
