import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { test, expect } from 'vitest';
const gate = path.resolve(__dirname, '../../scripts/ci/check-migrations-applied.mjs');
function cli(dir: string, command: string, args: string[]) {
  return spawnSync(command, args, {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', HUSKY: '0' },
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
