import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { classifyChangedPaths } from '../scripts/ci/classify-ci-changes.mjs';
import { splitConcurrentPreamble } from '../scripts/ci/migration-concurrent-preamble.mjs';

const read = (path: string) => readFileSync(resolve(__dirname, '..', path), 'utf8');
const fixture = 'scripts/ci/fixtures/bbj-audit-reads/';
const predecessor = JSON.parse(read(fixture + 'baseline.json')).definition as string;
const oldRead = read(fixture + 'cumulative-read-before.sql');
const newRead = read(fixture + 'cumulative-read.sql') + '\n';
const after = read(fixture + 'cumulative-function-after.sql');
const migration = read(
  'supabase/migrations/20260927141643_bbj_meter_separates_cumulative_banks_from_recent_flows.sql'
);
const online = read('scripts/ops/build-bbj-cumulative-bank-indexes-concurrently.sql');
const md5 = (text: string) => createHash('md5').update(text).digest('hex');

describe('BBJ cumulative bank reads preserve the complete meter', () => {
  it.each([
    'scripts/ci/test-bbj-cumulative-reads.py',
    fixture + 'cumulative-read.sql',
    fixture + 'cumulative-read-before.sql',
    fixture + 'cumulative-function-after.sql',
    'scripts/ops/build-bbj-cumulative-bank-indexes-concurrently.sql',
    'tests/bbj-cumulative-reads.test.ts',
  ])('enforces native accounting qualification for changed input %s', (path) => {
    expect(classifyChangedPaths([path])).toMatchObject({ server: true, tests: true });
  });

  it('replaces exactly one read and leaves all authorization, writes and rounding intact', () => {
    expect(md5(predecessor)).toBe('df98293beac30ceff81db8779a9fb6f2');
    expect(predecessor.split(oldRead)).toHaveLength(2);
    expect(predecessor.replace(oldRead, newRead)).toBe(after);
    expect(migration).toContain('$old$' + oldRead + '$old$');
    expect(migration).toContain('$new$' + newRead + '$new$');
    expect(migration).toContain("md5(v_next) IS DISTINCT FROM '" + md5(after) + "'");
    expect(after.slice(after.indexOf('  SELECT count(*) INTO v_fail'))).toBe(
      predecessor.slice(predecessor.indexOf('  SELECT count(*) INTO v_fail'))
    );
    expect(migration).not.toMatch(/cron\.schedule/);
    expect(migration).not.toMatch(/^\s*(?:CREATE INDEX|REINDEX|GRANT |REVOKE )/m);
  });

  it('keeps the explicit exceptional tail and NULL-safe overlapping selector exclusion', () => {
    expect(newRead).toContain(
      "AND (l.to_entity_id = p_pool_id AND l.to_type = 'bbj_pool') IS NOT TRUE"
    );
    expect(newRead).toContain('AND octet_length(l.to_label) <= 64) IS NOT TRUE');
    expect(newRead).toContain(
      'AND l.created_at > v_base.taken_at AND l.created_at > v_prev.taken_at'
    );
    expect(newRead).not.toContain('created_at <=');
    expect(newRead).not.toMatch(/INSERT |UPDATE |DELETE |fn_[a-z_]+\(/);
    expect(newRead).toContain('FROM banks CROSS JOIN cumulative CROSS JOIN recent');
  });

  it('bounds every covered value without restricting valid ledger writes', () => {
    const split = splitConcurrentPreamble(online + '\nBEGIN;\nCOMMIT;');
    expect(split.ok).toBe(true);
    if (!split.ok) throw new Error(split.reason);
    expect(split.indexes.map((index) => index.name)).toEqual([
      'chip_ledger_bbj_incoming_banks_cover',
      'chip_ledger_bbj_incoming_other_labels',
    ]);
    expect(split.indexes[0].statement).toContain('INCLUDE(to_label, amount)');
    expect(split.indexes[0].statement).toContain('octet_length(to_label) <= 64');
    expect(split.indexes[1].statement).not.toContain('INCLUDE');
    expect(split.indexes[1].statement).toContain('IS NOT TRUE');
    expect(migration).toContain("('amount','numeric(15,2)')");
    expect(migration).toContain('NOT i.indisvalid OR NOT i.indisready OR NOT i.indislive');
    expect(migration).toContain('pg_get_indexdef(c.oid) IS DISTINCT FROM w.definition');
    expect(migration).toContain('proacl IS NOT DISTINCT FROM v_acl');
  });

  it('executes real database comparisons and concurrent recovery in the required job', () => {
    expect(read('.github/workflows/ci.yml')).toMatch(
      /- name: BBJ cumulative and recent reads preserve all financial outcomes\n\s+if: matrix\.shard == 4\n\s+run: python3 scripts\/ci\/test-bbj-cumulative-reads\.py/
    );
    const runner = read('scripts/ci/test-bbj-cumulative-reads.py');
    for (const required of [
      'old_rows[0] == expected',
      '==varied',
      '==reversed_window',
      '==performance_rows',
      'BBJ_CUMULATIVE_HEAP_WORK_NOT_BOUNDED',
      'Heap Fetches',
      'force_generic_plan',
      'force_custom_plan',
      'waiting for old snapshots',
      'concurrentWriteCommitted',
    ])
      expect(runner).toContain(required);
    expect(runner).not.toMatch(/SUPABASE|DATABASE_URL|https:\/\//);
  });
});
