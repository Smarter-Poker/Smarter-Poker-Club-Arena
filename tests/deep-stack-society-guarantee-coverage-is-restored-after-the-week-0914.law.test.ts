import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(
  resolve(
    __dirname,
    '..',
    'supabase/migrations/20261002110247_deep_stack_society_guarantee_coverage_is_restored_after_the_.sql'
  ),
  'utf8'
);

describe('Deep Stack Society guarantee coverage is restored after the week of 2026-09-14 payment', () => {
  it('funds only through the sanctioned door #5805 used, under its own idempotency key', () => {
    expect(sql).toContain('public.fn_ca_fund_club(c_dss, v_amount,');
    expect(sql).toContain(
      "'club-funding:2a1132b9-5ba2-42e6-9f01-30a7fcffebe3:guarantee-coverage-after-legacy-week-2026-09-14'"
    );
    expect(sql).not.toMatch(/UPDATE\s+public\.clubs/i);
    expect(sql).not.toMatch(/INSERT\s+INTO/i);
  });

  it('mints exactly the guarantee shortfall at apply time, bounded, and only after the payment', () => {
    expect(sql).toContain('v_amount := round(greatest(0, v_floor + v_exposure - v_before), 2);');
    expect(sql).toContain('c_cap      CONSTANT numeric := 45000.00;');
    expect(sql).toContain(
      "'club-funding:2a1132b9-5ba2-42e6-9f01-30a7fcffebe3:legacy-week-2026-09-14'"
    );
    expect(sql).toContain("v_state = 'certified'");
    expect(sql).toContain('week of 2026-09-14 rakeback payment');
  });

  it('is one transaction with a post-image proof', () => {
    expect(sql.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(sql.match(/^COMMIT;$/gm)).toHaveLength(1);
    expect(sql).toContain('dss coverage post-image');
  });
});
