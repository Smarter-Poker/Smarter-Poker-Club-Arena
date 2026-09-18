import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], {
  encoding: 'utf8',
}).trim();

const RULE = 'work/release-journal-pg-*/';

/**
 * Pattern matching only - `--no-index` so the answer is the rule's, not the
 * index's, and so the path under test need not exist in the working tree.
 */
function isIgnored(relativePath: string): boolean {
  try {
    execFileSync('git', ['check-ignore', '-q', '--no-index', '--', relativePath], {
      cwd: repoRoot,
    });
    return true;
  } catch {
    return false;
  }
}

describe('a throwaway Postgres cluster is not untracked work', () => {
  it('names the release-journal cluster directories in .gitignore', () => {
    const gitignore = readFileSync(path.join(repoRoot, '.gitignore'), 'utf8');
    expect(gitignore).toContain(RULE);
  });

  it('ignores the cluster directory and everything inside it', () => {
    expect(isIgnored('work/release-journal-pg-ubSby1/')).toBe(true);
    expect(isIgnored('work/release-journal-pg-ubSby1/base/PG_VERSION')).toBe(true);
    expect(isIgnored('work/release-journal-pg-CyGSrI/postgresql.conf')).toBe(true);
  });

  it('leaves the rest of work/ alone', () => {
    // The rule earns its keep by being narrow. `work/` is not build output and
    // an agent may legitimately leave a note or a script there; only the
    // initdb'd clusters are disposable.
    expect(isIgnored('work/README.md')).toBe(false);
    expect(isIgnored('work/some-analysis.sql')).toBe(false);
  });

  it('matches directories only, so a file merely named like one still shows up', () => {
    expect(isIgnored('work/release-journal-pg-notes.md')).toBe(false);
  });

  it('hides nothing that is already tracked', () => {
    // A .gitignore rule cannot untrack a tracked file, but it can hide the
    // fact that one was expected. If source ever lands under work/, this test
    // fails rather than letting the rule quietly cover it.
    const tracked = execFileSync('git', ['ls-files', '--', 'work/'], {
      cwd: repoRoot,
      encoding: 'utf8',
    })
      .split('\n')
      .filter(Boolean)
      .filter((f) => /^work\/release-journal-pg-/.test(f));
    expect(tracked).toEqual([]);
  });
});
