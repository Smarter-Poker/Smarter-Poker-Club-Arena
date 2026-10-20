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
      availability: { ...base.availability, tournament_wallet: false, rakeback: false },
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
    expect(screen.getByText('Diamond Rakeback Receipts Unavailable')).toBeInTheDocument();
    expect(screen.getByText('Diamond Ledger')).toBeInTheDocument();
    expect(screen.getAllByText('Unavailable')).toHaveLength(5);
    expect(screen.queryByText(/0 Diamonds/)).not.toBeInTheDocument();
    expect(
      screen.queryByText('No Posted Tournament Wallet Receipts In This Scope.')
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText('No Rakeback Period Or Payout Receipt In This Scope.')
    ).not.toBeInTheDocument();
  });
  it('shows every credit of one historical-payer payout and retains single receipts', async () => {
    get.mockResolvedValue({
      ...base,
      rakeback: {
        ...base.rakeback,
        paid_amount: 1.03,
        payout_receipts: [
          {
            id: 'split-payout',
            status: 'paid',
            payout_amount: 0.03,
            paid_at: '2026-10-19',
            wallet_transaction_id: null,
            wallet_transactions: [
              { wallet_transaction_id: 'credit-a', amount: 0.02 },
              { wallet_transaction_id: 'credit-b', amount: 0.01 },
            ],
          },
          {
            id: 'single-payout',
            status: 'paid',
            payout_amount: 1,
            paid_at: '2026-10-19',
            wallet_transaction_id: 'single-credit',
          },
        ],
      },
    });
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
    expect(await screen.findByText('Wallet Receipts')).toBeInTheDocument();
    expect(screen.getByText('credit-a (0.02 Chips); credit-b (0.01 Chips)')).toBeInTheDocument();
    expect(screen.getByText('single-credit')).toBeInTheDocument();
    expect(screen.queryByText('Not Issued')).not.toBeInTheDocument();
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
  it('retains every cent and formats timestamps in the selected report calendar', async () => {
    get.mockResolvedValue({
      ...base,
      scope: { ...base.scope, range_tz: 'America/Chicago' },
      tournament_wallet: { ...base.tournament_wallet, entries: [] },
      rakeback: {
        pending_amount: 0,
        paid_amount: 1234567.89,
        periods: [
          { id: 'calendar-period', status: 'paid', amount: 0.03, period_end: '2026-10-18' },
        ],
        payout_receipts: [
          {
            id: 'exact-payout',
            status: 'paid',
            payout_amount: 1234567.89,
            paid_at: '2026-10-19T02:00:00Z',
            wallet_transaction_id: 'exact-credit',
          },
        ],
      },
    });
    const { container } = render(
      <FinancialReportingPanel
        userId="u"
        clubId="c"
        clubLabel="Exact Club"
        days={30}
        timezone="America/Chicago"
        asset="chips"
      />
    );
    expect(await screen.findByText('exact-credit')).toBeInTheDocument();
    expect(screen.getAllByText('1,234,567.89 Chips')).toHaveLength(2);
    expect(screen.getByText('0.03 Chips')).toBeInTheDocument();
    expect([...container.querySelectorAll('time')].map((time) => time.textContent)).toEqual([
      '10/18/2026',
      '10/18/2026',
    ]);
  });
  it('never paints an older club response over the current club', async () => {
    let resolveA!: (value: typeof base) => void;
    let resolveB!: (value: typeof base) => void;
    get
      .mockReturnValueOnce(new Promise((resolve) => (resolveA = resolve)))
      .mockReturnValueOnce(new Promise((resolve) => (resolveB = resolve)));
    const { rerender } = render(
      <FinancialReportingPanel
        userId="u"
        clubId="a"
        clubLabel="Club A"
        days={30}
        timezone="UTC"
        asset="chips"
      />
    );
    rerender(
      <FinancialReportingPanel
        userId="u"
        clubId="b"
        clubLabel="Club B"
        days={30}
        timezone="UTC"
        asset="chips"
      />
    );
    resolveB({
      ...base,
      tournament_wallet: {
        ...base.tournament_wallet,
        totals: { debits: 1, credits: 100, net: 99 },
      },
    });
    expect(await screen.findByText('99 Chips')).toBeInTheDocument();
    resolveA(base);
    await Promise.resolve();
    expect(screen.getByText('99 Chips')).toBeInTheDocument();
  });
});
