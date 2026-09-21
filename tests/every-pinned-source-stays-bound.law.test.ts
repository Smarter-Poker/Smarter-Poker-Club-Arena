/**
 * LAW: a pinned source file is checked on the pull request, not on main.
 * ═══════════════════════════════════════════════════════════════════════════
 * Created 2026-09-20. The history and the reasoning live in
 * docs/laws.d/every-pinned-source-stays-bound.md.
 *
 * This holds scripts/ci/verify-source-bindings.py to three promises, proven by
 * running it rather than by reading it:
 *
 *   - it accepts an intact pin and refuses a drifted one;
 *   - it refuses, rather than skips, a pin it cannot resolve;
 *   - the workflow that runs it stays ungated.
 */
import { describe, expect, it, vi } from 'vitest';

// Subprocess contract suite: these tests drive REAL child processes, so their
// wall time scales with machine load, not with the code under test. vitest's
// 5000ms default is a UNIT-test budget: the slowest test here measures 406ms
// solo, and the pre-push hook runs this file in a 90-file suite at full width,
// where contention has been measured to stretch these runs by 7.1x and time
// them out. 90s is 221x the measured solo runtime - past anything observed,
// and still a real bound, so a genuinely hung child still fails the suite.
// File-scoped on purpose: no global testTimeout, no --no-file-parallelism.
vi.setConfig({ testTimeout: 90_000 });
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = join(__dirname, '..');
const VERIFIER = join(ROOT, 'scripts', 'ci', 'verify-source-bindings.py');
const WORKFLOW = join(ROOT, '.github', 'workflows', 'source-bindings.yml');

type Run = { status: number; stdout: string; stderr: string };

function runVerifier(scriptPath: string): Run {
  try {
    const stdout = execFileSync('python3', [scriptPath], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { status: 0, stdout, stderr: '' };
  } catch (error) {
    const e = error as { status?: number; stdout?: string; stderr?: string };
    return { status: e.status ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

/**
 * A scratch repository whose layout the verifier resolves exactly as it
 * resolves the real one: it takes its root from its own location, two levels
 * above `scripts/ci/`.
 */
function scratchTree(): { root: string; script: string } {
  const root = mkdtempSync(join(tmpdir(), 'pinned-source-'));
  mkdirSync(join(root, 'scripts', 'ci'), { recursive: true });
  const script = join(root, 'scripts', 'ci', 'verify-source-bindings.py');
  cpSync(VERIFIER, script);
  return { root, script };
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function writeBinding(root: string, dir: string, body: unknown): void {
  mkdirSync(join(root, dir), { recursive: true });
  writeFileSync(join(root, dir, 'source-binding.json'), JSON.stringify(body, null, 2) + '\n');
}

/**
 * CLAUDE.md 7.3: a negative assertion must be made against source with its
 * comments removed, or a sentence in a comment can satisfy it. The workflow
 * explains in comments why it carries no gate, and those very words would
 * otherwise be what proves it carries one.
 */
function withoutYamlComments(yaml: string): string {
  return yaml
    .split('\n')
    .map((line) => {
      if (/^\s*#/.test(line)) return '';
      const hash = line.indexOf(' #');
      return hash === -1 ? line : line.slice(0, hash);
    })
    .join('\n');
}

describe('a pinned source file is checked on the pull request, not on main', () => {
  it('accepts this repository as it stands', () => {
    const run = runVerifier(VERIFIER);
    expect(
      run.status,
      `A pinned source file in this branch no longer matches its binding.\n${run.stderr}`
    ).toBe(0);
    expect(run.stdout).toMatch(/Checked \d+ pins across \d+ sections in \d+ binding files\./);
  });

  it('checks a real number of pins, so a silent no-op cannot pass as a pass', () => {
    const run = runVerifier(VERIFIER);
    const counted = run.stdout.match(/Checked (\d+) pins across (\d+) sections in (\d+) binding/);
    expect(counted, run.stdout).not.toBeNull();
    // Measured on 2026-09-20: 745 pins, 15 sections, 15 binding files. The
    // floors are deliberately far below that. They are here to catch a
    // discovery bug that finds nothing, not to freeze the count.
    expect(Number(counted![1])).toBeGreaterThan(500);
    expect(Number(counted![2])).toBeGreaterThan(9);
    expect(Number(counted![3])).toBeGreaterThan(9);
  });

  it('accepts an intact pin and refuses a drifted one in the same tree', () => {
    const { root, script } = scratchTree();
    try {
      const kept = 'the reviewed bytes\n';
      mkdirSync(join(root, 'tests', 'fixtures', 'probe'), { recursive: true });
      writeFileSync(join(root, 'tests', 'fixtures', 'probe', 'kept.txt'), kept);
      writeBinding(root, join('tests', 'fixtures', 'probe'), {
        files: { 'kept.txt': sha256(kept) },
      });

      const intact = runVerifier(script);
      expect(intact.status, intact.stderr).toBe(0);
      expect(intact.stdout).toContain('Every pinned source file still hashes');

      // One byte, and only one byte, is different.
      writeFileSync(join(root, 'tests', 'fixtures', 'probe', 'kept.txt'), 'the reviewed bytes!\n');
      const drifted = runVerifier(script);
      expect(drifted.status).toBe(1);
      expect(drifted.stderr).toContain('kept.txt');
      expect(drifted.stderr).toContain(sha256(kept));
      expect(drifted.stderr).toContain(sha256('the reviewed bytes!\n'));
      expect(drifted.stderr).toContain('no longer matches the bytes it was reviewed as');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses a pin whose file is gone rather than skipping it', () => {
    const { root, script } = scratchTree();
    try {
      mkdirSync(join(root, 'tests', 'fixtures', 'probe'), { recursive: true });
      writeBinding(root, join('tests', 'fixtures', 'probe'), {
        files: { 'never-written.txt': sha256('anything') },
      });
      const run = runVerifier(script);
      expect(run.status).toBe(1);
      expect(run.stderr).toContain('never-written.txt');
      expect(run.stderr).toContain('absent');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses an ambiguous root rather than picking one', () => {
    const { root, script } = scratchTree();
    try {
      // The same relative path exists under the repository root and under the
      // binding's own directory, with different bytes. Choosing either one
      // silently would make the binding meaningless.
      const dir = join('tests', 'fixtures', 'probe');
      mkdirSync(join(root, dir, 'tests', 'fixtures', 'probe'), { recursive: true });
      writeFileSync(join(root, dir, 'tests', 'fixtures', 'probe', 'both.txt'), 'inner\n');
      writeFileSync(join(root, dir, 'both.txt'), 'outer\n');
      writeBinding(root, dir, {
        files: { [join('tests', 'fixtures', 'probe', 'both.txt')]: sha256('inner\n') },
      });
      const run = runVerifier(script);
      expect(run.status).toBe(1);
      expect(run.stderr).toContain('the intended root cannot be measured');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses a tree with no bindings at all instead of reporting success', () => {
    const { root, script } = scratchTree();
    try {
      const run = runVerifier(script);
      expect(run.status).toBe(1);
      expect(run.stderr).toContain('has failed, not passed');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('runs in a workflow that nothing gates', () => {
    const raw = readFileSync(WORKFLOW, 'utf8');
    const yaml = withoutYamlComments(raw);
    expect(yaml.length, 'the comment stripper removed nothing, so it proves nothing').toBeLessThan(
      raw.length
    );

    expect(yaml).toContain('pull_request:');
    expect(yaml).toContain('python3 scripts/ci/verify-source-bindings.py');

    expect(yaml).not.toMatch(/^\s*if:/m);
    expect(yaml).not.toMatch(/^\s*needs:/m);
    expect(yaml).not.toMatch(/^\s*paths(-ignore)?:/m);
    expect(yaml).not.toMatch(/^\s*branches-ignore:/m);
    expect(yaml).not.toMatch(/^\s*schedule:/m);
  });
});
