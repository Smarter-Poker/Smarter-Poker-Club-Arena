import { it, expect, afterEach } from 'vitest';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { declaredObjects } from '../../scripts/ci/check-migrations-applied.mjs';
import { mergeSchemaResponses } from '../../scripts/ci/scoped-schema-manifest.mjs';
const catalog = JSON.parse(
  readFileSync(resolve(__dirname, 'fixtures/smarter-private-catalog.json'), 'utf8')
);
it('accepts exact root-recorded catalog identities and raw columns', () => {
  const result = mergeSchemaResponses(
    { tables: ['public_table'], functions: ['public_function'] },
    { public_table: ['id'] },
    catalog,
    {}
  );
  expect(catalog.tables).toHaveLength(7);
  expect(catalog.functions).toHaveLength(16);
  for (const t of catalog.tables) {
    expect(result.tables).toContain(t);
    expect(result.columns[t]).toEqual(catalog.columns[t]);
    expect(declaredObjects(`CREATE TABLE ${t}(id int);`).tables).toEqual([t]);
  }
  for (const f of catalog.functions)
    expect(
      declaredObjects(`CREATE FUNCTION ${f}() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$;`).fns
    ).toEqual([f]);
  expect(result.tables).not.toContain('smarter_private');
});
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
it.each([
  'valid',
  'missing_complete',
  'wrong_schema',
  'missing_relation_columns',
  'unqualified_function',
  'rpc_error',
  'invalid_public_columns',
])('actual generator with recorded catalog: %s', (mode) => {
  const privateResponse = structuredClone(catalog);
  if (mode === 'missing_complete') delete privateResponse.complete;
  if (mode === 'wrong_schema') privateResponse.schema = 'public';
  if (mode === 'missing_relation_columns')
    delete privateResponse.columns[privateResponse.tables[0]];
  if (mode === 'unqualified_function') privateResponse.functions[0] = 'f06_accept_hand';
  const dir = mkdtempSync(join(tmpdir(), '0083-recorded-'));
  dirs.push(dir);
  mkdirSync(join(dir, 'scripts/ci'), { recursive: true });
  const names = [
    'supabase-schema-manifest.json',
    'supabase-columns-manifest.json',
    'supabase-required-columns-manifest.json',
  ];
  writeFileSync(join(dir, '.prettierignore'), names.map((n) => 'scripts/ci/' + n).join('\n'));
  for (const n of names) writeFileSync(join(dir, 'scripts/ci', n), 'unchanged-' + n);
  const responses = {
    fn_schema_manifest: {
      tables: ['public_table'],
      functions: ['public_function'],
    },
    fn_columns_manifest: mode === 'invalid_public_columns' ? null : { public_table: ['id'] },
    fn_ci_smarter_private_manifest: privateResponse,
    fn_required_columns_manifest: { public_table: ['id'] },
  };
  const bootstrap = join(dir, 'rpc-fixture.mjs');
  writeFileSync(
    bootstrap,
    `import fs from 'node:fs';const values=${JSON.stringify(responses)};globalThis.fetch=async (url,options)=>{const fn=url.split('/').at(-1);fs.appendFileSync('calls.jsonl',JSON.stringify({fn,method:options.method,body:options.body})+'\\n');return {ok:!(${JSON.stringify(mode)}==='rpc_error'&&fn==='fn_ci_smarter_private_manifest'),status:503,text:async()=> 'catalog unavailable',json:async()=>values[fn]};};`
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
    const schema = JSON.parse(readFileSync(join(dir, 'scripts/ci', names[0]), 'utf8'));
    const columns = JSON.parse(readFileSync(join(dir, 'scripts/ci', names[1]), 'utf8')).columns;
    expect(schema.tables).toEqual([...catalog.tables, 'public_table'].sort());
    expect(schema.functions).toEqual([...catalog.functions, 'public_function'].sort());
    for (const t of catalog.tables) expect(columns[t]).toEqual(catalog.columns[t]);
    expect(JSON.parse(readFileSync(join(dir, 'scripts/ci', names[2]), 'utf8')).required).toEqual({
      public_table: ['id'],
    });
    const calls = readFileSync(join(dir, 'calls.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((s) => JSON.parse(s));
    expect(calls.find((c) => c.fn === 'fn_ci_smarter_private_manifest')).toEqual({
      fn: 'fn_ci_smarter_private_manifest',
      method: 'POST',
      body: '{}',
    });
  } else {
    expect(r.status).not.toBe(0);
    for (const n of names)
      expect(readFileSync(join(dir, 'scripts/ci', n), 'utf8')).toBe('unchanged-' + n);
  }
});
