/**
 * THE CLUB BANK OVERLAY IS THE OWNER'S OWN SWITCH IN THE PRIZE WIZARD
 * (integration I1, 2026-09-23; migration 20260923143157).
 *
 * The database keeps a per-program opt-in, OFF unless chosen, that lets a paid
 * standalone club's own Club Bank pay only the missing chips of a round the
 * seed and the Promo Wallet cannot cover. Before this change the wizard never
 * sent it, so ANY republish from the wizard silently turned an owner's
 * opening opt-in off, and the step still printed "If Promo Falls Short: Round
 * Waits Unpaid" as the only behaviour there was. Every case below failed
 * against that wizard.
 *
 * The settlement card names an overlay-funded round's Club Bank leg; with no
 * overlay its two pinned labels are unchanged.
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  LeaderboardSettings,
  LeaderboardSettlementStatus,
} from '../../src/services/LeaderboardService';

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
import { LeaderboardSettlementCard } from '../../src/components/leaderboard/LeaderboardSettlementCard';

/** A standalone club whose paid program is already published (version 3). */
const standalonePaid = {
  club_id: 'club-1',
  club_name: 'Harbor Kings',
  union_id: null,
  union_name: null,
  funding_owner_type: 'club',
  funding_source: 'club_promo_balance',
  funding_label: 'Harbor Kings Promo Wallet',
  available_balance: 10_000,
  wallet_balance: 10_000,
  committed_balance: 300,
  current_program_commitment: 300,
  other_program_commitments: 0,
  available_uncommitted_balance: 9_700,
  publication_capacity: 10_000,
  committed_club_count: 1,
  funding_status: 'funded',
  can_manage: true,
  setup_complete: true,
  rewards_enabled: true,
  payout_currency: 'chips',
  payout_metric: 'profit',
  weekly_prizes: [{ rank: 1, amount: 300 }],
  monthly_prizes: [],
  suggestion_key: 'custom',
  program_version: 3,
  program_hash: 'hash-3',
  program_status: 'published',
  weekly_effective_from: '2026-09-20',
  monthly_effective_from: '2026-09-01',
  published_at: '2026-09-20T00:00:00Z',
  program_funding_owner_type: 'club',
  program_funding_union_id: null,
  program_funding_label: 'Harbor Kings Promo Wallet',
  overlay_enabled: false,
  setup_completed_at: '2026-09-20T00:00:00Z',
  updated_at: '2026-09-20T00:00:00Z',
} as LeaderboardSettings;

const unionPaid = {
  ...standalonePaid,
  union_id: 'union-1',
  union_name: 'North Circuit',
  funding_owner_type: 'union',
  funding_source: 'union_promo_wallet',
  funding_label: 'North Circuit Promo Wallet',
  program_funding_owner_type: 'union',
  program_funding_union_id: 'union-1',
  program_funding_label: 'North Circuit Promo Wallet',
} as LeaderboardSettings;

const open = (setup: LeaderboardSettings) =>
  render(<LeaderboardPrizeWizard isOpen setup={setup} onClose={vi.fn()} onSaved={vi.fn()} />);

const reviewRow = (label: string) => {
  const term = screen.getByText(label, { selector: 'dt' });
  return term.parentElement?.querySelector('dd')?.textContent;
};

const overlaySwitch = () =>
  within(screen.getByRole('group', { name: 'Shortfall Rule' })).getByRole('switch', {
    name: 'Club Bank Covers Shortfalls',
  });

async function toFunding(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: 'Continue' }));
}

async function fundingToReview(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: 'Continue' }));
  await user.click(screen.getByRole('button', { name: 'Continue' }));
}

async function publish(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: 'Publish Prize Program' }));
  await waitFor(() => expect(saveLeaderboardRewardSetup).toHaveBeenCalledTimes(1));
  return saveLeaderboardRewardSetup.mock.calls[0][1];
}

describe('a paid standalone program asks the owner about the Club Bank overlay', () => {
  beforeEach(() => {
    saveLeaderboardRewardSetup.mockReset();
    getLeaderboardRewardSetup.mockReset();
    saveLeaderboardRewardSetup.mockImplementation(async (clubId: string, payload: object) => ({
      ...standalonePaid,
      ...payload,
      club_id: clubId,
    }));
  });

  it('keeps an owner who opted in On when the plan is republished from the wizard', async () => {
    const user = userEvent.setup();
    open({ ...standalonePaid, overlay_enabled: true } as LeaderboardSettings);
    await toFunding(user);
    expect(overlaySwitch()).toBeChecked();

    await fundingToReview(user);
    expect(reviewRow('Club Bank Covers Shortfalls')).toBe('On');
    const submitted = await publish(user);
    // The silent switch-off this fixes: the republish carries the answer.
    expect(submitted).toMatchObject({ overlay_enabled: true, program_version: 3 });
  });

  it('is Off unless chosen, says no bank is used, and publishes Off', async () => {
    const user = userEvent.setup();
    open(standalonePaid);
    await toFunding(user);
    const overlay = overlaySwitch();
    expect(overlay).not.toBeChecked();
    expect(
      within(screen.getByRole('group', { name: 'Shortfall Rule' })).getByText('Off')
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        'A Closed Round Is Paid In Full Or Not At All. If Any Leftover Opening Prize Seed And The Promo Wallet Together Hold Less Than The Prizes, No Winner Is Paid, The Round Stays Unpaid, And The Daily Settlement Run Retries It Until They Cover It. The Club Bank Is Never Used.'
      )
    ).toBeInTheDocument();

    await fundingToReview(user);
    expect(reviewRow('Club Bank Covers Shortfalls')).toBe('Off');
    const submitted = await publish(user);
    expect(submitted.overlay_enabled).toBe(false);
  });

  it('turned On, says the Club Bank pays only the missing chips and publishes On', async () => {
    const user = userEvent.setup();
    open(standalonePaid);
    await toFunding(user);
    await user.click(overlaySwitch());
    expect(overlaySwitch()).toBeChecked();
    expect(
      within(screen.getByRole('group', { name: 'Shortfall Rule' })).getByText('On')
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        'A Closed Round Is Paid In Full Or Not At All. Any Leftover Opening Prize Seed Pays First, Then The Promo Wallet. If They Together Hold Less Than The Prizes, The Club Bank Pays Only The Missing Chips, As A Separate Overlay Entry. If The Club Bank Cannot Cover All Of Them Either, No Winner Is Paid, The Round Stays Unpaid, And The Daily Settlement Run Retries It.'
      )
    ).toBeInTheDocument();
    expect(screen.queryByText(/The Club Bank Is Never Used/)).not.toBeInTheDocument();

    await fundingToReview(user);
    expect(reviewRow('Club Bank Covers Shortfalls')).toBe('On');
    // Publication is still checked against the Promo Wallet alone.
    expect(screen.getByText(/The Club Bank Never Counts Toward That Check\./)).toBeInTheDocument();
    expect(
      screen.getByText(/Then The Club Bank For Only The Missing Chips, And Writes Immutable/)
    ).toBeInTheDocument();
    const submitted = await publish(user);
    expect(submitted.overlay_enabled).toBe(true);
  });

  it('never sends the opt-in with a plan that pays no prizes', async () => {
    const user = userEvent.setup();
    open({ ...standalonePaid, overlay_enabled: true } as LeaderboardSettings);
    await toFunding(user);
    expect(overlaySwitch()).toBeChecked();
    await user.click(screen.getByRole('button', { name: 'Back' }));
    await user.click(screen.getByRole('button', { name: /No Prizes Right Now/i }));
    await user.click(screen.getByRole('button', { name: 'Review Disabled Plan' }));
    expect(screen.queryByText('Club Bank Covers Shortfalls')).not.toBeInTheDocument();
    const submitted = await publish(user);
    expect(submitted).toMatchObject({ rewards_enabled: false, overlay_enabled: false });
  });

  it('starts again from the program the wizard is reopened with', async () => {
    const user = userEvent.setup();
    const props = { setup: standalonePaid, onClose: vi.fn(), onSaved: vi.fn() };
    const { rerender } = render(<LeaderboardPrizeWizard isOpen {...props} />);
    await toFunding(user);
    await user.click(overlaySwitch());
    expect(overlaySwitch()).toBeChecked();

    rerender(<LeaderboardPrizeWizard isOpen={false} {...props} />);
    rerender(<LeaderboardPrizeWizard isOpen {...props} />);
    await toFunding(user);
    expect(overlaySwitch()).not.toBeChecked();
  });
});

describe('a union-funded program keeps the fixed row and never sends the opt-in', () => {
  beforeEach(() => {
    saveLeaderboardRewardSetup.mockReset();
    saveLeaderboardRewardSetup.mockResolvedValue({ ...unionPaid, program_version: 4 });
  });

  it('offers no switch, and sends Off even if a stale record said On', async () => {
    const user = userEvent.setup();
    open({ ...unionPaid, overlay_enabled: true } as LeaderboardSettings);
    await toFunding(user);
    expect(screen.queryByRole('switch')).not.toBeInTheDocument();
    const rule = screen.getByLabelText('Shortfall Rule');
    expect(within(rule).getByText('If Promo Falls Short')).toBeInTheDocument();
    expect(within(rule).getByText('Round Waits Unpaid')).toBeInTheDocument();

    await fundingToReview(user);
    expect(reviewRow('If Promo Falls Short')).toBe('Round Waits Unpaid');
    const submitted = await publish(user);
    expect(submitted.overlay_enabled).toBe(false);
  });
});

describe('the settlement card names a Club Bank overlay as its own source', () => {
  const paid = (funding: { seed: number; promo: number; overlay?: number }) =>
    ({
      club_id: 'club-1',
      period: 'weekly',
      period_start: '2026-09-13',
      period_end: '2026-09-20',
      state: 'paid',
      can_manage: true,
      planned_total: 300,
      program: null,
      failure: null,
      receipts: [],
      batch: {
        id: 'batch-1',
        program_id: 'program-1',
        program_version: 3,
        program_hash: 'a'.repeat(64),
        metric: 'profit',
        funding_owner_type: 'club',
        funding_union_id: null,
        total_paid: funding.seed + funding.promo + (funding.overlay ?? 0),
        seed_funded: funding.seed,
        promo_funded: funding.promo,
        overlay_funded: funding.overlay ?? 0,
        winner_count: 1,
        tie_policy: 'split_occupied_places',
        settled_at: '2026-09-21T00:20:00Z',
      },
    }) as LeaderboardSettlementStatus;

  const funding = () =>
    screen.getByText('Funding', { selector: 'dt' }).parentElement?.querySelector('dd')?.textContent;

  it.each([
    [{ seed: 0, promo: 120, overlay: 180 }, 'Promo Wallet And Club Bank Overlay'],
    [{ seed: 50, promo: 70, overlay: 180 }, 'Seed And Promo Wallet And Club Bank Overlay'],
    // A Promo Wallet that was already empty paid nothing, so it is not named.
    [{ seed: 0, promo: 0, overlay: 300 }, 'Club Bank Overlay'],
    [{ seed: 40, promo: 0, overlay: 260 }, 'Seed And Club Bank Overlay'],
  ])('%o reads %s', (batch, label) => {
    render(<LeaderboardSettlementCard status={paid(batch)} onRetry={vi.fn()} />);
    expect(funding()).toBe(label);
    expect(screen.getByText('300 Chips')).toBeInTheDocument();
  });

  it('keeps both pinned labels exactly when there is no overlay', () => {
    const { unmount } = render(
      <LeaderboardSettlementCard status={paid({ seed: 0, promo: 300 })} onRetry={vi.fn()} />
    );
    expect(funding()).toBe('Promo Wallet');
    unmount();
    render(
      <LeaderboardSettlementCard status={paid({ seed: 100, promo: 200 })} onRetry={vi.fn()} />
    );
    expect(funding()).toBe('Seed And Promo Wallet');
  });
});
