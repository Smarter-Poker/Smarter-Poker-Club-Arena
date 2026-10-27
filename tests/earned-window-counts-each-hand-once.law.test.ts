import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
const migration = readFileSync(
  'supabase/migrations/20261026232607_earned_window_checks_each_hand_cardinality_once.sql',
  'utf8'
);
describe('Earned windows count each complete hand source set once', () => {
  it('retains unfiltered effective source counts and refuses original drift', () => {
    expect(migration).toContain('source_cardinalities AS MATERIALIZED');
    expect(migration).toContain('FROM public.accounting_effective_cash_rake_sources s2');
    expect(migration).toContain(
      'WHERE s2.rake_record_id=ANY(ARRAY(SELECT c0.rake_record_id FROM cw c0))'
    );
    expect(migration).toContain('COALESCE(all_sources.n,0)<>x.n');
    expect(migration).toContain('5fedbe9c2594648f8999d8a427aebcfc');
    expect(migration).toContain('earned_window_cardinality_postimage_changed');
  });
  it('enforces native parity through the existing directly triggered workflow', () => {
    const ci = readFileSync('.github/workflows/unpaid-lightning-funding-contracts.yml', 'utf8');
    expect(ci).toContain('supabase/migrations/**');
    expect(ci).toContain('python3 -B scripts/ci/test-earned-window-cardinality-postgres.py');
    const fixture = readFileSync('scripts/ci/test-earned-window-cardinality-postgres.py', 'utf8');
    expect(fixture).toContain('extra_outside_scope_detected');
    expect(fixture).toContain('rollback_and_replay_refusal');
  });
});
