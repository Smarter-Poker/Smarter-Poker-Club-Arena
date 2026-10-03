import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
const migration = readFileSync(
  'supabase/migrations/20261003142109_stats_exact_cash_sessions.sql',
  'utf8'
);
const page = readFileSync('src/pages/PlayerStatsPage.tsx', 'utf8');
describe('exact cash session contract', () => {
  it('captures the three authoritative close owners without changing custody', () => {
    expect(migration).toContain('final_stack = CASE WHEN p_stack IS NULL');
    expect(migration).toContain('trg_fn_close_session_when_seat_vacated');
    expect(migration).toContain("closed_reason='table_closed'");
    expect(migration).toContain("financial_capture_status='partial'");
    expect(migration).not.toContain('chip_balances');
  });
  it('keeps owner and club authorization on the scoped session reader', () => {
    expect(migration).toContain('PERFORM public.ca_assert_self(p_user)');
    expect(migration).toContain('PERFORM public.ca_assert_player_stats_club');
    expect(migration).toContain('TO authenticated,service_role');
  });
  it('wires one financial vault and one exact-session analysis surface including ledger-only players', () => {
    expect(page.match(/financialPanel=\{financialPanel\}/g)).toHaveLength(1);
    expect(page).toContain('exactSessionPanel={exactSessionPanel}');
    expect(page).toContain("!hasData && showTab('tournaments') && financialPanel");
    expect(page).toContain("!hasData && showTab('analysis') && exactSessionPanel");
  });
});
