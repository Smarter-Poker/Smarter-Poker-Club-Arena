import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(path, 'utf8');
const sql = read(
  'supabase/migrations/20261015234926_a_completed_week_reads_its_earning_clubs_once.sql'
);
const fixture = 'scripts/ci/fixtures/weekly-completion-receipts/';
const pins = JSON.parse(read(fixture + 'replacement.json'));
const before = read(fixture + 'scope-before.sql');
const old = sql.split('old text:=$completion$')[1].split('$completion$;')[0];
const replacement = sql.split('new text:=$completion$')[1].split('$completion$;')[0];
const md5 = (value: string) => createHash('md5').update(value).digest('hex');

describe('a completed week reads its earning clubs once', () => {
  it('changes only reuse of one fresh completion cohort, retaining all other coordinator bytes', () => {
    expect(md5(before)).toBe(pins.beforeHash);
    expect(before.split(old)).toHaveLength(2);
    expect(md5(before.replace(old, replacement))).toBe(pins.afterHash);
    expect(old.match(/public\.fn_accounting_week_clubs\(/g)).toHaveLength(3);
    expect(replacement.match(/public\.fn_accounting_week_clubs\(/g)).toHaveLength(1);
    expect(replacement.match(/unnest\(v_completion_clubs\) AS uc\(club_id\)/g)).toHaveLength(3);
    const reused = old.replaceAll(
      'public.fn_accounting_week_clubs(v_union.id,NULL,v_from,v_end) uc',
      'unnest(v_completion_clubs) AS uc(club_id)'
    );
    expect(replacement).toContain(reused);
    expect(replacement).toContain('IF v_complete THEN');
    expect(sql).toContain('completion_scan_parent_history_refused');
    expect(sql).toContain('completion_scan_reader_owned');
    expect(sql).toContain('completion_scan_authority_refused');
    expect(sql).toContain('completion_scan_security_refused');
  });

  it('runs the native fail-before, receipt parity and guarded installer through required accounting CI', () => {
    const driver = read('scripts/qualification/weekly-cohort-cutoff/run-native.py');
    const native = read('scripts/ci/test-weekly-completion-receipts-postgres.py');
    expect(driver).toContain('scripts/ci/test-weekly-completion-receipts-postgres.py');
    expect(driver).toContain('check=True');
    expect(read('.github/workflows/ci.yml')).toContain(
      'python3 scripts/qualification/weekly-cohort-cutoff/run-native.py'
    );
    expect(native).toContain("exercise(old,'unnecessary_completion_rescan')");
    expect(native).toContain("exercise(new)=={'complete':True,'calls':1}");
    expect(native).toContain('missing delivery/close refuses');
  });
});
