import { describe, it, expect, afterEach } from 'vitest';
import { declaredObjects, droppedObjects } from '../../scripts/ci/check-migrations-applied.mjs';
import { mergeSchemaResponses } from '../../scripts/ci/scoped-schema-manifest.mjs';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
const privateData = () => ({
  version: 1,
  schema: 'smarter_private',
  complete: true,
  tables: ['smarter_private.f06_operations'],
  functions: ['smarter_private.f06_new_lifecycle'],
  columns: { 'smarter_private.f06_operations': ['break_id', 'a"b'] },
});
describe('actual schema-aware migration parser', () => {
  it('excludes only explicitly session-local objects from the persistent snapshot', () => {
    const sql = `CREATE TABLE PG_TEMP.x(id int);
      CREATE VIEW "pg_temp".v AS SELECT 1;
      CREATE FUNCTION pg_temp.f() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$;
      ALTER TABLE pg_temp.x ADD COLUMN extra int;
      DROP TABLE pg_temp.x; DROP VIEW pg_temp.v; DROP FUNCTION pg_temp.f();
      CREATE TABLE public.pg_temp(id int);
      CREATE TABLE public."pg_temp.x"(id int);`;
    expect(declaredObjects(sql)).toEqual({
      fns: [],
      tables: ['pg_temp', 'pg_temp.x'],
      columns: [],
    });
    expect(droppedObjects(sql)).toEqual({ fns: new Set(), tables: new Set() });
    expect(() => declaredObjects('CREATE TABLE "PG_TEMP".x(id int);')).toThrow(
      /Unsupported manifest schema/
    );
    expect(() => declaredObjects('CREATE TABLE pg_temp.other.x(id int);')).toThrow(/Unsupported/);
  });
  it('keeps public names compatible and every other schema qualified', () =>
    expect(
      declaredObjects(
        'CREATE TABLE public.x(id int); CREATE TABLE x(id int); CREATE TABLE smarter_private.x(id int);'
      ).tables
    ).toEqual(['x', 'smarter_private.x']));
  it('uses PostgreSQL quoting for escaped identifiers and keywords', () =>
    expect(
      declaredObjects(
        'CREATE TABLE "smarter_private"."a""b"(id int); CREATE TABLE smarter_private."select"(id int); CREATE TABLE smarter_private."X Y"(id int);'
      ).tables
    ).toEqual(['smarter_private."a""b"', 'smarter_private."select"', 'smarter_private."X Y"']));
  it('matches helper quoting for dots, dollars and exact raw column names', () => {
    const d = declaredObjects(
      'CREATE TABLE smarter_private."a.b"(id int); CREATE TABLE smarter_private.a$b(id int);'
    );
    expect(d.tables).toEqual(['smarter_private."a.b"', 'smarter_private."a$b"']);
    expect(
      mergeSchemaResponses(
        { tables: [], functions: [] },
        {},
        {
          version: 1,
          schema: 'smarter_private',
          complete: true,
          tables: d.tables,
          functions: [],
          columns: { [d.tables[0]]: [], [d.tables[1]]: ['Mixed.Column'] },
        },
        {}
      ).columns[d.tables[1]]
    ).toEqual(['Mixed.Column']);
  });
  it('preserves comment-like text inside quoted identifiers', () =>
    expect(
      declaredObjects(
        'CREATE TABLE smarter_private."a--b"(id int); CREATE TABLE smarter_private."a/*b*/"(id int);'
      ).tables
    ).toEqual(['smarter_private."a--b"', 'smarter_private."a/*b*/"']));
  it('qualifies functions/views/columns and preserves raw column names', () => {
    const d = declaredObjects(
      'CREATE FUNCTION smarter_private.f() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$; CREATE MATERIALIZED VIEW IF NOT EXISTS smarter_private.v AS SELECT 1; ALTER TABLE smarter_private.x ADD COLUMN "a""b" int;'
    );
    expect(d.fns).toEqual(['smarter_private.f']);
    expect(d.tables).toEqual(['smarter_private.v']);
    expect(d.columns).toEqual([['smarter_private.x', 'a"b']]);
  });
  it('does not turn constraints into columns', () =>
    expect(
      declaredObjects('ALTER TABLE smarter_private.x ADD CONSTRAINT u UNIQUE(id);').columns
    ).toEqual([]));
  it('rejects unsupported schemas for declarations and tombstones', () => {
    expect(() => droppedObjects('DROP TABLE other.x;')).toThrow(/Unsupported manifest schema/);
    expect(() => declaredObjects('CREATE TABLE other.x(id int)')).toThrow(
      /Unsupported manifest schema/
    );
  });
  it('ignores strings/comments without ignoring function body declarations', () => {
    expect(
      declaredObjects(
        "-- someone's CREATE TABLE z\nCOMMENT ON TABLE x IS 'CREATE TABLE nope'; DO $$ BEGIN CREATE TABLE smarter_private.y(id int); END $$;"
      ).tables
    ).toEqual(['smarter_private.y']);
  });
  it('rejects a three-part identity rather than truncating', () =>
    expect(() => declaredObjects('CREATE TABLE database.other.x(id int)')).toThrow(/Unsupported/));
});
describe('complete scoped response composition', () => {
  it('accepts complete existing empty private scope', () => {
    expect(
      mergeSchemaResponses(
        { tables: [], functions: [] },
        {},
        {
          version: 1,
          schema: 'smarter_private',
          complete: true,
          tables: [],
          functions: [],
          columns: {},
        },
        {}
      )
    ).toEqual({ tables: [], functions: [], columns: {} });
  });
  it('preserves exact public and private keys', () =>
    expect(
      mergeSchemaResponses({ tables: ['x'], functions: ['f'] }, { x: ['id'] }, privateData(), {
        x: ['id'],
      }).tables
    ).toEqual(['smarter_private.f06_operations', 'x']));
  it.each([
    undefined,
    {},
    { ...privateData(), complete: false },
    { ...privateData(), schema: 'other' },
    { ...privateData(), version: 2 },
    { ...privateData(), tables: ['f06_operations'] },
    { ...privateData(), columns: {} },
    { ...privateData(), functions: ['other.f'] },
  ])('refuses incomplete or invalid scope %#', (p) =>
    expect(() => mergeSchemaResponses({ tables: [], functions: [] }, {}, p, {})).toThrow()
  );
  it('rejects invalid public and required responses', () => {
    expect(() => mergeSchemaResponses({}, {}, privateData(), {})).toThrow();
    expect(() =>
      mergeSchemaResponses({ tables: [], functions: [] }, {}, privateData(), null)
    ).toThrow();
  });
});
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
describe('actual generator execution before any base write', () => {
  it.each([
    'valid',
    'missing_private',
    'wrong_scope',
    'incomplete',
    'invalid_public',
    'invalid_required',
  ])('%s', (mode) => {
    const dir = mkdtempSync(join(tmpdir(), '0083-generator-'));
    dirs.push(dir);
    mkdirSync(join(dir, 'scripts/ci'), { recursive: true });
    const names = [
      'supabase-schema-manifest.json',
      'supabase-columns-manifest.json',
      'supabase-required-columns-manifest.json',
    ];
    writeFileSync(join(dir, '.prettierignore'), names.map((n) => 'scripts/ci/' + n).join('\n'));
    for (const n of names) writeFileSync(join(dir, 'scripts/ci', n), 'ORIGINAL-' + n);
    const responses: any = {
      fn_schema_manifest: { tables: ['x'], functions: ['f'] },
      fn_columns_manifest: { x: ['id'] },
      fn_ci_smarter_private_manifest: privateData(),
      fn_required_columns_manifest: { x: ['id'] },
    };
    if (mode === 'wrong_scope') responses.fn_ci_smarter_private_manifest.schema = 'other';
    if (mode === 'incomplete') responses.fn_ci_smarter_private_manifest.complete = false;
    if (mode === 'invalid_public') responses.fn_schema_manifest = {};
    if (mode === 'invalid_required') responses.fn_required_columns_manifest = null;
    const bootstrap = join(dir, 'transport.mjs');
    writeFileSync(
      bootstrap,
      `const responses=${JSON.stringify(responses)};globalThis.fetch=async url=>{const name=url.split('/').at(-1);return {ok:!(${JSON.stringify(mode)}==='missing_private'&&name==='fn_ci_smarter_private_manifest'),status:404,text:async()=> 'missing',json:async()=>responses[name]};};`
    );
    const r = spawnSync(
      process.execPath,
      ['--import', bootstrap, resolve(__dirname, '../../scripts/ci/gen-schema-manifest.mjs')],
      {
        cwd: dir,
        env: {
          ...process.env,
          SUPABASE_URL: 'https://synthetic.invalid',
          SUPABASE_SERVICE_ROLE_KEY: 'synthetic-not-a-credential',
        },
        encoding: 'utf8',
      }
    );
    if (mode === 'valid') {
      expect(r.status, r.stderr).toBe(0);
      expect(JSON.parse(readFileSync(join(dir, 'scripts/ci', names[0]), 'utf8')).tables).toContain(
        'smarter_private.f06_operations'
      );
      expect(
        JSON.parse(readFileSync(join(dir, 'scripts/ci', names[1]), 'utf8')).columns[
          'smarter_private.f06_operations'
        ]
      ).toEqual(['break_id', 'a"b']);
      expect(JSON.parse(readFileSync(join(dir, 'scripts/ci', names[2]), 'utf8')).required).toEqual({
        x: ['id'],
      });
    } else {
      expect(r.status).not.toBe(0);
      for (const n of names)
        expect(readFileSync(join(dir, 'scripts/ci', n), 'utf8')).toBe('ORIGINAL-' + n);
    }
  });
});
