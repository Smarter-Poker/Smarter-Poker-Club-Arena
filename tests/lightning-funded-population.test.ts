import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(path, 'utf8');
describe('funded Lightning population remains connected to native qualification', () => {
  it('runs the real-settlement population regression in the required owner', () => {
    expect(read('.github/workflows/ci.yml')).toContain(
      'run: bash scripts/dev/test-lightning-phase6-settlement.sh'
    );
    expect(read('scripts/dev/test-lightning-phase6-settlement.sh')).toContain(
      'python3 "$root/scripts/ci/test-lightning-funded-population.py"'
    );
    const native = read('scripts/ci/test-lightning-funded-population.py');
    expect(native).toContain('harness.settle(');
    expect(native).toContain('baseline did not reproduce busted-pool inflation');
    expect(native).toContain('baseline did not reproduce abandoned in-hand inflation');
    expect(native).toContain('a real live hand disappeared from population');
    expect(native).toContain('normal OFF threshold');
  });
  it('reuses the anchor rule and keeps thresholds and balances outside the migration', () => {
    const sql = read(
      'supabase/migrations/20261018231909_lightning_population_requires_a_funded_live_anchor.sql'
    );
    expect(sql).toContain('public.fn_lightning_anchor_is_live_eligible');
    expect(sql).toContain("i.state IN ('forming', 'reserved', 'dealing', 'settling')");
    expect(sql).toContain('funded_population_postimage_or_security_refused');
    expect(sql).not.toMatch(
      /UPDATE\s+(?:public\.)?(?:table_seats|club_members|cash_games|lightning_pool_session)\b/i
    );
    expect(sql).not.toMatch(/is_horse|horse_id/);
  });
});
