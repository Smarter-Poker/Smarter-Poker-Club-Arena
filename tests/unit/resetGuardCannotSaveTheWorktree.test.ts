import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '../..');
const hookPath = resolve(root, '.husky/reference-transaction');
const hook = readFileSync(hookPath, 'utf8');
const code = hook
  .split('\n')
  .filter((line) => !line.trimStart().startsWith('#'))
  .join('\n');

describe('worktree protection is preventive, not a recovery reconciler', () => {
  it('removes the periodic and post-checkout snapshot machinery', () => {
    for (const path of [
      '.husky/post-checkout',
      'scripts/agent-trees-snapshot.sh',
      'scripts/install-wip-snapshot-agent.sh',
      'scripts/agent-recovery-janitor.sh',
      'scripts/estate-heartbeat.sh',
    ]) {
      expect(existsSync(resolve(root, path)), `${path} must stay retired`).toBe(false);
    }
  });

  it('keeps the ref boundary read-only and fail-closed', () => {
    expect(code).toContain('[ "${1:-}" = "prepared" ] || exit 0');
    expect(code).toContain('git rev-list');
    expect(code).toContain('exit 1');
    expect(code).not.toMatch(/git\s+(?:stash|update-ref|reset|checkout|switch|branch)/);
    expect(code).not.toMatch(/refs\/wip/);
  });

  it('uses isolated worktrees as the working-tree root control', () => {
    const workspace = readFileSync(resolve(root, 'scripts/agent-workspace.sh'), 'utf8');
    const sharedCloneGuard = readFileSync(resolve(root, 'scripts/guard-shared-clone.sh'), 'utf8');
    expect(workspace).toContain('git worktree add');
    expect(workspace).toContain('has uncommitted changes');
    expect(sharedCloneGuard).toContain('$ACTION_UC REFUSED');
    expect(sharedCloneGuard).toContain('push) ACTION_UC="PUSH"');
    expect(sharedCloneGuard).toMatch(/git-common-dir/);
    expect(sharedCloneGuard).toMatch(/exit 1/);
    expect(workspace).not.toMatch(/agent-trees-snapshot|refs\/wip/);
  });
});
