import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
const sql = readFileSync(
  'supabase/migrations/20261028211646_authored_schedule_registration_closes_at_level_eleven.sql',
  'utf8'
);
const fixture = readFileSync('scripts/ci/authored-level-registration.fixture.sql', 'utf8');
describe('explicit authored schedule registration authority', () => {
  it('normalizes only opted-in prestart, unfinalized MTTs after the clock trigger', () => {
    expect(sql).toContain("v_schedule_config->>'lateRegistrationMode' = 'levels'");
    expect(sql).toContain("IN ('ANNOUNCED','REGISTERING','SCHEDULED','PENDING')");
    expect(sql).toContain('NOT coalesce(NEW.prize_pool_finalized,false)');
    expect(sql).toContain("NOT IN ('spin','sng')");
    expect(sql).toContain('NEW.late_reg_mins := 0;');
    expect(sql).toContain('NOT BETWEEN 1 AND 100');
  });
  it('fails closed on a changed clock definition and preserves existing trigger order', () => {
    expect(sql).toContain('Unexpected level-clock function definition');
    expect(sql).toContain('pg_get_functiondef');
    expect(sql).not.toMatch(/CREATE\s+TRIGGER/i);
    expect(sql).not.toMatch(/UPDATE public\.tournaments/i);
  });
  it('opts in exactly nine named authored definitions rather than recurring older series', () => {
    const ids = sql.match(/'[0-9a-f]{8}-[0-9a-f-]{27}'/g) ?? [];
    expect(ids).toHaveLength(9);
    expect(new Set(ids).size).toBe(9);
    expect(sql).not.toContain('91e49749-6bac-452a-ac3f-cf67550075e7');
  });
  it('retains the native insert, edit, unmarked, running and finalized fixture', () => {
    for (const boundary of [
      'Authored insert',
      'Prestart clock edit',
      'Unmarked event',
      'Running terms',
      'Finalized terms',
    ])
      expect(fixture).toContain(boundary);
    expect(fixture).toContain('ROLLBACK;');
    expect(fixture).not.toContain('fn_register_for_tournament(');
  });
});
