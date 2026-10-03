import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
const get = vi.hoisted(() => vi.fn());
vi.mock('../../src/services/StatsFinancialReportService', () => ({
  StatsFinancialReportService: { get },
}));
import FinancialReportingPanel from '../../src/components/stats/FinancialReportingPanel';
const base = {
  contract_version: 2,
  scope: {
    target_user_id: 'u',
    club_id: 'c',
    asset: 'chips',
    range_days: 30,
    range_tz: 'UTC',
    visibility: 'owner',
  },
  generated_at: '2026-10-03',
  availability: {
    tournament_wallet: true,
    rakeback: true,
    bankroll_ledger: false,
    bankroll_reason: 'no_club_scoped_authoritative_player_balance_series',
    cash_sessions: false,
    cash_sessions_reason: 'session_identity_has_no_final_stack_or_hand_foreign_key',
  },
  tournament_wallet: {
    totals: { debits: 10, credits: 25, net: 15 },
    entries: [
      {
        id: 'tx1',
        category: 'tournament_buyin',
        type: 'debit',
        amount: 10,
        created_at: '2026-10-03',
        tournament_id: 't1',
      },
    ],
    capped: true,
  },
  rakeback: {
    pending_amount: 2,
    paid_amount: 3,
    periods: [{ id: 'p1', status: 'pending', amount: 2, period_end: '2026-10-03' }],
    payout_receipts: [
      {
        id: 'r1',
        status: 'failed',
        payout_amount: 3,
        created_at: '2026-10-03',
        failure_reason: 'Treasury unavailable',
      },
    ],
  },
  bankroll: { available: false, series: [] },
  cash_sessions: { available: false, sessions: [] },
};
describe('FinancialReportingPanel', () => {
  beforeEach(() => get.mockReset());
  it('distinguishes receipts, capped coverage, failures and unavailable ledgers', async () => {
    get.mockResolvedValue(base);
    render(
      <FinancialReportingPanel
        userId="u"
        clubId="c"
        clubLabel="Exact Club"
        days={30}
        timezone="UTC"
        asset="chips"
      />
    );
    expect(await screen.findByText('Financial Reporting Vault')).toBeInTheDocument();
    expect(screen.getByText(/250 Most Recent/)).toBeInTheDocument();
    expect(screen.getByText('Payout Failed')).toBeInTheDocument();
    expect(screen.queryByText('Cash Sessions Not Yet Available')).not.toBeInTheDocument();
    expect(screen.getByText('Bankroll Series Not Yet Available')).toBeInTheDocument();
    expect(get).toHaveBeenCalledWith('u', 'c', 30, 'UTC', 'chips');
  });
  it('does not relabel chip receipts as Diamonds', async () => {
    get.mockResolvedValue({
      ...base,
      scope: { ...base.scope, asset: 'diamonds' },
      availability: { ...base.availability, tournament_wallet: false },
      tournament_wallet: { totals: {}, entries: [] },
      rakeback: { pending_amount: 0, paid_amount: 0, periods: [], payout_receipts: [] },
    });
    render(
      <FinancialReportingPanel
        userId="u"
        clubId="c"
        clubLabel="Diamond Club"
        days={30}
        timezone="UTC"
        asset="diamonds"
      />
    );
    expect(await screen.findByText('Diamond Tournament Receipts Unavailable')).toBeInTheDocument();
    expect(screen.getByText('Diamond Ledger')).toBeInTheDocument();
  });
  it('renders verification failure, not an empty ledger', async () => {
    get.mockResolvedValue(null);
    render(
      <FinancialReportingPanel
        userId="u"
        clubId={null}
        clubLabel="All Clubs"
        days={null}
        timezone="UTC"
        asset="chips"
      />
    );
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('Receipts Could Not Be Verified')
    );
    expect(screen.queryByText(/No Posted Tournament/)).not.toBeInTheDocument();
  });
});
