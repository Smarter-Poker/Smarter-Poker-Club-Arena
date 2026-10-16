import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

const read = (p: string) => readFileSync(p, 'utf8');
const fixture = 'scripts/ci/fixtures/backed-payout-scan/';
const pins = JSON.parse(read(fixture + 'spin-reserve-replacement.json'));
const migration = read(
  'supabase/migrations/20261015212119_a_spin_conservation_reading_counts_its_reserve_movements.sql'
);
const hash = (s: string) => createHash('md5').update(s).digest('hex');

describe('a Spin conservation reading counts its reserve', () => {
  it('patches exactly one anchored term of the qualified scalar', () => {
    const before = read(fixture + 'spin-reserve-scalar-before.sql');
    expect(hash(before)).toBe(pins.beforeHash);
    expect(before.split(pins.old)).toHaveLength(2);
    expect(hash(before.replace(pins.old, pins.new))).toBe(pins.afterHash);
    expect(migration).toContain('$old$' + pins.old + '$old$');
    expect(migration).toContain('$new$' + pins.new + '$new$');
    expect(pins.new).toContain("l.kind IN ('contribution','jackpot_draw')");
    expect(pins.new).toContain('sum(l.amount)');
    expect(pins.new).toContain("WHERE t.id=m.id)='spin'");
  });
  it('retains atomic installation, source, freeze, replay and authority guards', () => {
    expect(migration.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(migration.match(/^COMMIT;$/gm)).toHaveLength(1);
    for (const word of ['preimage', 'postimage', 'freeze', 'replay', 'security', 'operator'])
      expect(migration).toContain('spin_conservation_' + word + '_refused');
    expect(migration).toContain(pins.beforeHash);
    expect(migration).toContain(pins.afterHash);
    expect(migration).toMatch(/^-- @live-proof:/m);
    expect(migration).not.toMatch(/\b(?:UPDATE|DELETE FROM|INSERT INTO) public\./);
  });
  it('executes its native fail-before and pass-after checks in maintained CI', () => {
    expect(read('scripts/ci/test-backed-payout-scan-postgres.py')).toContain(
      "ROOT/'scripts/ci/test-spin-conservation-postgres.py'"
    );
    expect(read('.github/workflows/ci.yml')).toContain(
      'run: python3 scripts/ci/test-backed-payout-scan-postgres.py'
    );
    const native = read('scripts/ci/test-spin-conservation-postgres.py');
    for (const proof of [
      'fail-before reproduced',
      'non-Spin and Diamond parity',
      'rollback restores original',
      'authority preserved',
    ])
      expect(native).toContain(proof);
  });
});
