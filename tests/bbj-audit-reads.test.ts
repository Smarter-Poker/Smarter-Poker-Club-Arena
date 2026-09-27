import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { splitConcurrentPreamble } from '../scripts/ci/migration-concurrent-preamble.mjs';
import { classifyChangedPaths } from '../scripts/ci/classify-ci-changes.mjs';

const root = resolve(__dirname, '..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');
const capture = JSON.parse(read('scripts/ci/fixtures/bbj-audit-reads/baseline.json'));
const migration = read(
  'supabase/migrations/20260927042532_bbj_meter_reads_only_pool_ledger_legs.sql'
);
const online = read('scripts/ops/build-bbj-audit-indexes-concurrently.sql');
const md5 = (value: string) => createHash('md5').update(value).digest('hex');

describe('BBJ meter reads only the labelled pool journal without changing its proof', () => {
  it.each([
    'scripts/ci/test-bbj-audit-reads.py',
    'scripts/ci/fixtures/bbj-audit-reads/baseline.json',
    'scripts/ci/migration-concurrent-preamble.mjs',
    'scripts/ops/build-bbj-audit-indexes-concurrently.sql',
    'tests/bbj-audit-reads.test.ts',
  ])('runs the required native job for each independently changed input: %s', (path) => {
    expect(classifyChangedPaths([path])).toMatchObject({ server: true, tests: true });
  });

  it.each([
    'scripts/ci/test-bbj-audit-reads.py.md',
    'scripts/ci/fixtures/bbj-audit-read/baseline.json',
    'docs/tests/bbj-audit-reads.test.ts',
  ])('does not mistake a lookalike for a native financial input: %s', (path) => {
    expect(classifyChangedPaths([path]).server).toBe(false);
  });

  it('binds the full installed predecessor, not a reconstructed financial formula', () => {
    expect(md5(capture.definition)).toBe('df98293beac30ceff81db8779a9fb6f2');
    expect(capture.md5).toBe(md5(capture.definition));
    expect(migration).toContain("md5(v_src) IS DISTINCT FROM '" + capture.md5 + "'");
    expect(capture.proacl).toBe('{postgres=X/postgres,service_role=X/postgres}');
  });

  it('installs only indexes and never rewrites the existing financial function', () => {
    expect(migration).not.toMatch(/(?:CREATE OR REPLACE FUNCTION|EXECUTE v_|UNION ALL|v_new)/);
    expect(migration).toContain('pg_get_functiondef(oid)=v_src');
    expect(capture.definition).toContain('AND l.created_at > v_base.taken_at');
    expect(capture.definition).not.toContain('AND l.created_at <= v_now');
    expect(capture.definition).toContain("'cumulative-since-open-v1'");
  });

  it('separates the exact nonblocking online build from one guarded verification transaction', () => {
    const split = splitConcurrentPreamble(online + '\nBEGIN;\nCOMMIT;');
    expect(migration).not.toMatch(/^\s*(?:CREATE\s+INDEX|REINDEX)/im);
    const proof = /^-- @live-proof: (.+)$/m.exec(migration)?.[1];
    expect(proof).toContain('count(*) = 2');
    expect(proof).toContain('i.indisvalid AND i.indisready AND i.indislive');
    expect(proof).toContain('pg_get_indexdef(c.oid) = w.definition');
    expect(split.ok).toBe(true);
    if (!split.ok) throw new Error(split.reason);
    expect(split.indexes.map((index) => [index.name, index.table])).toEqual([
      ['chip_ledger_bbj_to_pool_meter', 'chip_ledger'],
      ['chip_ledger_bbj_from_pool_meter', 'chip_ledger'],
    ]);
    for (const index of split.indexes) {
      expect(index.statement).toContain("LIKE 'bbj_pools.%'");
      expect(index.statement).not.toContain('INCLUDE');
    }
    expect(migration).toContain('NOT i.indisvalid OR NOT i.indisready OR NOT i.indislive');
    expect(migration).toContain('pg_get_indexdef(c.oid) IS DISTINCT FROM w.definition');
    expect(migration).toContain('proacl IS NOT DISTINCT FROM v_acl');
    expect(migration).toContain('proconfig IS NOT DISTINCT FROM v_config AND proowner=v_owner');
    expect(migration).not.toMatch(
      /(?:cron\.schedule|UPDATE public\.|INSERT INTO public\.|DELETE FROM public\.)/
    );
  });

  it('runs the real PostgreSQL financial and plan qualification in the existing required native shard', () => {
    const workflow = read('.github/workflows/ci.yml');
    expect(workflow).toMatch(
      /- name: BBJ meter preserves its opening-balance proof through scoped ledger reads\n\s+if: matrix\.shard == 4\n\s+run: python3 scripts\/ci\/test-bbj-audit-reads\.py/
    );
    const runner = read('scripts/ci/test-bbj-audit-reads.py');
    expect(runner).toContain('force_custom_plan');
    expect(runner).toContain('force_generic_plan');
    expect(runner).toContain('old_rows[0] == expected');
    expect(runner).toContain('[measure(n) for n in (1,2,3,4)] == performance_rows');
    expect(runner).toContain('BBJ_METER_READ_PLAN_NOT_SCOPED');
    expect(runner).not.toMatch(/SUPABASE|DATABASE_URL|https:\/\//);
  });
});
