import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
const migration = readFileSync(
  'supabase/migrations/20261016132743_midway_weekly_horse_promo_distribution.sql',
  'utf8'
);
const workflow = readFileSync('.github/workflows/ci.yml', 'utf8');
describe('Midway weekly promo is an atomic step in the existing due weekly tick', () => {
  it('keeps the native money and ledger regression in the required CI workflow', () => {
    expect(workflow).toContain('scripts/qualification/midway-weekly-promo/run-native.py');
    expect(migration).toContain(
      'BEFORE INSERT OR UPDATE OF status,result ON public.union_accounting_runs'
    );
    expect(migration).toContain('v_promo:=public.fn_midway_weekly_horse_promo_due();');
    expect(migration).toContain("v_promo->>'owns_tick'='true' THEN RETURN v_promo");
    expect(migration).not.toMatch(/cron\.(schedule|alter_job)/i);
  });
  it('restricts financial receipts and preserves the existing disbursement door', () => {
    expect(migration).toContain('public.fn_promo_disburse(');
    expect(migration).toContain('UNIQUE(union_id,period_start,period_end)');
    expect(migration).toContain('PRIMARY KEY(run_id,club_id,user_id)');
    expect(migration).toContain('FROM PUBLIC,anon,authenticated,service_role');
    expect(migration).not.toMatch(/UPDATE public\.(club_members|union_wallets)\b/);
  });
});
