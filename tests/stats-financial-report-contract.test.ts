import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
const sql = readFileSync(
  join(__dirname, '..', 'supabase/migrations/20261003141340_stats_financial_reports.sql'),
  'utf8'
);
describe('Stats Phase 7 financial report', () => {
  it('is owner and club scoped with calendar boundaries', () => {
    expect(sql).toContain('PERFORM public.ca_assert_self(p_user)');
    expect(sql).toContain('PERFORM public.ca_assert_player_stats_club');
    expect(sql).toContain('ca_stats_calendar_bounds');
    expect(sql).toContain("m.status IN ('active','approved')");
    expect(sql).toContain("lifecycle_status,'active')<>'retired'");
  });
  it('uses authoritative receipts and explicit unavailability', () => {
    expect(sql).toContain('public.wallet_transactions');
    expect(sql).toContain('public.rakeback_periods');
    expect(sql).toContain('public.rakeback_period_payouts');
    expect(sql).toContain("'bankroll_ledger',false");
    expect(sql).toContain("'cash_sessions',false");
    expect(sql).not.toMatch(/45 minutes|lag\(.*hand/i);
  });
  it('covers corrections, refunds, tickets and all tournament money categories', () => {
    for (const c of [
      'tournament_buyin',
      'rebuy',
      'addon',
      'refund',
      'tournament_refund',
      'tournament_prize',
      'tournament_winnings',
      'bounty',
      'ticket_issue',
      'ticket_redeem',
      'correction',
      'reversal',
      'prize_reversal',
    ])
      expect(sql).toContain(`'${c}'`);
  });
});
