/**
 * The prize wizard's figures (2026-09-23): whole-chip places that add up to
 * exactly the budget and are exactly what is published, exact figures where
 * the owner confirms money, and funding copy that says only what today's SQL
 * does. Each case here failed against the wizard before this change.
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LeaderboardSettings } from '../../src/services/LeaderboardService';

const { saveLeaderboardRewardSetup, getLeaderboardRewardSetup } = vi.hoisted(() => ({
  saveLeaderboardRewardSetup: vi.fn(),
  getLeaderboardRewardSetup: vi.fn(),
}));

vi.mock('../../src/services/LeaderboardService', () => ({
  LeaderboardService: { saveLeaderboardRewardSetup, getLeaderboardRewardSetup },
}));

vi.mock('../../src/hooks/useFocusTrap', () => ({
  useFocusTrap: () => ({ current: null }),
}));

import { LeaderboardPrizeWizard } from '../../src/components/leaderboard/LeaderboardPrizeWizard';

const standalone: LeaderboardSettings = {
  club_id: 'club-1',
  club_name: 'Harbor Kings',
  union_id: null,
  union_name: null,
  funding_owner_type: 'club',
  funding_source: 'club_promo_balance',
  funding_label: 'Harbor Kings Promo Wallet',
  available_balance: 10_000,
  wallet_balance: 10_000,
  committed_balance: 0,
  current_program_commitment: 0,
  other_program_commitments: 0,
  available_uncommitted_balance: 10_000,
  publication_capacity: 10_000,
  committed_club_count: 0,
  funding_status: 'not_published',
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
} as LeaderboardSettings;

const union: LeaderboardSettings = {
  ...standalone,
  union_id: 'union-1',
  union_name: 'North Circuit',
  funding_owner_type: 'union',
  funding_source: 'union_promo_wallet',
  funding_label: 'North Circuit Promo Wallet',
} as LeaderboardSettings;

const open = (setup: LeaderboardSettings) =>
  render(<LeaderboardPrizeWizard isOpen setup={setup} onClose={vi.fn()} onSaved={vi.fn()} />);

const placeValues = (period: 'Weekly' | 'Monthly') =>
  [1, 2, 3, 4, 5].map(
    (rank) => (screen.getByLabelText(`${period} Prize For Rank ${rank}`) as HTMLInputElement).value
  );

const reviewRow = (label: string) => {
  const term = screen.getByText(label, { selector: 'dt' });
  return term.parentElement?.querySelector('dd')?.textContent;
};

describe('the prize wizard prints whole chips and publishes exactly what it shows', () => {
  beforeEach(() => {
    saveLeaderboardRewardSetup.mockReset();
    getLeaderboardRewardSetup.mockReset();
    saveLeaderboardRewardSetup.mockResolvedValue({ ...standalone, setup_complete: true });
  });

  it('splits an Even Podium into whole chips that add up to the budget, odd chip to first', async () => {
    const user = userEvent.setup();
    open(standalone);
    await user.click(screen.getByRole('button', { name: /Yes, Show Prizes/i }));
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await user.click(screen.getByRole('button', { name: /Even Podium/i }));

    // The suggested budgets for a 10,000-chip wallet are 100 and 400. In cents
    // these were 33.33 / 33.33 / 33.34 and 133.33 / 133.33 / 133.34.
    expect(placeValues('Weekly')).toEqual(['34', '33', '33', '', '']);
    expect(placeValues('Monthly')).toEqual(['134', '133', '133', '', '']);

    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(reviewRow('Weekly Places')).toBe('34 / 33 / 33');
    await user.click(screen.getByRole('button', { name: 'Publish Prize Program' }));

    await waitFor(() => expect(saveLeaderboardRewardSetup).toHaveBeenCalledTimes(1));
    const submitted = saveLeaderboardRewardSetup.mock.calls[0][1];
    expect(submitted.weekly_prizes).toEqual([
      { rank: 1, amount: 34 },
      { rank: 2, amount: 33 },
      { rank: 3, amount: 33 },
    ]);
    expect(submitted.monthly_prizes).toEqual([
      { rank: 1, amount: 134 },
      { rank: 2, amount: 133 },
      { rank: 3, amount: 133 },
    ]);
  });

  it('prints the figures being confirmed in full, never abbreviated, and publishes them', async () => {
    const user = userEvent.setup();
    open({
      ...standalone,
      available_balance: 1_234_567.89,
      wallet_balance: 1_234_567.89,
      available_uncommitted_balance: 1_234_567.89,
      publication_capacity: 1_234_567.89,
    } as LeaderboardSettings);
    await user.click(screen.getByRole('button', { name: /Yes, Show Prizes/i }));
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    // A balance at a glance stays compact.
    expect(screen.getByText('1.2M')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Continue' }));

    // Balanced on 12,345 is 6,172.50 / 3,703.50 / 2,469 in cents.
    expect(placeValues('Weekly')).toEqual(['6173', '3703', '2469', '', '']);
    // Balanced on 49,382 is 24,691 / 14,814.60 / 9,876.40 in cents.
    expect(placeValues('Monthly')).toEqual(['24691', '14815', '9876', '', '']);

    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(reviewRow('Weekly Places')).toBe('6,173 / 3,703 / 2,469');
    expect(reviewRow('Weekly Total')).toBe('12,345 Chips');
    expect(reviewRow('Monthly Places')).toBe('24,691 / 14,815 / 9,876');
    expect(reviewRow('Monthly Total')).toBe('49,382 Chips');
    expect(reviewRow('Combined Commitment')).toBe('61,727 Chips');
    expect(screen.queryByText(/\d\.\dK Chips|\d\.\d{2}/)).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Publish Prize Program' }));
    await waitFor(() => expect(saveLeaderboardRewardSetup).toHaveBeenCalledTimes(1));
    const submitted = saveLeaderboardRewardSetup.mock.calls[0][1];
    const all = [...submitted.weekly_prizes, ...submitted.monthly_prizes];
    expect(all.every((prize: { amount: number }) => Number.isInteger(prize.amount))).toBe(true);
    expect(submitted.weekly_prizes.map((prize: { amount: number }) => prize.amount)).toEqual([
      6173, 3703, 2469,
    ]);
    expect(submitted.monthly_prizes.map((prize: { amount: number }) => prize.amount)).toEqual([
      24691, 14815, 9876,
    ]);
  });

  it('opens a program published in cents as whole chips of its own total, and republishes those', async () => {
    const user = userEvent.setup();
    open({
      ...standalone,
      setup_complete: true,
      rewards_enabled: true,
      suggestion_key: 'even',
      weekly_prizes: [
        { rank: 1, amount: 33.33 },
        { rank: 2, amount: 33.33 },
        { rank: 3, amount: 33.34 },
      ],
      monthly_prizes: [],
      program_version: 3,
    } as LeaderboardSettings);
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(placeValues('Weekly')).toEqual(['34', '33', '33', '', '']);
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await user.click(screen.getByRole('button', { name: 'Publish Prize Program' }));
    await waitFor(() => expect(saveLeaderboardRewardSetup).toHaveBeenCalledTimes(1));
    expect(saveLeaderboardRewardSetup.mock.calls[0][1].weekly_prizes).toEqual([
      { rank: 1, amount: 34 },
      { rank: 2, amount: 33 },
      { rank: 3, amount: 33 },
    ]);
  });

  it('keeps a typed custom place and budget to whole chips', async () => {
    const user = userEvent.setup();
    open(standalone);
    await user.click(screen.getByRole('button', { name: /Yes, Show Prizes/i }));
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    fireEvent.change(screen.getByLabelText('Weekly Prize For Rank 1'), {
      target: { value: '12.7' },
    });
    expect(placeValues('Weekly')).toEqual(['12', '30', '20', '', '']);
    const budgets = screen.getAllByRole('spinbutton', { name: 'Prize Budget' });
    fireEvent.change(budgets[0], { target: { value: '101.9' } });
    const weekly = placeValues('Weekly').map(Number);
    expect(weekly.every(Number.isInteger)).toBe(true);
    expect(weekly.reduce((sum, amount) => sum + amount, 0)).toBe(101);
  });

  it('states the limit a refused plan must fit under exactly, not abbreviated', async () => {
    const user = userEvent.setup();
    open({
      ...standalone,
      setup_complete: true,
      rewards_enabled: true,
      weekly_prizes: [{ rank: 1, amount: 20_000 }],
      publication_capacity: 12_345.67,
      available_balance: 12_345.67,
    } as LeaderboardSettings);
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(screen.getByRole('alert')).toHaveTextContent(
      'This Plan Cannot Be Published. Reduce The Combined Weekly And Monthly Commitment To 12,345 Promo Chips Or Less.'
    );
  });
});

describe('the wizard says only what the settlement and publication SQL do', () => {
  it('names the leftover opening seed a standalone settlement draws first, and no bank', async () => {
    const user = userEvent.setup();
    open(standalone);
    await user.click(screen.getByRole('button', { name: /Yes, Show Prizes/i }));
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(
      screen.getByText(
        'Harbor Kings Is Standalone, So Its Promo Wallet Pays Its Leaderboard Prizes. Any Leaderboard Prize Seed Left From Opening Is Used First.'
      )
    ).toBeInTheDocument();
    const rule = screen.getByLabelText('Shortfall Rule');
    expect(within(rule).getByText('If Promo Falls Short')).toBeInTheDocument();
    expect(within(rule).getByText('Round Waits Unpaid')).toBeInTheDocument();
    expect(screen.getByText(/No Winner Is Paid, The Round Stays Unpaid/)).toHaveTextContent(
      'The Club Bank Is Never Used.'
    );

    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(screen.getByText('Publishing Checks Funding And Moves No Chips.')).toBeInTheDocument();
    expect(screen.getByText(/Its Chips Are Not Locked\./)).toBeInTheDocument();
    expect(reviewRow('If Promo Falls Short')).toBe('Round Waits Unpaid');
    // The claim this replaced read as if publishing reserved the chips.
    expect(screen.queryByText(/Claims Funding Capacity/)).not.toBeInTheDocument();
  });

  it('keeps every bank out of a union-funded round', async () => {
    const user = userEvent.setup();
    open(union);
    await user.click(screen.getByRole('button', { name: /Yes, Show Prizes/i }));
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(
      screen.getByText(
        'This Club Belongs To North Circuit, So The Union Promo Wallet Pays Its Leaderboard Prizes.'
      )
    ).toBeInTheDocument();
    expect(screen.getByText(/No Winner Is Paid/)).toHaveTextContent(
      'The Union Bank And Club Banks Are Never Used.'
    );
    expect(screen.queryByText(/Seed/)).not.toBeInTheDocument();
  });
});

describe('the console fits the screen and only the step scrolls', () => {
  const css = readFileSync('src/components/leaderboard/LeaderboardPrizeWizard.css', 'utf8');

  it('caps the console at the viewport and never shrinks the painted head or foot', () => {
    expect(css).toMatch(/\.lb-prize-wizard \.sc \{[^}]*max-height: calc\(100dvh - 24px[^}]*\}/);
    expect(css).toMatch(
      /\.lb-prize-wizard \.sc > \.sc__head,\s*\.lb-prize-wizard \.sc > \.sc__foot \{\s*flex: 0 0 auto;/
    );
  });

  it('scrolls the step inside the glass, outside the painted foot', () => {
    expect(css).toMatch(
      /\.lb-prize-wizard \.sc__body > \.lb-prize-wizard-body \{[^}]*overflow-y: auto;[^}]*\}/
    );
    expect(css).toMatch(/\.lb-prize-wizard \.sc > \.sc__body \{[^}]*min-height: 0;[^}]*\}/);
  });

  it('narrows the console on a short screen from the painted head and foot ratio', () => {
    // head 348 + plates 277 = 0.625 of the console's width, plus the body's
    // own rows at about 0.1 of it.
    expect(css).toMatch(/--sc-max: min\(\s*640px,[\s\S]*100dvh[\s\S]*\/\s*0\.725/);
  });
});
