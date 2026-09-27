import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { classifyChangedPaths } from '../scripts/ci/classify-ci-changes.mjs';

const read = (p: string) => readFileSync(resolve(__dirname, '..', p), 'utf8');
const prefix = 'scripts/ci/fixtures/chip-store-coverage/';
const before = JSON.parse(read(prefix + 'baseline.json')).function.definition as string;
const oldRead = read(prefix + 'read-before.sql');
const newRead = read(prefix + 'read-after.sql');
const after = read(prefix + 'function-after.sql');
const migration = read(
  'supabase/migrations/20260927162949_chip_store_coverage_aggregates_recent_ledger_once.sql'
);
const md5 = (s: string) => createHash('md5').update(s).digest('hex');

describe('one authoritative recent ledger input for chip-store coverage', () => {
  it.each([
    'scripts/ci/test-chip-store-coverage.py',
    prefix + 'baseline.json',
    prefix + 'read-before.sql',
    prefix + 'read-after.sql',
    prefix + 'function-after.sql',
    'tests/chip-store-coverage.test.ts',
  ])('executes native accounting qualification for %s', (path) => {
    expect(classifyChangedPaths([path])).toMatchObject({ server: true, tests: true });
  });

  it('changes one read while keeping the original catalog-derived coverage and result contract', () => {
    expect(md5(before)).toBe('9f44a12318e13f1ef9942ed2a2758d1a');
    expect(before.split(oldRead)).toHaveLength(2);
    expect(before.replace(oldRead, newRead)).toBe(after);
    expect(migration).toContain('$old$' + oldRead + '$old$');
    expect(migration).toContain('$new$' + newRead + '$new$');
    expect(migration).toContain("md5(v_next) IS DISTINCT FROM '" + md5(after) + "'");
    expect(migration).toContain("format_type(atttypid,atttypmod)='numeric(15,2)'");
    expect(migration).toContain('proacl IS NOT DISTINCT FROM v_acl');
    expect(migration).not.toMatch(/^\s*(?:CREATE INDEX|GRANT |REVOKE |UPDATE |DELETE |INSERT )/m);
    expect(migration).not.toContain('cron.schedule');
  });

  it('keeps the exact time and NULL-sensitive correction predicates without scanning per store', () => {
    expect(newRead.match(/FROM public\.chip_ledger l/g)).toHaveLength(1);
    expect(newRead).toContain('recent_store_pairs AS MATERIALIZED');
    expect(newRead).toContain('GROUP BY l.from_type, l.to_type');
    expect(newRead).toContain("l.created_at > now() - interval '24 hours'");
    expect(newRead).toContain("AND NOT (l.category = 'correction'");
    expect(newRead).toContain("l.metadata ->> 'posted_via' = 'fn_ca_post_correction')");
    expect(newRead).toContain("WHERE g.treatment = 'uncounted' AND x.net <> 0");
    expect(newRead).not.toMatch(/created_at <=|is_horse|clock_timestamp|COALESCE\(l\.metadata/i);
  });

  it('wires whole-result native, plan, authority and snapshot regressions to the existing required job', () => {
    expect(read('.github/workflows/ci.yml')).toMatch(
      /- name: Chip store coverage preserves results with one ledger read\n\s+if: matrix\.shard == 4\n\s+run: python3 scripts\/ci\/test-chip-store-coverage\.py/
    );
    const runner = read('scripts/ci/test-chip-store-coverage.py');
    for (const pin of [
      'predecessor==candidate',
      'concurrentSnapshotPreserved',
      "report['after']['scans']==1",
      'CHIP_STORE_COVERAGE_REPEATED_LEDGER_SCAN',
      'CHIP_STORE_COVERAGE_SOURCE_OR_AUTHORITY_CHANGED',
      'CHIP_STORE_COVERAGE_AMOUNT_TYPE_CHANGED',
      "'null-fields'",
      "'nan'",
      "'duplicate-coverage'",
    ])
      expect(runner).toContain(pin);
    expect(runner).not.toMatch(/DATABASE_URL|SUPABASE|https:\/\//);
  });
});
