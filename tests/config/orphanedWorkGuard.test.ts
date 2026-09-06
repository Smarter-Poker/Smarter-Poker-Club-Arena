/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE ORPHANED-WORK GUARD MUST NOT CRY WOLF (2026-08-23)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `scripts/ci/check-no-orphaned-work.mjs` refuses a push when a commit pinned
 * in `.agent/protected-commits.json` stops being an ancestor of HEAD. It
 * already forgives a cherry-pick, by comparing patch-ids.
 *
 * It could not forgive a SQUASH merge, which is how every pull request lands
 * in this repo. Squashing rewrites several commits into one, so the squashed
 * commit's patch-id matches none of its parts, and the pinned SHA — the
 * pre-merge local commit — can never be an ancestor either. Every pinned
 * commit therefore failed the guard permanently once its PR merged.
 *
 * Measured 2026-08-23: 38ee27b3d ("16 open Spins were advertising 0/3 while
 * holding 32 paid seats") blocked EVERY push from EVERY worktree, while all
 * 75 of its added lines sat on main and its own guard test passed there. A
 * guard that cries wolf gets switched off, and then the work is lost for real.
 *
 * The fix adds a last-resort content check. These tests pin its two halves:
 * it must forgive a squash merge, and it must STILL fail on genuinely lost
 * work — including the specific disaster the pin note describes, where a
 * stale-side merge kept the explanatory COMMENT and flattened the code under
 * it away. A check that counted comments would be satisfied by exactly the
 * catastrophe it exists to detect.
 *
 * Each case is a real throwaway git repository, because the thing under test
 * is git ancestry and there is no honest way to fake that.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const GUARD = path.resolve(__dirname, '../..', 'scripts/ci/check-no-orphaned-work.mjs');

let repo: string;

// Git exports repository-local variables to push hooks. If those variables
// leak into this fixture, every command below targets the caller's worktree
// instead of the throwaway repository, and `commit('base')` can stage the
// real checkout as deleted. Strip every GIT_* override before invoking Git so
// cwd is the only repository selector.
const scratchGitEnv = Object.fromEntries(
  Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_'))
);

/** Run a git command in the scratch repo; throws with output on failure. */
function git(...args: string[]): string {
  return execFileSync('git', args, {
    cwd: repo,
    encoding: 'utf8',
    env: scratchGitEnv,
  }).trim();
}

function write(file: string, body: string): void {
  const full = path.join(repo, file);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, body);
}

function commit(message: string): string {
  git('add', '-A');
  git('commit', '-q', '-m', message);
  return git('rev-parse', 'HEAD');
}

/** Pin one commit and run the guard. Returns its exit code and combined output. */
function runGuard(sha: string, note: string): { code: number; out: string } {
  write('.agent/protected-commits.json', JSON.stringify({ commits: [{ sha, note }] }, null, 2));
  try {
    const out = execFileSync('node', [GUARD], {
      cwd: repo,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, out };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

let squashed = ''; // re-landed through a squash merge; its code survives
let orphaned = ''; // never merged; its code is nowhere
let flattened = ''; // stale-side merge kept the comment, dropped the code

beforeAll(() => {
  repo = mkdtempSync(path.join(tmpdir(), 'orphan-guard-'));
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'guard@test');
  git('config', 'user.name', 'Guard Test');
  // The guard resolves its pin file from cwd, so the scratch repo gets a copy
  // of the script under test rather than the guard being run from the repo.
  mkdirSync(path.join(repo, 'scripts/ci'), { recursive: true });
  copyFileSync(GUARD, path.join(repo, 'scripts/ci/check-no-orphaned-work.mjs'));
  write('a.js', 'base\n');
  commit('base');

  // ── squashed: two commits on a branch, squash-merged onto main ──────────
  git('checkout', '-q', '-b', 'feat');
  write('a.js', 'base\nconst KEEP_ME = computeKeepValue(1);\n');
  squashed = commit('adds KEEP');
  write('a.js', 'base\nconst KEEP_ME = computeKeepValue(1);\nconst OTHER = 2;\n');
  commit('adds OTHER');
  git('checkout', '-q', 'main');
  git('merge', '-q', '--squash', 'feat');
  commit('squash merge of feat');

  // ── orphaned: committed, never merged, code exists nowhere on main ──────
  git('checkout', '-q', '-b', 'doomed');
  write('b.js', 'base\nconst GONE_FOREVER = deletedHelper(9);\n');
  orphaned = commit('adds GONE');
  git('checkout', '-q', 'main');

  // ── flattened: main took the COMMENT and dropped the code beneath it ────
  git('checkout', '-q', '-b', 'commentonly');
  write(
    'c.js',
    'base\n// Derive the count from SEAT rows, never the counter column.\nconst seatFirstCount = seats.filter((s) => !s.left_at).length;\n'
  );
  flattened = commit('adds comment and the code under it');
  git('checkout', '-q', 'main');
  write('c.js', 'base\n// Derive the count from SEAT rows, never the counter column.\n');
  commit('stale-side merge: comment survived, code flattened away');
  // The full suite creates substantial concurrent filesystem pressure. Keep
  // the guard strict while allowing its real multi-branch Git fixture to land.
}, 30_000);

afterAll(() => {
  if (repo) rmSync(repo, { recursive: true, force: true });
});

describe('a squash-merged commit is not treated as lost', () => {
  it('is genuinely not an ancestor, so the older checks cannot save it', () => {
    // Guarding the premise: if this ever became an ancestor, the test below
    // would pass for the wrong reason and stop protecting anything.
    expect(() => git('merge-base', '--is-ancestor', squashed, 'main')).toThrow();
  });

  it('passes, because every code line it added is still on main', () => {
    const { code, out } = runGuard(squashed, 'squash-merged');
    expect(code).toBe(0);
    expect(out).toMatch(/re-landed|still on main/i);
  });
});

describe('genuinely lost work still fails, loudly', () => {
  it('fails when the commit is orphaned and its code is nowhere', () => {
    const { code, out } = runGuard(orphaned, 'genuinely lost');
    expect(code).toBe(1);
    expect(out).toContain('ORPHANED');
  });

  it('names the exact lines that went missing, not just the SHA', () => {
    const { out } = runGuard(orphaned, 'genuinely lost');
    expect(out).toContain('const GONE_FOREVER = deletedHelper(9);');
  });

  it('is NOT fooled when only the explanatory comment survived', () => {
    // The disaster recorded in the note pinned to 38ee27b3d, verbatim: the
    // change "merged as an explanatory comment while the code under it was
    // flattened away". Comments must never count as survival.
    const { code, out } = runGuard(flattened, 'comment merged, code flattened away');
    expect(code).toBe(1);
    expect(out).toContain('seatFirstCount');
  });
});
