/**
 * THE CONTRACT CHECK IS EXERCISED, NOT DESCRIBED.
 *
 * `scripts/ci/check-schema-contract.mjs` replaced `git diff --quiet --
 * scripts/ci/` in the Schema Integrity Audit on 2026-10-03. The command it
 * replaced had ONE outcome and therefore could not pass: it ran sixteen times
 * between 2026-09-13 and 2026-10-02 and failed all sixteen, on nothing but
 * production being ahead of a snapshot that is read-only to agents by design.
 *
 * A check with three outcomes is only worth having if each one actually comes
 * out, so these run the real script against a real throwaway git repository
 * and read its exit code. Asserting on its source would re-create exactly the
 * failure CLAUDE.md 10.86 is about: a guard that looks armed.
 */
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const SCRIPT = resolve(__dirname, '..', '..', 'scripts/ci/check-schema-contract.mjs');

/** Enough synthetic names to clear the script's plausibility floors. */
const manyTables = Array.from({ length: 260 }, (_, i) => `t_${String(i).padStart(4, '0')}`);
const manyFns = Array.from({ length: 560 }, (_, i) => `fn_${String(i).padStart(4, '0')}`);
/** Every relation has columns in a real snapshot, and the script's column floor
 *  scales off the table count, so a fixture has to look like one. */
const columnsFor = (tables: string[], extra: Record<string, string[]> = {}) =>
  Object.fromEntries(tables.map((t) => [t, extra[t] ?? ['id']]));

let repo: string;

/** The three manifest files, written wherever we are asked to write them. */
function writeManifests(
  dir: string,
  tables: string[],
  functions: string[],
  columns: Record<string, string[]>,
  required: Record<string, string[]> = {}
) {
  mkdirSync(join(dir, 'scripts/ci'), { recursive: true });
  writeFileSync(
    join(dir, 'scripts/ci/supabase-schema-manifest.json'),
    JSON.stringify({ tables, functions }, null, 2)
  );
  writeFileSync(
    join(dir, 'scripts/ci/supabase-columns-manifest.json'),
    JSON.stringify({ columns }, null, 2)
  );
  writeFileSync(
    join(dir, 'scripts/ci/supabase-required-columns-manifest.json'),
    JSON.stringify({ required }, null, 2)
  );
}

function fragment(dir: string, name: string, data: unknown) {
  mkdirSync(join(dir, 'scripts/ci/schema-manifest.d'), { recursive: true });
  writeFileSync(join(dir, 'scripts/ci/schema-manifest.d', name), JSON.stringify(data, null, 2));
}

/**
 * The environment with every git variable removed.
 *
 * `.husky/pre-push` runs this suite, and git exports GIT_DIR, GIT_WORK_TREE and
 * GIT_INDEX_FILE to its hooks. Inheriting them points every `git` call in here -
 * and every `git show HEAD:` the script under test makes - at THIS repository
 * instead of the fixture.
 *
 * IT DID REAL DAMAGE ONCE, which is why this is a scrub and not a comment. On
 * 2026-10-03 the first push of this file ran the fixture's `git init` and
 * `git config user.*` with the hook's GIT_DIR exported, so both landed on the
 * SHARED config of ~/Documents/club-arena: `core.bare = true`, which made the
 * canonical clone and every worktree on the machine refuse any work-tree
 * operation, and a `[user]` identity of `ci@example.invalid`, which would have
 * authored every later commit in the estate. Both were repaired by hand. A
 * fixture repository must therefore inherit NO git variable at all, and the
 * assertion below is here so a refactor that drops this scrub fails in this file
 * instead of in somebody else's clone.
 */
const noGitEnv = (() => {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('GIT_')) delete env[key];
  }
  return env;
})();

const git = (args: string[]) =>
  execFileSync('git', args, { cwd: repo, encoding: 'utf8', env: noGitEnv });

/** Commit whatever is in the tree as "the contract", then run the check. */
function run() {
  return spawnSync(process.execPath, [SCRIPT], { cwd: repo, encoding: 'utf8', env: noGitEnv });
}

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), 'schema-contract-'));
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.email', 'ci@example.invalid']);
  git(['config', 'user.name', 'ci']);
});

afterAll(() => rmSync(repo, { recursive: true, force: true }));

/** Commit a contract, then drop a live snapshot over it, exactly as the job does. */
function stage(opts: {
  committed: {
    tables: string[];
    functions: string[];
    columns?: Record<string, string[]>;
    required?: Record<string, string[]>;
  };
  live: { tables: string[]; functions: string[]; columns?: Record<string, string[]> };
  fragments?: Record<string, unknown>;
}) {
  rmSync(join(repo, 'scripts'), { recursive: true, force: true });
  writeManifests(
    repo,
    opts.committed.tables,
    opts.committed.functions,
    opts.committed.columns ?? {},
    opts.committed.required ?? {}
  );
  for (const [name, data] of Object.entries(opts.fragments ?? {})) fragment(repo, name, data);
  git(['add', '-A']);
  // --allow-empty: two cases legitimately commit the same contract, and "there
  // was nothing to commit" must not read as a failed fixture.
  git(['commit', '-q', '--allow-empty', '-m', 'contract']);
  // The regeneration overwrites the manifests in the disposable checkout. HEAD
  // still carries the committed contract, which is the pair being compared.
  writeManifests(repo, opts.live.tables, opts.live.functions, opts.live.columns ?? {});
}

describe('the committed schema contract against production', () => {
  it('the fixture inherits no git variable from its caller', () => {
    // See noGitEnv above: with the hook's GIT_DIR exported, this suite wrote
    // core.bare and a user identity into the real repository's shared config.
    for (const key of Object.keys(noGitEnv)) {
      expect(key.startsWith('GIT_'), `${key} must not reach the fixture`).toBe(false);
    }
    // And the fixture is somewhere disposable, never inside a checkout.
    expect(repo.startsWith(tmpdir())).toBe(true);
  });

  it('BEHIND is reported, not failed: production ahead of the contract passes', () => {
    stage({
      committed: { tables: manyTables, functions: manyFns, columns: { t_0001: ['id'] } },
      live: {
        tables: [...manyTables, 'brand_new_table'],
        functions: [...manyFns, 'fn_brand_new'],
        columns: columnsFor([...manyTables, 'brand_new_table'], { t_0001: ['id', 'added_later'] }),
      },
    });
    const r = run();
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain('BEHIND: 2');
    expect(r.stdout).toContain('PHANTOM: 0');
  });

  it('a name a fragment already declares is not counted as behind', () => {
    stage({
      committed: { tables: manyTables, functions: manyFns },
      live: {
        tables: [...manyTables, 'declared_table'],
        functions: manyFns,
        columns: columnsFor([...manyTables, 'declared_table']),
      },
      fragments: { 'mine.json': { tables: ['declared_table'] } },
    });
    const r = run();
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain('BEHIND: 0');
  });

  it('PHANTOM fails: the contract names a function production does not have', () => {
    stage({
      committed: { tables: manyTables, functions: [...manyFns, 'fn_retired_last_week'] },
      live: { tables: manyTables, functions: manyFns, columns: columnsFor(manyTables) },
    });
    const r = run();
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('PHANTOM: 1');
    expect(r.stdout).toContain('fn_retired_last_week');
  });

  it('a fragment tombstone explains a dead name, so it is not a phantom', () => {
    stage({
      committed: { tables: manyTables, functions: [...manyFns, 'fn_retired_last_week'] },
      live: { tables: manyTables, functions: manyFns, columns: columnsFor(manyTables) },
      fragments: { 'retire.json': { removedFunctions: ['fn_retired_last_week'] } },
    });
    const r = run();
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain('PHANTOM: 0');
  });

  it('a dead column of a living table is a phantom too', () => {
    stage({
      committed: {
        tables: manyTables,
        functions: manyFns,
        columns: { t_0001: ['id', 'dropped_col'] },
        required: { t_0001: ['also_gone'] },
      },
      live: { tables: manyTables, functions: manyFns, columns: columnsFor(manyTables) },
    });
    const r = run();
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('t_0001.dropped_col');
    expect(r.stdout).toContain('t_0001.also_gone');
  });

  it('a dead table does not also report every one of its columns', () => {
    stage({
      committed: {
        tables: [...manyTables, 'gone_table'],
        functions: manyFns,
        columns: { gone_table: ['a', 'b', 'c'] },
      },
      live: { tables: manyTables, functions: manyFns, columns: columnsFor(manyTables) },
    });
    const r = run();
    expect(r.status).toBe(1);
    // One finding, not four.
    expect(r.stdout).toContain('PHANTOM: 1');
    expect(r.stdout).toContain('gone_table');
  });

  it('COULD NOT TELL is its own exit code, never clean and never a phantom', () => {
    // An implausibly small live snapshot is a failed read, not a demolished
    // database. CLAUDE.md 10.86 rules 1 and 2.
    stage({
      committed: { tables: manyTables, functions: manyFns },
      live: { tables: ['t_0001'], functions: manyFns, columns: columnsFor(['t_0001']) },
    });
    const r = run();
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('COULD NOT TELL');
    expect(r.stdout).not.toContain('PHANTOM:');
  });

  it('a committed fragment that will not parse is COULD NOT TELL, not ignored', () => {
    stage({
      committed: { tables: manyTables, functions: manyFns },
      live: { tables: manyTables, functions: manyFns, columns: columnsFor(manyTables) },
    });
    mkdirSync(join(repo, 'scripts/ci/schema-manifest.d'), { recursive: true });
    writeFileSync(join(repo, 'scripts/ci/schema-manifest.d/broken.json'), '{ not json');
    git(['add', '-A']);
    git(['commit', '-q', '-m', 'broken fragment']);
    const r = run();
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('COULD NOT TELL');
  });
});
