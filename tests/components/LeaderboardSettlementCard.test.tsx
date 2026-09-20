import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { LeaderboardSettlementStatus } from '../../src/services/LeaderboardService';
import { LeaderboardSettlementCard } from '../../src/components/leaderboard/LeaderboardSettlementCard';

const openStatus: LeaderboardSettlementStatus = {
  club_id: 'club-1',
  period: 'weekly',
  period_start: '2026-09-06',
  period_end: '2026-09-13',
  state: 'open',
  can_manage: false,
  planned_total: 500,
  program: {
    program_id: 'program-1',
    program_version: 3,
    program_hash: 'a'.repeat(64),
    status: 'published',
    rewards_enabled: true,
    period: 'weekly',
    period_start: '2026-09-06',
    payout_metric: 'profit',
    prizes: [{ rank: 1, amount: 500 }],
    funding_owner_type: 'union',
    funding_union_id: 'union-1',
    published_at: '2026-09-05T12:00:00Z',
  },
  batch: null,
  failure: null,
  receipts: [],
};

describe('LeaderboardSettlementCard', () => {
  it('shows the live prize contract and exact UTC window', () => {
    render(<LeaderboardSettlementCard status={openStatus} onRetry={vi.fn()} />);

    expect(screen.getByRole('heading', { name: 'Prize Round In Progress' })).toBeInTheDocument();
    expect(screen.getByText('500 Chips')).toBeInTheDocument();
    expect(screen.getByText('V3')).toBeInTheDocument();
    expect(screen.getByText(/Sep 6, 2026 To Sep 13, 2026 · UTC/)).toBeInTheDocument();
  });

  it('gives an owner safe recovery guidance without exposing a payout button', async () => {
    const onReviewSetup = vi.fn();
    const user = userEvent.setup();
    render(
      <LeaderboardSettlementCard
        status={{
          ...openStatus,
          state: 'failed',
          can_manage: true,
          failure: {
            error_code: 'promo_wallet_underfunded',
            attempt_count: 2,
            first_failed_at: '2026-09-13T00:20:00Z',
            last_failed_at: '2026-09-14T00:20:00Z',
            automatic_retry: true,
            owner_message:
              'Add Promo Chips To Cover The Published Prize Pool. Automatic Retry Is Active.',
          },
        }}
        onRetry={vi.fn()}
        onReviewSetup={onReviewSetup}
      />
    );

    expect(screen.queryByText(/No Partial Payout/i)).not.toBeInTheDocument();
    expect(screen.getByText(/Add Promo Chips To Cover/)).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /Pay|Settle|Retry Payout/i })
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Review Prize Setup' }));
    expect(onReviewSetup).toHaveBeenCalledTimes(1);
  });

  it('shows a signed-in winner the immutable receipt linked to the batch', () => {
    render(
      <LeaderboardSettlementCard
        status={{
          ...openStatus,
          state: 'paid',
          planned_total: 150,
          batch: {
            id: 'batch-1234',
            program_id: 'program-1',
            program_version: 3,
            program_hash: 'a'.repeat(64),
            metric: 'profit',
            funding_owner_type: 'union',
            funding_union_id: 'union-1',
            total_paid: 150,
            seed_funded: 0,
            promo_funded: 150,
            winner_count: 2,
            tie_policy: 'split_occupied_places',
            settled_at: '2026-09-13T00:20:00Z',
          },
          receipts: [
            {
              id: 'abcdef12-0000-0000-0000-000000000000',
              batch_id: 'batch-1234',
              user_id: 'player-1',
              rank: 1,
              payout_amount: 75,
              payout_currency: 'chips',
              awarded_at: '2026-09-13T00:20:00Z',
            },
          ],
        }}
        currentUserId="player-1"
        onRetry={vi.fn()}
      />
    );

    expect(screen.getByRole('heading', { name: 'Payouts Verified' })).toBeInTheDocument();
    expect(screen.getByText('Your Verified Receipt')).toBeInTheDocument();
    expect(screen.getByText('75 Chips')).toBeInTheDocument();
    expect(screen.getByText(/Receipt ABCDEF12/)).toBeInTheDocument();
    expect(screen.getByText('Promo Wallet')).toBeInTheDocument();
    expect(screen.getByText('Tied Places Share Their Occupied Prizes.')).toBeInTheDocument();
  });

  it('prints the funding the batch row actually recorded when a seed paid part of it', () => {
    render(
      <LeaderboardSettlementCard
        status={{
          ...openStatus,
          state: 'paid',
          planned_total: 150,
          batch: {
            id: 'batch-5678',
            program_id: 'program-1',
            program_version: 3,
            program_hash: 'a'.repeat(64),
            metric: 'profit',
            funding_owner_type: 'club',
            funding_union_id: null,
            total_paid: 150,
            seed_funded: 100,
            promo_funded: 50,
            winner_count: 2,
            tie_policy: 'split_occupied_places',
            settled_at: '2026-09-13T00:20:00Z',
          },
        }}
        onRetry={vi.fn()}
      />
    );

    expect(screen.getByText('Seed 100 And Promo 50 Chips')).toBeInTheDocument();
    expect(screen.queryByText('Promo Only')).not.toBeInTheDocument();
  });

  it('states the tie rule on a pending round, not only the live one', () => {
    render(
      <LeaderboardSettlementCard status={{ ...openStatus, state: 'pending' }} onRetry={vi.fn()} />
    );

    expect(screen.getByRole('heading', { name: 'Settlement Pending' })).toBeInTheDocument();
    expect(screen.getByText('Tied Places Share Their Occupied Prizes.')).toBeInTheDocument();
  });

  it('keeps a transport failure explicit and retryable', async () => {
    const onRetry = vi.fn();
    const user = userEvent.setup();
    render(
      <LeaderboardSettlementCard
        status={null}
        error="Period Settlement Could Not Be Verified."
        onRetry={onRetry}
      />
    );

    await user.click(screen.getByRole('button', { name: 'Retry Status' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});
