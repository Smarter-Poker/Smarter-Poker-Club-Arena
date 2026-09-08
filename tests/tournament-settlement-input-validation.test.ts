import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
const sql = readFileSync(
  'supabase/migrations/20260908011408_tournament_settlement_rejects_invalid_amounts_and_places.sql',
  'utf8'
);
describe('the installed settlement input boundary is retained', () => {
  it('rejects missing and nonfinite amounts before modifying an obligation', () => {
    const check = sql.indexOf(
      "IF p_amount IS NULL OR p_amount::text IN ('NaN','Infinity','-Infinity')"
    );
    expect(check).toBeGreaterThan(0);
    expect(check).toBeLessThan(sql.indexOf('SET amount_owed = v_amount'));
    expect(sql).toContain('IF p_amount < 0 THEN');
    expect(sql).toContain("v_row_kind = 'place' AND v_place <= 0");
  });
  it('keeps the behavior probe self-aborting and temporary', () => {
    const probe = readFileSync('scripts/ci/probes/tournament-settlement-inputs.sql', 'utf8');
    expect(probe).toContain("replace(src,'public.','pg_temp.')");
    expect(probe).toContain("RAISE EXCEPTION 'AUDIT_TEST_PASS:");
    expect(probe).toContain('FAIL invalid amount mutated payment state');
  });
});
