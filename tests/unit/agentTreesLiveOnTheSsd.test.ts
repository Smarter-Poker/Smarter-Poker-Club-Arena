/**
 * THE DEFAULT IS THE LAW, NOT THE DOCUMENT (2026-09-29).
 *
 * AGENTS.md put agent worktrees on /Volumes/SmarterWork/agent-work. The script
 * agents actually run defaulted to $HOME/Documents/.agent-trees, so 490 of the
 * 659 trees on the Mac sat on the boot disk until it reached 100% and every
 * agent on the machine started failing at whatever it happened to be doing -
 * npm ci with ENOSPC inside a pre-push gate, vitest on a temp file, git on a
 * merge it could not write. These pin the correction where it is read from.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8');

describe('agent worktrees live on the external SSD', () => {
  const workspace = read('scripts/agent-workspace.sh');

  it('defaults to the SSD and keeps the boot disk as a named fallback', () => {
    expect(workspace).toContain('SSD_TREES="/Volumes/SmarterWork/agent-work"');
    // The old default may only be ASSIGNED after the SSD has been tried.
    const ssdAt = workspace.indexOf('SSD_TREES="/Volumes');
    const fallbackAt = workspace.indexOf('TREES="$HOME/Documents/.agent-trees/$REPO"');
    expect(ssdAt).toBeGreaterThan(0);
    expect(fallbackAt).toBeGreaterThan(ssdAt);
    expect(workspace).toMatch(/elif \[ -d "\$SSD_TREES" \] && \[ -w "\$SSD_TREES" \]/);
  });

  it('still lets a caller name its own root', () => {
    expect(workspace).toContain('AGENT_WORKTREE_ROOT');
  });
});

describe('the tree janitor only removes what can be made again', () => {
  const janitor = read('scripts/agent-tree-janitor.sh');

  it('deletes nothing but regenerable build folders', () => {
    const removals = [...janitor.matchAll(/rm -rf "([^"]+)"/g)].map((m) => m[1]);
    expect(removals.length).toBeGreaterThan(0);
    for (const target of removals) {
      expect(target).toBe('$T/$JUNK');
    }
    const junk = janitor.match(/for JUNK in ([^;]+); do/)?.[1].split(/\s+/) ?? [];
    expect(junk).toEqual([
      'node_modules',
      'dist',
      'dist-native',
      'dist-diamond',
      'coverage',
      'playwright-report',
      'test-results',
      '.vite',
    ]);
  });

  it('removes a tree through git, and only after archiving what is in it', () => {
    expect(janitor).toContain('git worktree remove --force "$T"');
    const archiveAt = janitor.indexOf('uncommitted.patch');
    const removeAt = janitor.indexOf('git worktree remove --force');
    expect(archiveAt).toBeGreaterThan(0);
    expect(archiveAt).toBeLessThan(removeAt);
    expect(janitor).toContain('bundle create');
    expect(janitor).toContain('untracked.tgz');
  });

  it('never removes a tree holding a local env file of its own', () => {
    // The tar archives untracked files only, and an ignored .env is not in it,
    // so a tree whose .env is not a copy of the clone's must stay on disk.
    expect(janitor).toContain('ENV_DIFFERS');
    expect(janitor).toContain('cmp -s "$E" "$CLONE/$BASE"');
    const guardAt = janitor.indexOf('ENV_DIFFERS=1; break');
    const removeAt = janitor.indexOf('git worktree remove --force');
    expect(guardAt).toBeGreaterThan(0);
    expect(guardAt).toBeLessThan(removeAt);
  });

  it('reports by default and only sweeps when told to', () => {
    expect(janitor).toContain('APPLY=0');
    expect(janitor).toMatch(/--apply\) APPLY=1/);
  });

  it('leaves a tree alone while somebody is working in it', () => {
    expect(janitor).toContain('IDLE_DAYS');
    expect(janitor).toContain('KEEP_PATTERN');
    expect(janitor).toMatch(/-newermt "@\$IDLE_CUTOFF"/);
  });
});
