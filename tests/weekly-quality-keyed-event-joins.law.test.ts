import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
const base = 'scripts/ci/fixtures/weekly-quality-keyed-event-joins/';
const read = (p: string) => readFileSync(p, 'utf8');
const digest = (algorithm: string, value: string | Buffer) =>
  createHash(algorithm).update(value).digest('hex');
describe('Weekly quality reads selected source credits and receipts by key', () => {
  it('changes only the two exact memberships and preserves full original function authority', () => {
    const receipt = JSON.parse(read(base + 'source-receipt.json'));
    const before = read(base + 'quality-before.sql');
    const after = read(base + 'quality-after.sql');
    expect(before.split(receipt.replacement.old)).toHaveLength(2);
    expect(before.replace(receipt.replacement.old, receipt.replacement.new)).toBe(after);
    let exact = before;
    expect(receipt.exact_two_replacements).toHaveLength(2);
    for (const delta of receipt.exact_two_replacements) {
      expect(exact.split(delta.old)).toHaveLength(2);
      exact = exact.replace(delta.old, delta.new);
    }
    expect(exact).toBe(after);
    for (const [text, hash] of [
      [before, receipt.before_full_md5],
      [after, receipt.expected_after_full_md5],
    ])
      expect(digest('md5', text.trimEnd().replace(/;$/, '') + '\n')).toBe(hash);
    const source = read(receipt.migration_file);
    expect(source).toContain(before.trimEnd().replace(/;$/, ''));
    expect(source).toContain(after.trimEnd().replace(/;$/, ''));
    expect(source.match(/SET LOCAL statement_timeout='15s'/g)).toHaveLength(2);
    expect(source).toContain("SET LOCAL statement_timeout='5s'");
    expect(source).toContain("SET LOCAL lock_timeout='1s'");
    for (const name of [
      'operator_refused',
      'window_refused',
      'scheduler_owned',
      'history_replay',
      'exact_preimage_required',
      'source65_required',
      'generation_required',
      'postimage_required',
    ])
      expect(source).toContain('weekly_quality_bags_' + name);
    expect(source).not.toMatch(/CREATE TABLE|cron\.schedule|UPDATE public\./i);
  });
  it('retains full native bags, complete FOR plans, faults and original authorities', () => {
    const receipt = JSON.parse(read(base + 'source-receipt.json'));
    const evidence = JSON.parse(read(base + 'qualification-evidence.json'));
    expect(evidence.qualification).toBe('passed');
    expect(evidence.case_count).toBe(91);
    expect(evidence.migration_sha256).toBe(digest('sha256', readFileSync(receipt.migration_file)));
    expect(evidence.actual_after_full_md5).toBe(receipt.expected_after_full_md5);
    for (const name of [
      'source_credit_membership_full_bag_NULL',
      'source_credit_membership_full_bag_duplicate',
      'source_credit_membership_full_bag_missing',
      'actual_full_FOR_receipt_credit_key_probes_force_custom_plan',
      'actual_full_FOR_receipt_credit_key_probes_force_generic_plan',
      'actual_full_FOR_receipt_credit_key_probes_auto',
      'large_positive_real_quality_full_result_equal',
      'actual_STABLE_SQL_snapshot_concurrent_recognition_commit',
      'exact_installer_metadata_source_guard_and_GEN_preserved',
      'installer_DDL_timeout_remains_short_and_atomic',
    ])
      expect(evidence.cases).toContain(name);
    expect(read('.github/workflows/weekly-close-hour-guard.yml')).toContain(
      '--keyed-event-candidate ' + receipt.migration_file
    );
  });
  it('binds the maintained exact inputs', () => {
    for (const [file, hash] of Object.entries(
      JSON.parse(read(base + 'source-binding.json')).sourceFiles
    ))
      expect(digest('sha256', readFileSync(file))).toBe(hash);
  });
});
