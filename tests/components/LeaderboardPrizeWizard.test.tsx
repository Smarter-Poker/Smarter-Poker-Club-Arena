import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LeaderboardSettings } from '../../src/services/LeaderboardService';

const { saveLeaderboardRewardSetup } = vi.hoisted(() => ({
  saveLeaderboardRewardSetup: vi.fn(),
}));

vi.mock('../../src/services/LeaderboardService', () => ({
  LeaderboardService: {
    saveLeaderboardRewardSetup,
  },
}));

vi.mock('../../src/hooks/useFocusTrap', () => ({
  useFocusTrap: () => ({ current: null }),
}));

import { LeaderboardPrizeWizard } from '../../src/components/leaderboard/LeaderboardPrizeWizard';

const setup: LeaderboardSettings = {
  club_id: 'club-1',
  club_name: 'River Room',
  union_id: 'union-1',
  union_name: 'North Circuit',
  funding_owner_type: 'union',
  funding_source: 'union_promo_wallet',
  funding_label: 'North Circuit Promo Wallet',
  available_balance: 10_000,
  can_manage: true,
  setup_complete: false,
  rewards_enabled: false,
  payout_currency: 'chips',
  payout_metric: 'profit',
  weekly_prizes: [],
  monthly_prizes: [],
  suggestion_key: 'balanced',
  program_version: 0,
  program_hash: null,
  program_status: 'not_published',
  weekly_effective_from: null,
  monthly_effective_from: null,
  published_at: null,
  program_funding_owner_type: null,
  program_funding_union_id: null,
  program_funding_label: null,
  setup_completed_at: null,
  updated_at: null,
};

describe('LeaderboardPrizeWizard', () => {
  beforeEach(() => {
    saveLeaderboardRewardSetup.mockReset();
  });

  it('portals the modal above persistent shell navigation instead of trapping it in the page layer', () => {
    const { container } = render(
      <LeaderboardPrizeWizard isOpen setup={setup} onClose={vi.fn()} onSaved={vi.fn()} />
    );

    const dialog = screen.getByRole('dialog', { name: 'Leaderboard Prize Setup' });
    expect(dialog.parentElement?.parentElement).toBe(document.body);
    expect(container).not.toContainElement(dialog);
  });

  it('walks an owner through a suggested union promo-wallet plan and saves it', async () => {
    const user = userEvent.setup();
    const onSaved = vi.fn();
    const saved = { ...setup, setup_complete: true, rewards_enabled: true };
    saveLeaderboardRewardSetup.mockResolvedValue(saved);

    render(<LeaderboardPrizeWizard isOpen setup={setup} onClose={vi.fn()} onSaved={onSaved} />);

    await user.click(screen.getByRole('button', { name: /Yes, Show Prizes/i }));
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(screen.getByText('North Circuit Promo Wallet')).toBeInTheDocument();
    expect(screen.getByText('10,000')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(screen.getByRole('button', { name: /Balanced Podium/i })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(screen.getByText('Starts Next Period')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Publish Prize Program' }));

    await waitFor(() => expect(saveLeaderboardRewardSetup).toHaveBeenCalledTimes(1));
    expect(saveLeaderboardRewardSetup).toHaveBeenCalledWith(
      'club-1',
      expect.objectContaining({
        rewards_enabled: true,
        payout_metric: 'profit',
        suggestion_key: 'balanced',
      })
    );
    const submitted = saveLeaderboardRewardSetup.mock.calls[0][1];
    expect(submitted.weekly_prizes).toEqual([
      { rank: 1, amount: 50 },
      { rank: 2, amount: 30 },
      { rank: 3, amount: 20 },
    ]);
    expect(submitted).not.toHaveProperty('funding_source');
    expect(onSaved).toHaveBeenCalledWith(saved);
  });

  it('skips funding and plan steps when a first-time owner declines prizes', async () => {
    const user = userEvent.setup();
    const saved = { ...setup, setup_complete: true };
    saveLeaderboardRewardSetup.mockResolvedValue(saved);

    render(<LeaderboardPrizeWizard isOpen setup={setup} onClose={vi.fn()} onSaved={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: /No Prizes Right Now/i }));
    await user.click(screen.getByRole('button', { name: 'Review Disabled Plan' }));
    expect(screen.getByText('Prizes Disabled')).toBeInTheDocument();
    expect(screen.getAllByText('0 Chips')).toHaveLength(2);
    await user.click(screen.getByRole('button', { name: 'Back' }));
    expect(screen.getByText('Do You Want To Reward Leaderboard Prizes?')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Review Disabled Plan' }));
    await user.click(screen.getByRole('button', { name: 'Publish Prize Program' }));

    await waitFor(() => expect(saveLeaderboardRewardSetup).toHaveBeenCalledTimes(1));
    expect(saveLeaderboardRewardSetup).toHaveBeenCalledWith(
      'club-1',
      expect.objectContaining({
        rewards_enabled: false,
        weekly_prizes: [],
        monthly_prizes: [],
      })
    );
  });

  it('makes the custom budget control change the rows that are actually published', async () => {
    const user = userEvent.setup();
    saveLeaderboardRewardSetup.mockResolvedValue({
      ...setup,
      setup_complete: true,
      rewards_enabled: true,
    });

    render(<LeaderboardPrizeWizard isOpen setup={setup} onClose={vi.fn()} onSaved={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: /Yes, Show Prizes/i }));
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await user.click(screen.getByRole('button', { name: /Custom/i }));
    const budgets = screen.getAllByRole('spinbutton', { name: 'Prize Budget' });
    await user.clear(budgets[0]);
    await user.type(budgets[0], '250');
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await user.click(screen.getByRole('button', { name: 'Publish Prize Program' }));

    await waitFor(() => expect(saveLeaderboardRewardSetup).toHaveBeenCalledTimes(1));
    expect(saveLeaderboardRewardSetup.mock.calls[0][1].weekly_prizes).toEqual([
      { rank: 1, amount: 125 },
      { rank: 2, amount: 75 },
      { rank: 3, amount: 50 },
    ]);
  });
});
