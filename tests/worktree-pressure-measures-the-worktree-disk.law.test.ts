import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], {
  encoding: 'utf8',
}).trim();
const SCRIPT = resolve(repoRoot, 'scripts/worktree-pressure.sh');

/**
 * The script shells out to `git worktree list` and `df`. Both are replaced
 * here so the test can state exactly which trees exist and how full each
 * filesystem is - the real ones would make this machine-dependent.
 */
function runWith(
  worktrees: string[],
  freeByRoot: Record<string, number>,
  homeDir = '/nonexistent-home'
): string {
  const bin = mkdtempSync(join(tmpdir(), 'wt-pressure-'));
  made.push(bin);

  const porcelain = worktrees.map((w) => `worktree ${w}\nHEAD 0\n`).join('\n');
  writeFileSync(
    join(bin, 'git'),
    `#!/usr/bin/env bash\nif [ "$1" = worktree ] && [ "$2" = list ]; then\n` +
      `  if [ "$3" = --porcelain ]; then printf '%b' ${JSON.stringify(porcelain)};\n` +
      `  else printf '%b' ${JSON.stringify(worktrees.map((w) => `${w} 0 [b]`).join('\n') + '\n')}; fi\n` +
      `  exit 0\nfi\nexit 0\n`,
    { mode: 0o755 }
  );
  chmodSync(join(bin, 'git'), 0o755);

  // `df -g <path>` -> header, then "fs size used AVAIL cap ... MOUNT"
  const cases = Object.entries(freeByRoot)
    .map(([root, free]) => `  ${JSON.stringify(root)}) echo "fs 1 1 ${free} 1% 1 1 1% ${root}";;`)
    .join('\n');
  writeFileSync(
    join(bin, 'df'),
    `#!/usr/bin/env bash\ntarget="\${!#}"\necho "Filesystem 1G-blocks Used Avail Capacity iused ifree %iused Mounted"\n` +
      `case "$target" in\n${cases}\n  *) echo "fs 1 1 999 1% 1 1 1% /";;\nesac\n`,
    { mode: 0o755 }
  );
  chmodSync(join(bin, 'df'), 0o755);

  // The warning is written to stderr on purpose, so read both streams.
  const r = spawnSync('bash', [SCRIPT], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, HOME: homeDir },
  });
  return `${r.stdout ?? ''}${r.stderr ?? ''}`;
}

const made: string[] = [];
afterAll(() => made.forEach((d) => rmSync(d, { recursive: true, force: true })));

function realDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  made.push(d);
  return d;
}

describe('worktree pressure measures the disk the worktrees are on', () => {
  it('reports the tightest worktree filesystem, not $HOME', () => {
    // $HOME is roomy; the volume holding the trees is nearly full. This is
    // exactly 2026-09-19: the old reader said "110 GiB free" about $HOME
    // while npm ci was dying of ENOSPC on the disk the trees were on.
    const vol = realDir('vol-');
    const home = realDir('home-');
    const tree = join(vol, 'agent-work', 'a');
    mkdirSync(tree, { recursive: true });
    const out = runWith([tree], { [tree]: 1, [home]: 400 }, home);
    expect(out).toMatch(/1 GiB free on /);
    expect(out).not.toMatch(/400 GiB free/);
  });

  it('names the filesystem it judged, so the number is never free-floating', () => {
    const vol = realDir('vol-');
    const home = realDir('home-');
    const tree = join(vol, 'agent-work', 'a');
    mkdirSync(tree, { recursive: true });
    const out = runWith([tree], { [tree]: 2, [home]: 400 }, home);
    expect(out).toMatch(/free on \/\S+/);
  });

  it('still judges $HOME when that is where the trees live', () => {
    const home = realDir('home-');
    const tree = join(home, 'Documents', 'tree-a');
    mkdirSync(tree, { recursive: true });
    const out = runWith([tree], { [tree]: 3, [home]: 3 }, home);
    expect(out).toMatch(/3 GiB free on /);
  });

  it('warns and never blocks: a full disk must not stop someone saving work', () => {
    const hits = execFileSync(
      'bash',
      ['-c', `grep -c 'exit 1' ${JSON.stringify(SCRIPT)} || true`],
      { encoding: 'utf8' }
    ).trim();
    expect(hits).toBe('0');
  });
});
