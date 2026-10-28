import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, cpSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { loadSchemaManifest } from '../../scripts/ci/schema-manifest.mjs';

/**
 * A MANIFEST FRAGMENT IS A PROMISE, NOT AN OBSERVATION
 *
 * `scripts/ci/supabase-schema-manifest.json` is generated FROM the live schema,
 * so a name in it was seen in production. A file in
 * `scripts/ci/schema-manifest.d/` is a line the branch author typed. The loader
 * unions them, which is the right answer for "may this branch reference that
 * name" and the wrong answer for "did the migration run".
 *
 * `check-migrations-applied.mjs` asked the second question and read the union.
 * On 2026-09-22 it printed, about
 * `20260922143541_club_and_union_diamond_commerce.sql`:
 *
 *     3 changed migration(s); 0 unapplied object(s).
 *     OK - every object these migrations declare exists in the live schema.
 *
 * Fourteen tables and thirty-five functions later, production had none of them.
 * The fragment's own `_owner` field said "Applied as 20260922143541"; it had
 * not been. The merge landed, `Every merged migration is live` went red on
 * main, and `Prove The Exact Engine Has Every Production Door` correctly
 * refused every engine release from that point - three of those functions are
 * called by server/src/services/CommerceRenewalConsumer.ts.
 *
 * CLAUDE.md 10.86 rule 2: an answer that could not be read must never be
 * coerced into a good one. So the loader now keeps the fragment-only names
 * separate, and the gate reports them as PROMISED - by name, with the file that
 * promised them - instead of describing them as live.
 *
 * WHY PROMISED DOES NOT BLOCK. The fragment mechanism exists so a branch can
 * reference an object it HAS applied before the nightly base regenerates, and
 * that state is normal and common. A gate that refused it would wedge every
 * migration author on this estate, which is worse than the staleness it reports
 * - the same ruling CLAUDE.md 10.87 makes about the freshness guard. What the
 * change removes is the CLAIM, not anyone's ability to ship.
 */

const GATE = readFileSync('scripts/ci/check-migrations-applied.mjs', 'utf8');

describe('a fragment is a promise, not an observation', () => {
  it('the loader reports fragment-only names separately from the live snapshot', () => {
    const m = loadSchemaManifest(process.cwd()) as {
      tables: string[];
      functions: string[];
      promisedTables: string[];
      promisedFunctions: string[];
    };
    expect(Array.isArray(m.promisedTables)).toBe(true);
    expect(Array.isArray(m.promisedFunctions)).toBe(true);

    const base = JSON.parse(readFileSync('scripts/ci/supabase-schema-manifest.json', 'utf8')) as {
      tables?: string[];
      functions?: string[];
    };
    const baseTables = new Set(base.tables ?? []);
    const baseFns = new Set(base.functions ?? []);

    // A promised name is by definition one the live snapshot has never seen.
    for (const t of m.promisedTables) expect(baseTables.has(t)).toBe(false);
    for (const f of m.promisedFunctions) expect(baseFns.has(f)).toBe(false);

    // ...and it is still in the effective union, or the fragment would do nothing.
    const effTables = new Set(m.tables);
    const effFns = new Set(m.functions);
    for (const t of m.promisedTables) expect(effTables.has(t)).toBe(true);
    for (const f of m.promisedFunctions) expect(effFns.has(f)).toBe(true);
  });

  it('the gate never calls a fragment-only object live, and says who has not been asked', () => {
    expect(GATE).toMatch(/promisedFunctions/);
    expect(GATE).toMatch(/promisedTables/);
    expect(GATE).toMatch(/NOTHING HAS ASKED PRODUCTION/);
    // The unconditional claim is what produced the wrong outcome. It may only
    // be printed when there was no promise to qualify it.
    expect(GATE).toMatch(
      /promises\.length\s*\n?\s*\?\s*"OK — nothing this branch declares is missing/
    );
  });

  it('keeps "could not tell" as its own exit code, distinct from clean and from unapplied', () => {
    // 0 clean, 1 unapplied, 2 could-not-tell. A credential that is present but
    // unreadable must never render as green (CLAUDE.md 10.86 rule 1).
    expect(GATE).toMatch(/COULD NOT ASK THE DATABASE/);
    expect(GATE).toMatch(/This is not a pass\./);
    expect(GATE).toMatch(/0 clean · 1 an unapplied object · 2 script error or could-not-tell/);
  });

  it('never carries a credential of its own', () => {
    // It may READ one from the environment and must never contain one.
    expect(GATE).toMatch(/process\.env\.SUPABASE_DB_URL \|\| process\.env\.DATABASE_URL/);
    expect(GATE).not.toMatch(/postgres(ql)?:\/\/[^\s'"`]*:[^\s'"`@]+@/);
  });
});

// Fixtures must never inherit a pre-push hook's repository or injected config.
// An explicit small environment also excludes credentials and global config.
function fixtureEnvironment(inherited: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of [
    'PATH',
    'TMPDIR',
    'TEMP',
    'TMP',
    'LANG',
    'LC_ALL',
    'TZ',
    'SYSTEMROOT',
    'WINDIR',
    'COMSPEC',
  ])
    if (inherited[key] !== undefined) env[key] = inherited[key];
  env.GIT_CONFIG_NOSYSTEM = '1';
  env.GIT_CONFIG_GLOBAL = '/dev/null';
  return env;
}

describe('protected-main migration submission', () => {
  it.each(['ordinary environment', 'inherited pre-push environment'])(
    'isolates %s and preserves strict submission results',
    (scenario) => {
      const root = mkdtempSync(join(tmpdir(), 'migration-submission-'));
      const directory = join(root, 'candidate');
      const foreign = join(root, 'foreign');
      mkdirSync(directory);
      mkdirSync(foreign);
      const safe = fixtureEnvironment(process.env);
      const foreignGit = (...args: string[]) =>
        execFileSync('git', args, {
          cwd: foreign,
          env: safe,
          stdio: 'pipe',
          encoding: 'utf8',
        }).trim();
      foreignGit('init');
      foreignGit('config', 'user.name', 'Foreign fixture owner');
      foreignGit('config', 'user.email', 'foreign@example.invalid');
      writeFileSync(join(foreign, 'retained.txt'), 'retained');
      foreignGit('add', '.');
      foreignGit('commit', '-m', 'retained foreign work');
      const foreignConfig = readFileSync(join(foreign, '.git/config'));
      const foreignHead = foreignGit('rev-parse', 'HEAD');
      const foreignIndex = readFileSync(join(foreign, '.git/index'));
      const inherited =
        scenario === 'ordinary environment'
          ? process.env
          : {
              ...process.env,
              GIT_DIR: join(foreign, '.git'),
              GIT_WORK_TREE: foreign,
              GIT_COMMON_DIR: join(foreign, '.git'),
              GIT_INDEX_FILE: join(foreign, '.git/index'),
              GIT_CONFIG_COUNT: '1',
              GIT_CONFIG_KEY_0: 'core.bare',
              GIT_CONFIG_VALUE_0: 'true',
              GIT_CONFIG_PARAMETERS: "'user.name'='Injected owner'",
            };
      const env = fixtureEnvironment(inherited);
      const git = (...args: string[]) =>
        execFileSync('git', args, { cwd: directory, env, stdio: 'pipe', encoding: 'utf8' }).trim();
      const migration = 'supabase/migrations/20261027000000_new_retention.sql';
      const existing = 'supabase/migrations/20261026000000_existing.sql';
      const body =
        'CREATE FUNCTION public.fn_retention() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$;';
      const write = (file: string, text: string) => writeFileSync(join(directory, file), text);
      const run = (base: string) => {
        return spawnSync(process.execPath, ['scripts/ci/check-migrations-applied.mjs', base], {
          cwd: directory,
          encoding: 'utf8',
          env,
        });
      };
      try {
        mkdirSync(join(directory, 'scripts/ci'), { recursive: true });
        mkdirSync(join(directory, 'supabase/migrations'), { recursive: true });
        for (const name of [
          'check-migrations-applied',
          'schema-manifest',
          'sql-manifest-identifiers',
          'recording-only',
          'maintenance-window-migrations',
          'owner-window-migration',
        ])
          cpSync(`scripts/ci/${name}.mjs`, join(directory, `scripts/ci/${name}.mjs`));
        write(
          'scripts/ci/supabase-schema-manifest.json',
          JSON.stringify({ tables: [], functions: [] })
        );
        write('scripts/ci/supabase-columns-manifest.json', '{}');
        write('scripts/ci/recorded-migrations.manifest.json', '{"recordings":[]}');
        write(existing, '-- existing installed migration history');
        git('init');
        git('config', 'user.name', 'Isolated migration contract');
        git('config', 'user.email', 'fixture@example.invalid');
        git('add', '.');
        git('commit', '-m', 'base');
        const base = git('rev-parse', 'HEAD');
        write(migration, body);
        git('add', '.');
        git('commit', '-m', 'new migration');
        const pending = run(base);
        expect(pending.status, pending.stderr).toBe(0);
        expect(pending.stdout).toContain('PENDING PROTECTED-MAIN INSTALLATION, NOT INSTALLED');
        expect(pending.stdout).not.toContain('every object these migrations declare exists');
        expect(pending.stdout).toContain('dispatch apply-merged-migration');
        expect(pending.stdout).toContain('1 pending protected-main installation');
        expect(pending.stdout).not.toContain('0 unapplied object');
        write(existing, body);
        git('add', '.');
        git('commit', '-m', 'modified old version');
        const changedOld = run(base);
        expect(changedOld.status, changedOld.stderr).toBe(1);
        expect(changedOld.stderr).toContain('fn_retention');
        // A rename of an old version cannot masquerade as a newly admitted file.
        git('mv', existing, existing.replace('existing.sql', 'renamed.sql'));
        git('commit', '-m', 'rename old version');
        expect(run(base).status).toBe(1);
        expect(run('does-not-exist').status).toBe(2);
        // New SQL still undergoes strict schema validation before pending admission.
        write(
          migration,
          'CREATE FUNCTION invalid_schema.fn_retention() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$;'
        );
        git('add', '.');
        git('commit', '-m', 'invalid schema');
        expect(run(base).status).toBe(2);
        expect(readFileSync(join(foreign, '.git/config'))).toEqual(foreignConfig);
        expect(foreignGit('rev-parse', 'HEAD')).toBe(foreignHead);
        expect(readFileSync(join(foreign, '.git/index'))).toEqual(foreignIndex);
        expect(readFileSync(join(foreign, 'retained.txt'), 'utf8')).toBe('retained');
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  );
});
