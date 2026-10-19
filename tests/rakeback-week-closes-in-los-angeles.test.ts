import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(path, 'utf8');
const MIGRATION =
  'supabase/migrations/20261019092211_a_rakeback_week_closes_when_its_los_angeles_week_closes.sql';

describe('a rakeback week closes when its Los Angeles week closes', () => {
  it('runs the native proof inside a required accounting step', () => {
    expect(read('.github/workflows/ci.yml')).toContain(
      'run: python3 -B scripts/ci/test-settlement-suspense-restatement.py'
    );
    expect(read('scripts/ci/test-settlement-suspense-restatement.py')).toContain(
      "scripts/ci/test-rakeback-week-closes-in-los-angeles.py')], check=True)"
    );
    const proof = read('scripts/ci/test-rakeback-week-closes-in-los-angeles.py');
    expect(proof).toContain("(SUMMER, '2026-09-14T03:00:00Z', True, False)");
    expect(proof).toContain("(WINTER, '2026-11-09T07:30:00Z', True, False)");
    expect(proof).toContain("(SUMMER, '2026-09-14T07:00:01Z', True, True)");
  });

  it('moves only the closing instant, to the calculator expression, in all three gates', () => {
    const sql = read(MIGRATION);
    for (const fn of [
      'fn_ca_legacy_period_maturity()',
      'fn_ca_legacy_round3_wallet_receipt()',
      'fn_close_settlement_period(uuid)',
    ])
      expect(sql).toContain(`'public.${fn}'::regprocedure`);
    expect(sql.match(/AT TIME ZONE 'America\/Los_Angeles'\$b\$/g)).toHaveLength(3);
    expect(sql).toContain('rakeback_week_close_postimage_or_security_refused');
    expect(sql).not.toMatch(/^\s*(UPDATE\s+\S+\s+SET|DELETE\s+FROM|INSERT\s+INTO)\b/im);
  });
});
