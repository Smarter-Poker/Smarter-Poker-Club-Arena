import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

const read = (p: string) => readFileSync(p, 'utf8');
const path =
  'supabase/migrations/20261015214329_rake_audits_read_the_dealt_roster_rather_than_contribution_c.sql';
const migration = read(path);
const fixture = 'scripts/ci/fixtures/rake-dealt-roster/';
const pins = JSON.parse(read(fixture + 'pins.json'));
const md5 = (s: string) => createHash('md5').update(s).digest('hex');

describe('rake and BBJ eligibility reads the dealt roster', () => {
  it('changes only the roster input in the two qualified readers', () => {
    expect(pins).toHaveLength(2);
    for (const pin of pins) {
      const before = read(fixture + pin.file);
      expect(md5(before)).toBe(pin.before);
      expect(before.split(pin.old)).toHaveLength(2);
      expect(md5(before.replace(pin.old, pin.new))).toBe(pin.after);
      expect(migration).toContain('$old$' + pin.old + '$old$');
      expect(migration).toContain('$new$' + pin.new + '$new$');
      expect(pin.new).toMatch(/COALESCE\(jsonb_array_length\(CASE WHEN jsonb_typeof\(hh.players\)/);
    }
  });
  it('preserves the accepted-hand contract and financial rows', () => {
    expect(migration.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(migration.match(/^COMMIT;$/gm)).toHaveLength(1);
    expect(migration).not.toMatch(/\b(?:UPDATE|DELETE FROM|INSERT INTO) public\./);
    expect(migration).not.toContain('fn_ca_commit_hand_settlement');
    for (const guard of [
      'operator',
      'override',
      'freeze',
      'replay',
      'preimage',
      'postimage',
      'security',
    ])
      expect(migration).toContain('rake_roster_' + guard + '_refused');
  });
  it('executes native real-finding and false-positive regressions in the existing workflow', () => {
    expect(read('scripts/ci/test-rake-audit-diamond-accrual.py')).toContain(
      "ROOT / 'scripts/ci/test-rake-dealt-roster-postgres.py'"
    );
    expect(read('.github/workflows/rake-audit-diamond-accrual.yml')).toContain(
      'python3 scripts/ci/test-rake-audit-diamond-accrual.py'
    );
    const native = read('scripts/ci/test-rake-dealt-roster-postgres.py');
    for (const check of [
      'fail-before BBJ',
      'fail-before rake',
      'real under-three and missing roster remain',
      'rollback unchanged',
      'authority unchanged',
    ])
      expect(native).toContain(check);
  });
});
