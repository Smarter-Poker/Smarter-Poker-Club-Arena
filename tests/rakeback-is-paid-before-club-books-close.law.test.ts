import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
const migration = readFileSync(
  'supabase/migrations/20261027004204_rakeback_is_paid_before_the_club_books_close.sql',
  'utf8'
);
describe('Earned rakeback precedes club-book settlement', () => {
  it('moves the original book guard without replacing a financial writer', () => {
    expect(migration).toContain('club_books_close_after_rakeback');
    expect(migration).toContain(
      'v_quality:=public.fn_union_pnl_close_quality(p_union_id,v_from,v_to)'
    );
    expect(migration).toContain("RAISE EXCEPTION 'union_pnl_basis_uncertified'");
    expect(migration).toContain("'purpose','club_settlements'");
    expect(migration).toContain('59ffa64567422631e131fd3cc2b03552');
    expect(migration).toContain('88417415bde34f4d8ea462950aa7f20f');
    expect(migration).not.toMatch(/UPDATE public\.(club_members|agents|clubs) SET/);
  });
  it('enforces actual owner sequencing, refusals and receipt replay in native PostgreSQL', () => {
    const ci = readFileSync('.github/workflows/unpaid-lightning-funding-contracts.yml', 'utf8');
    expect(ci).toContain('python3 -B scripts/ci/test-fees-before-club-books-postgres.py');
    const native = readFileSync('scripts/ci/test-fees-before-club-books-postgres.py', 'utf8');
    expect(native).toContain('weekly_accounting_calculation_incomplete');
    expect(native).toContain('original_earned_fee_proof_refused');
    expect(native).toContain('union_pnl_basis_uncertified');
    expect(native).toContain('replay_zero_duplicate_legs');
  });
});
