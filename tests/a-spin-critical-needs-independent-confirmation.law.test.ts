import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

const read = (p: string) => readFileSync(p, 'utf8');
const fixture = 'scripts/ci/fixtures/spin-critical-confirmation/';
const pins = JSON.parse(read(fixture + 'pins.json'));
const migration = read(
  'supabase/migrations/20261015215216_a_spin_distribution_critical_needs_an_independent_window.sql'
);
const md5 = (s: string) => createHash('md5').update(s).digest('hex');

describe('a Spin statistical critical needs independent confirmation', () => {
  it('applies only the four pinned changes to the qualified detector', () => {
    let source = read(fixture + 'before.sql');
    expect(md5(source)).toBe(pins.before);
    expect(pins.swaps).toHaveLength(4);
    for (const { old, new: next } of pins.swaps) {
      expect(source.split(old)).toHaveLength(2);
      expect(migration).toContain('$o$' + old + '$o$');
      expect(migration).toContain('$n$' + next + '$n$');
      source = source.replace(old, next);
    }
    expect(md5(source)).toBe(pins.after);
    expect(source).toContain('v_chi > v_crit_001 AND v_critical_confirmed');
    expect(source).toContain('t.created_at >= v_since - make_interval(days => v_days)');
    expect(source).toContain('t.created_at < v_since');
    expect(source).toContain('ELSIF v_n >= 2000 AND abs(v_z) > 4 THEN');
    expect(source).toContain('IF v_off > 0 THEN');
  });
  it('preserves atomic installation, permissions, source and freeze guards', () => {
    expect(migration.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(migration.match(/^COMMIT;$/gm)).toHaveLength(1);
    for (const guard of [
      'operator',
      'override',
      'freeze',
      'replay',
      'preimage',
      'postimage',
      'security',
    ])
      expect(migration).toContain('spin_confirmation_' + guard + '_refused');
    expect(migration).not.toMatch(/\b(?:UPDATE|INSERT INTO|DELETE FROM) public\./);
  });
  it('runs native confirmation and immediate-defect cases in the existing Spin workflow', () => {
    expect(read('scripts/ci/test-spin-detectors.py')).toContain(
      "ROOT / 'scripts/ci/test-spin-critical-confirmation-postgres.py'"
    );
    expect(read('.github/workflows/spin-detectors.yml')).toContain(
      'python3 scripts/ci/test-spin-detectors.py'
    );
    const native = read('scripts/ci/test-spin-critical-confirmation-postgres.py');
    for (const check of [
      'fail-before single critical',
      'single critical stays visible without escalation',
      'independent critical still escalates',
      'off-ladder remains immediate',
      'expectation drift remains immediate',
      'disjoint exact window boundaries',
      'duplicate alert protection',
      'no invented confirmation',
    ])
      expect(native).toContain(check);
  });
});
