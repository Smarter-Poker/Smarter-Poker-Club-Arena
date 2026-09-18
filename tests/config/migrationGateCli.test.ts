import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { test, expect } from 'vitest';
const gate = path.resolve(__dirname, '../../scripts/ci/check-migrations-applied.mjs');
function cli(dir: string, command: string, args: string[]) {
  // Git hooks export the invoking repository's GIT_DIR and related state.
  // These subprocesses belong exclusively to disposable fixture repositories.
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))
  );
  return spawnSync(command, args, {
    cwd: dir,
    encoding: 'utf8',
    env: { ...env, GIT_CONFIG_NOSYSTEM: '1', HUSKY: '0' },
  });
}
function git(dir: string, args: string[]) {
  const r = cli(dir, 'git', args);
  expect(r.status, r.stderr).toBe(0);
  return r.stdout.trim();
}
function put(p: string, text: string) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
}
const cases = [
  {
    name: 'unsupported_changed_drop_still_fails_closed',
    prior: '-- baseline',
    now: 'DROP TABLE other.x;',
    tables: [],
    columns: {},
    expected: 2,
  },
  {
    name: 'older_declaration_retired_by_a_migration_already_on_main',
    prior: '-- baseline',
    now: 'CREATE FUNCTION public.old_game() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$;',
    history: { '20260913000000_retire.sql': 'DROP FUNCTION public.old_game();' },
    tables: [],
    functions: [],
    columns: {},
    expected: 0,
  },
  {
    name: 'older_column_renamed_by_a_migration_already_on_main',
    prior: '-- baseline',
    now: 'ALTER TABLE public.config ADD COLUMN free_spin boolean;',
    history: {
      '20260913000000_rename.sql':
        'ALTER TABLE public.config RENAME COLUMN free_spin TO welcome_spin;',
    },
    tables: ['config'],
    columns: { config: ['welcome_spin'] },
    expected: 0,
  },
  {
    name: 'earlier_drop_cannot_hide_new_missing_function',
    prior: '-- baseline',
    now: 'CREATE FUNCTION public.game() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$;',
    history: { '20260911000000_retire.sql': 'DROP FUNCTION public.game();' },
    tables: [],
    functions: [],
    columns: {},
    expected: 1,
  },
  {
    name: 'later_recreation_still_requires_the_function_to_exist',
    prior: '-- baseline',
    now: 'CREATE FUNCTION public.game() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$;',
    history: {
      '20260913000000_recreate.sql':
        'DROP FUNCTION public.game(); CREATE FUNCTION public.game() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$;',
    },
    tables: [],
    functions: [],
    columns: {},
    expected: 1,
  },
  {
    name: 'historical_retirement_does_not_hide_a_different_missing_function',
    prior: '-- baseline',
    now: 'CREATE FUNCTION public.new_game() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$;',
    history: {
      '20260913000000_retire.sql':
        'DROP FUNCTION public.old_game(); CREATE TABLE other.outside_scope(id int);',
    },
    tables: [],
    functions: [],
    columns: {},
    expected: 1,
  },
  {
    name: 'commented_retirement_does_not_hide_missing_function',
    prior: '-- baseline',
    now: 'CREATE FUNCTION public.game() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$;',
    history: { '20260913000000_comment.sql': '-- DROP FUNCTION public.game();' },
    tables: [],
    functions: [],
    columns: {},
    expected: 1,
  },
  {
    name: 'temporary_helper_is_not_a_persistent_manifest_object',
    prior: '-- baseline',
    now: `CREATE FUNCTION pg_temp.patch() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$;
          DROP FUNCTION pg_temp.patch();
          CREATE FUNCTION public.game() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$;`,
    tables: [],
    functions: ['game'],
    columns: {},
    expected: 0,
  },
  {
    name: 'temporary_drop_does_not_hide_missing_persistent_function',
    prior: '-- baseline',
    now: `CREATE FUNCTION pg_temp.game() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$;
          DROP FUNCTION pg_temp.game();
          CREATE FUNCTION public.game() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$;`,
    tables: [],
    functions: [],
    columns: {},
    expected: 1,
  },
  {
    name: 'temporary_objects_do_not_disable_other_schema_rejection',
    prior: '-- baseline',
    now: 'CREATE TABLE pg_temp.x(id int); CREATE TABLE other.x(id int);',
    tables: [],
    columns: {},
    expected: 2,
  },
  {
    name: 'unicode_upper_function_missing',
    prior: '-- baseline',
    now: 'CREATE FUNCTION smarter_private.CAFÉ() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$;',
    tables: [],
    functions: ['smarter_private."café"'],
    columns: {},
    expected: 1,
  },
  {
    name: 'unicode_upper_function_present',
    prior: '-- baseline',
    now: 'CREATE FUNCTION smarter_private.CAFÉ() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$;',
    tables: [],
    functions: ['smarter_private."cafÉ"'],
    columns: {},
    expected: 0,
  },
  {
    name: 'unicode_upper_column_missing',
    prior: '-- baseline',
    now: 'ALTER TABLE public.a ADD COLUMN CAFÉ int;',
    tables: ['a'],
    columns: { a: ['café'] },
    expected: 1,
  },
  {
    name: 'unicode_upper_column_present',
    prior: '-- baseline',
    now: 'ALTER TABLE public.a ADD COLUMN CAFÉ int;',
    tables: ['a'],
    columns: { a: ['cafÉ'] },
    expected: 0,
  },
  {
    name: 'quoted_upper_identity_preserved',
    prior: '-- baseline',
    now: 'CREATE TABLE smarter_private."CAFÉ"(id int);',
    tables: ['smarter_private."CAFÉ"'],
    columns: {},
    expected: 0,
  },
  {
    name: 'missing_private_control',
    prior: '-- baseline\n',
    now: 'CREATE TABLE smarter_private.missing(id int);',
    tables: [],
    columns: {},
    expected: 1,
  },
  {
    name: 'private_create_drop_control',
    prior: '-- baseline\n',
    now: 'CREATE TABLE smarter_private.transient(id int); DROP TABLE smarter_private.transient;',
    tables: [],
    columns: {},
    expected: 0,
  },
  {
    name: 'unsupported_schema_control',
    prior: '-- baseline\n',
    now: 'CREATE TABLE other.x(id int);',
    tables: [],
    columns: {},
    expected: 2,
  },
  {
    name: 'column_dot_collision',
    prior: 'ALTER TABLE public."a.b" ADD COLUMN c int;',
    now: 'ALTER TABLE public."a.b" ADD COLUMN c int; ALTER TABLE public.a ADD COLUMN "b.c" int;',
    tables: ['a.b', 'a'],
    columns: { 'a.b': ['c'], a: ['id'] },
    expected: 1,
  },
  {
    name: 'unicode_function_skipped',
    prior: '-- baseline\n',
    now: 'CREATE FUNCTION smarter_private.café() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$;',
    tables: [],
    columns: {},
    expected: 1,
  },
  {
    name: 'unicode_schema_truncated',
    prior: '-- baseline\n',
    now: 'CREATE TABLE otheré.x(id int);',
    tables: ['other'],
    columns: { other: ['id'] },
    expected: 2,
  },
  {
    name: 'quoted_text_phantom_drop',
    prior: '-- baseline\n',
    now: 'CREATE TABLE smarter_private.missing(id int); COMMENT ON TABLE public."DROP TABLE smarter_private.missing" IS \'note\';',
    tables: ['DROP TABLE smarter_private.missing'],
    columns: {},
    expected: 1,
  },
  {
    name: 'unicode_table_present',
    prior: '-- baseline',
    now: 'CREATE TABLE smarter_private.café(id int);',
    tables: ['smarter_private."café"'],
    columns: {},
    expected: 0,
  },
  {
    name: 'unicode_function_present',
    prior: '-- baseline',
    now: 'CREATE FUNCTION smarter_private.café() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$;',
    tables: [],
    functions: ['smarter_private."café"'],
    columns: {},
    expected: 0,
  },
  {
    name: 'quoted_escape_phantom_drop',
    prior: '-- baseline',
    now: 'CREATE TABLE smarter_private.missing(id int); COMMENT ON TABLE public."x""DROP TABLE smarter_private.missing" IS NULL ;',
    tables: [],
    columns: {},
    expected: 1,
  },
  {
    name: 'unicode_column_missing',
    prior: '-- baseline',
    now: 'ALTER TABLE public.a ADD COLUMN café int;',
    tables: ['a'],
    columns: { a: ['caf'] },
    expected: 1,
  },
  {
    name: 'quoted_dot_present',
    prior: 'ALTER TABLE public."a.b" ADD COLUMN c int;',
    now: 'ALTER TABLE public."a.b" ADD COLUMN c int; ALTER TABLE public.a ADD COLUMN "b.c" int;',
    tables: ['a.b', 'a'],
    columns: { 'a.b': ['c'], a: ['b.c'] },
    expected: 0,
  },
];

for (const c of cases)
  test(c.name, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'migration-gate-cli-'));
    try {
      const migration = path.join(dir, 'supabase/migrations/20260912000000_probe.sql');
      put(migration, c.prior);
      if ('history' in c && c.history)
        for (const [name, sql] of Object.entries(c.history))
          put(path.join(dir, 'supabase/migrations', name), sql as string);
      put(
        path.join(dir, 'scripts/ci/supabase-schema-manifest.json'),
        JSON.stringify({
          tables: c.tables,
          functions: 'functions' in c ? c.functions : [],
        })
      );
      put(
        path.join(dir, 'scripts/ci/supabase-columns-manifest.json'),
        JSON.stringify({ columns: c.columns })
      );
      git(dir, ['init', '-q']);
      git(dir, ['add', '.']);
      git(dir, [
        '-c',
        'user.name=Gate Test',
        '-c',
        'user.email=test@example.invalid',
        '-c',
        'commit.gpgsign=false',
        'commit',
        '-qm',
        'baseline',
      ]);
      const before = git(dir, ['rev-parse', 'HEAD']);
      put(migration, c.now);
      git(dir, ['add', '.']);
      git(dir, [
        '-c',
        'user.name=Gate Test',
        '-c',
        'user.email=test@example.invalid',
        '-c',
        'commit.gpgsign=false',
        'commit',
        '-qm',
        'probe',
      ]);
      const result = cli(dir, process.execPath, [gate, before]);
      expect(result.status, result.stdout + '\n' + result.stderr).toBe(c.expected);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

test('pre-push checks earlier branch migrations on a follow-up push', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'migration-hook-cli-'));
  try {
    const hook = fs.readFileSync(path.resolve(__dirname, '../../.husky/pre-push'), 'utf8');
    const start = hook.indexOf('  # Migration presence uses Git');
    const end = hook.indexOf('  # 0. Repo-wide invariants.', start);
    expect(start, 'the existing migration gate must run in pre-push').toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    for (const name of [
      'check-migrations-applied.mjs',
      'schema-manifest.mjs',
      'sql-manifest-identifiers.mjs',
    ]) {
      put(
        path.join(dir, 'scripts/ci', name),
        fs.readFileSync(path.join(path.dirname(gate), name), 'utf8')
      );
    }
    put(path.join(dir, 'scripts/ci/supabase-schema-manifest.json'), '{"tables":[],"functions":[]}');
    git(dir, ['init', '-q', '-b', 'fixture']);
    const commit = (message: string) => {
      git(dir, ['add', '.']);
      git(dir, [
        '-c',
        'user.name=Gate Test',
        '-c',
        'user.email=test@example.invalid',
        '-c',
        'commit.gpgsign=false',
        'commit',
        '-qm',
        message,
      ]);
      return git(dir, ['rev-parse', 'HEAD']);
    };
    const base = commit('baseline');
    git(dir, ['update-ref', 'refs/remotes/origin/main', base]);
    put(
      path.join(dir, 'supabase/migrations/20260916000000_probe.sql'),
      'CREATE FUNCTION public.prior_branch_game() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$;'
    );
    const priorPush = commit('migration');
    git(dir, ['update-ref', 'refs/remotes/origin/feature', priorPush]);
    put(path.join(dir, 'README.md'), 'Follow-up without migration changes.\n');
    commit('follow-up');

    // Looking only at the latest commit misses the earlier branch migration.
    expect(cli(dir, process.execPath, [gate, 'HEAD~1']).status).toBe(0);
    const runHookGate = () =>
      cli(dir, 'bash', [
        '-c',
        'set -e\nREMOTE=origin\nLOCAL_SHA=$(git rev-parse HEAD)\nFAIL=0\n' +
          hook.slice(start, end) +
          '\nexit "$FAIL"\n',
      ]);
    const missing = runHookGate();
    expect(missing.status, missing.stdout + missing.stderr).toBe(1);
    expect(missing.stdout + missing.stderr).toContain('prior_branch_game');
    put(
      path.join(dir, 'scripts/ci/schema-manifest.d/probe.json'),
      '{"functions":["prior_branch_game"]}'
    );
    const declared = runHookGate();
    expect(declared.status, declared.stdout + declared.stderr).toBe(0);
    expect(declared.stdout).toContain('1 changed migration(s)');
    git(dir, ['update-ref', '-d', 'refs/remotes/origin/main']);
    const unknownBase = runHookGate();
    expect(unknownBase.status, unknownBase.stdout + unknownBase.stderr).toBe(1);
    expect(unknownBase.stdout).toContain('cannot establish the migration branch base');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
