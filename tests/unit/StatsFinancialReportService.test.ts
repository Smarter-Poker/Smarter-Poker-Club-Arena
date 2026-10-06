import { beforeEach, describe, expect, it, vi } from 'vitest';
const rpc = vi.hoisted(() => vi.fn());
vi.mock('../../src/lib/supabase', () => ({ supabase: { rpc } }));
import { StatsFinancialReportService } from '../../src/services/StatsFinancialReportService';
const payload = {
  contract_version: 2,
  scope: {
    target_user_id: 'u',
    club_id: 'c',
    asset: 'chips',
    range_days: 30,
    range_tz: 'UTC',
    visibility: 'owner',
  },
  generated_at: '2026-10-03T00:00:00Z',
  availability: {},
  tournament_wallet: {},
  rakeback: {},
  bankroll: { available: false, series: [] },
  cash_sessions: { available: false, sessions: [] },
};
describe('StatsFinancialReportService', () => {
  beforeEach(() => rpc.mockReset());
  it('passes the complete financial scope', async () => {
    rpc.mockResolvedValue({ data: payload, error: null });
    await StatsFinancialReportService.get('u', 'c', 30, 'UTC', 'chips');
    expect(rpc).toHaveBeenCalledWith('ca_player_stats_financial_report', {
      p_user: 'u',
      p_club_id: 'c',
      p_days: 30,
      p_tz: 'UTC',
      p_asset: 'chips',
    });
  });
  it('rejects mismatched scope', async () => {
    rpc.mockResolvedValue({
      data: { ...payload, scope: { ...payload.scope, club_id: 'other' } },
      error: null,
    });
    await expect(StatsFinancialReportService.get('u', 'c', 30, 'UTC', 'chips')).rejects.toThrow(
      'Scope Mismatch'
    );
  });
});
