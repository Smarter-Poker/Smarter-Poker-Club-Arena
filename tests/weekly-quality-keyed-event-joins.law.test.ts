import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
const base = 'scripts/ci/fixtures/weekly-quality-keyed-event-joins/';
const read = (p: string) => readFileSync(p, 'utf8');
const digest = (algorithm: string, value: string | Buffer) =>
  createHash(algorithm).update(value).digest('hex');
describe('Weekly quality preserves source bags while avoiding redundant intermediate work', () => {
  it('changes only the two exact source and receipt transformations and preserves full original function authority', () => {
    const receipt = JSON.parse(read(base + 'source-receipt.json'));
    const before = read(base + 'quality-before.sql');
    const after = read(base + 'quality-after.sql');
    expect(before.split(receipt.replacement.old)).toHaveLength(2);
    expect(before.replace(receipt.replacement.old, receipt.replacement.new)).toBe(after);
    expect(receipt.exact_two_replacements).toHaveLength(2);
    let transformed = before;
    for (const delta of receipt.exact_two_replacements) {
      expect(transformed.split(delta.old)).toHaveLength(2);
      transformed = transformed.replace(delta.old, delta.new);
    }
    expect(transformed).toBe(after);
    expect(receipt.exact_two_replacements[0]).toEqual({
      old: 'selected_event_sources AS MATERIALIZED (',
      new: 'selected_event_sources AS NOT MATERIALIZED (',
    });
    expect(receipt.exact_two_replacements[1].old).toBe(
      '    LEFT JOIN selected_receipt_recognized rs ON rs.source_id=s.id'
    );
    expect(receipt.exact_two_replacements[1].new).toContain(
      'WHERE original_receipt.source_id=s.id OFFSET 0'
    );
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
    expect(evidence.case_count).toBe(115);
    expect(evidence.migration_sha256).toBe(digest('sha256', readFileSync(receipt.migration_file)));
    expect(evidence.actual_after_full_md5).toBe(receipt.expected_after_full_md5);
    for (const name of [
      'combined_source_receipt_full_join_bag_NULL',
      'combined_source_receipt_full_join_bag_duplicate',
      'combined_source_receipt_full_join_bag_missing',
      'actual_full_FOR_no_fat_source_spool_and_physical_receipt_probe_force_custom_plan',
      'actual_full_FOR_no_fat_source_spool_and_physical_receipt_probe_force_generic_plan',
      'actual_full_FOR_no_fat_source_spool_and_physical_receipt_probe_auto',
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
  it('keeps excluded malformed contract casts outside all three actual plan domains', () => {
    const extra = JSON.parse(read(base + 'qualification-evidence.json'));
    expect(extra.qualification).toBe('passed');
    expect(extra.case_count).toBe(115);
    expect(extra.actual_after_full_md5).toBe(
      JSON.parse(read(base + 'source-receipt.json')).expected_after_full_md5
    );
    for (const scope of ['foreign_scope', 'outside_week'])
      for (const domain of ['numeric', 'timestamp', 'uuid', 'combined'])
        for (const mode of ['auto', 'force_custom_plan', 'force_generic_plan'])
          expect(extra.cases).toContain(
            'excluded_contract_domain_fullquality_and_fullFOR_' + scope + '_' + domain + '_' + mode
          );
    expect(read('scripts/ci/test-weekly-quality-typed-source-maps-postgres.py')).toContain(
      'if a.keyed_event_candidate:qualify_excluded_contract_domains(q,before,after,rec)'
    );
  });
  it('binds the maintained exact inputs', () => {
    for (const [file, hash] of Object.entries(
      JSON.parse(read(base + 'source-binding.json')).sourceFiles
    ))
      expect(digest('sha256', readFileSync(file))).toBe(hash);
  });
});
