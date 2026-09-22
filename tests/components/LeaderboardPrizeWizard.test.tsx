import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LeaderboardSettings } from '../../src/services/LeaderboardService';

const { saveLeaderboardRewardSetup, getLeaderboardRewardSetup } = vi.hoisted(() => ({
  saveLeaderboardRewardSetup: vi.fn(),
  getLeaderboardRewardSetup: vi.fn(),
}));

vi.mock('../../src/services/LeaderboardService', () => ({
  LeaderboardService: {
    saveLeaderboardRewardSetup,
    getLeaderboardRewardSetup,
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
  wallet_balance: 12_500,
  committed_balance: 2_500,
  current_program_commitment: 0,
  other_program_commitments: 2_500,
  available_uncommitted_balance: 10_000,
  publication_capacity: 10_000,
  committed_club_count: 2,
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
};

async function publishDefaultPlan(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: /Yes, Show Prizes/i }));
  await user.click(screen.getByRole('button', { name: 'Continue' }));
  await user.click(screen.getByRole('button', { name: 'Continue' }));
  await user.click(screen.getByRole('button', { name: 'Continue' }));
  await user.click(screen.getByRole('button', { name: 'Publish Prize Program' }));
}

describe('LeaderboardPrizeWizard', () => {
  beforeEach(() => {
    saveLeaderboardRewardSetup.mockReset();
    getLeaderboardRewardSetup.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
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
    expect(screen.getByText('10K')).toBeInTheDocument();

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

  it('reports a refused publish in plain words and tells the page its snapshot is stale', async () => {
    const user = userEvent.setup();
    const onSaved = vi.fn();
    const onSaveError = vi.fn();
    saveLeaderboardRewardSetup.mockRejectedValue(
      new Error('Leaderboard Prize Setup Changed In Another Session')
    );

    render(
      <LeaderboardPrizeWizard
        isOpen
        setup={setup}
        onClose={vi.fn()}
        onSaved={onSaved}
        onSaveError={onSaveError}
      />
    );

    await user.click(screen.getByRole('button', { name: /Yes, Show Prizes/i }));
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await user.click(screen.getByRole('button', { name: 'Publish Prize Program' }));

    await waitFor(() => expect(saveLeaderboardRewardSetup).toHaveBeenCalledTimes(1));
    expect(screen.getByRole('alert')).toHaveTextContent(
      'This Prize Setup Changed In Another Session. Close And Reopen To Load The Current Version.'
    );
    expect(onSaveError).toHaveBeenCalledTimes(1);
    expect(onSaved).not.toHaveBeenCalled();
    /* The custom amount inputs keep their accessible period in Title Case. */
    await user.click(screen.getByRole('button', { name: 'Back' }));
    await user.click(screen.getByRole('button', { name: /Custom/i }));
    expect(screen.getAllByLabelText(/^Weekly Prize For Rank 1$/)).toHaveLength(1);
  });

  it('keeps the funding refusal readable for a seven-figure club in a production build', async () => {
    /* DEV is off so the house sanitiser runs as it does for players. Its
       seven-digit marker used to swap this refusal for a generic line. */
    vi.stubEnv('DEV', false);
    const user = userEvent.setup();
    const onSaveError = vi.fn();
    saveLeaderboardRewardSetup.mockRejectedValue(
      new Error(
        'Leaderboard Prize Program Requires 1000000.00 Promo Chips But Only 250000.00 Are Available After Other Published Commitments'
      )
    );

    render(
      <LeaderboardPrizeWizard
        isOpen
        setup={setup}
        onClose={vi.fn()}
        onSaved={vi.fn()}
        onSaveError={onSaveError}
      />
    );
    await publishDefaultPlan(user);

    await waitFor(() => expect(onSaveError).toHaveBeenCalledTimes(1));
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent(
      'North Circuit Promo Wallet No Longer Covers This Plan After Other Published Commitments. Close And Reopen To See The Current Capacity.'
    );
    expect(alert).not.toHaveTextContent(/\d\.\d/);
  });

  it('never shows an owner raw database text in a production build', async () => {
    vi.stubEnv('DEV', false);
    const user = userEvent.setup();
    saveLeaderboardRewardSetup.mockRejectedValue(
      new Error(
        'column "p_expected_version" of relation "club_leaderboard_settings" does not exist'
      )
    );

    render(<LeaderboardPrizeWizard isOpen setup={setup} onClose={vi.fn()} onSaved={vi.fn()} />);
    await publishDefaultPlan(user);

    await waitFor(() => expect(saveLeaderboardRewardSetup).toHaveBeenCalledTimes(1));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent?.trim()).not.toBe('');
    expect(alert).not.toHaveTextContent(/relation|p_expected_version|does not exist/);
  });

  it('skips funding and plan steps when a first-time owner declines prizes', async () => {
    const user = userEvent.setup();
    const saved = { ...setup, setup_complete: true };
    saveLeaderboardRewardSetup.mockResolvedValue(saved);

    render(<LeaderboardPrizeWizard isOpen setup={setup} onClose={vi.fn()} onSaved={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: /No Prizes Right Now/i }));
    await user.click(screen.getByRole('button', { name: 'Review Disabled Plan' }));
    expect(screen.getByText('Prizes Disabled')).toBeInTheDocument();
    expect(screen.getAllByText('0 Chips')).toHaveLength(3);
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

  it('shows union-wide commitments and blocks an unfunded publication', async () => {
    const user = userEvent.setup();
    const unfundedSetup: LeaderboardSettings = {
      ...setup,
      rewards_enabled: true,
      setup_complete: true,
      weekly_prizes: [{ rank: 1, amount: 80 }],
      monthly_prizes: [{ rank: 1, amount: 40 }],
      wallet_balance: 350,
      committed_balance: 370,
      current_program_commitment: 120,
      other_program_commitments: 250,
      available_uncommitted_balance: 0,
      publication_capacity: 100,
      committed_club_count: 3,
      funding_status: 'underfunded',
    };

    render(
      <LeaderboardPrizeWizard isOpen setup={unfundedSetup} onClose={vi.fn()} onSaved={vi.fn()} />
    );

    await user.click(screen.getByRole('button', { name: /Yes, Show Prizes/i }));
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(screen.getByText('350 Chips')).toBeInTheDocument();
    expect(screen.getByText('370 Chips')).toBeInTheDocument();
    expect(screen.getByText('250 Chips')).toBeInTheDocument();
    expect(
      within(screen.getByLabelText('Funding Commitment Summary')).getByText('3')
    ).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(screen.getByRole('alert')).toHaveTextContent(
      'This Plan Cannot Be Published. Reduce The Combined Weekly And Monthly Commitment To 100 Promo Chips Or Less.'
    );
    expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled();
    expect(saveLeaderboardRewardSetup).not.toHaveBeenCalled();
  });

  describe('union template', () => {
    const templateClubs = [
      { club_id: 'club-2', club_name: 'Harbor Room' },
      { club_id: 'club-3', club_name: 'Summit Club' },
    ];
    const versions: Record<string, number> = { 'club-1': 0, 'club-2': 4, 'club-3': 7 };
    const fundingRefusal = new Error(
      'Leaderboard Prize Program Requires 5000.00 Promo Chips But Only 3000.00 Are Available After Other Published Commitments'
    );

    beforeEach(() => {
      getLeaderboardRewardSetup.mockImplementation(async (clubId: string) => ({
        ...setup,
        club_id: clubId,
        setup_complete: true,
        program_version: versions[clubId],
      }));
      saveLeaderboardRewardSetup.mockImplementation(
        async (clubId: string, payload: { program_version: number; rewards_enabled: boolean }) => ({
          ...setup,
          club_id: clubId,
          setup_complete: true,
          rewards_enabled: payload.rewards_enabled,
          program_version: payload.program_version + 1,
        })
      );
    });

    async function reviewWithTemplate(user: ReturnType<typeof userEvent.setup>) {
      await user.click(screen.getByRole('button', { name: /Yes, Show Prizes/i }));
      await user.click(screen.getByRole('button', { name: 'Continue' }));
      await user.click(screen.getByRole('button', { name: 'Continue' }));
      await user.click(screen.getByRole('button', { name: 'Continue' }));
      const clubs = screen.getByRole('group', { name: 'Other Union Clubs' });
      await user.click(within(clubs).getByRole('button', { name: 'Harbor Room' }));
      await user.click(within(clubs).getByRole('button', { name: 'Summit Club' }));
      expect(within(clubs).getByRole('button', { name: 'Harbor Room' })).toHaveAttribute(
        'aria-pressed',
        'true'
      );
      expect(screen.getByText(/^Publishing To 3 Clubs\./)).toBeInTheDocument();
      // This club's figure is not presented as the union-wide total.
      expect(screen.getByText('Uncommitted After This Club')).toBeInTheDocument();
      expect(screen.queryByText('Uncommitted After Publication')).not.toBeInTheDocument();
    }

    it("publishes the same plan to each chosen union club as that club's own next version", async () => {
      const user = userEvent.setup();
      const onSaved = vi.fn();
      render(
        <LeaderboardPrizeWizard
          isOpen
          setup={setup}
          onClose={vi.fn()}
          onSaved={onSaved}
          templateClubs={templateClubs}
        />
      );

      await reviewWithTemplate(user);
      await user.click(screen.getByRole('button', { name: 'Publish Prize Program' }));

      await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
      const calls = saveLeaderboardRewardSetup.mock.calls;
      expect(calls.map(([clubId, payload]) => [clubId, payload.program_version])).toEqual([
        ['club-1', 0],
        ['club-2', 4],
        ['club-3', 7],
      ]);
      // One plan, three clubs: the published rows are identical.
      expect(calls[1][1].weekly_prizes).toEqual(calls[0][1].weekly_prizes);
      expect(calls[2][1].monthly_prizes).toEqual(calls[0][1].monthly_prizes);
      expect(calls[2][1].suggestion_key).toBe(calls[0][1].suggestion_key);
      expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({ club_id: 'club-1' }), [
        { club_id: 'club-2', club_name: 'Harbor Room', ok: true, message: 'Program V5 Published.' },
        { club_id: 'club-3', club_name: 'Summit Club', ok: true, message: 'Program V8 Published.' },
      ]);
    });

    it('lists a refused club, retries only that club, and hands back the saved record when done', async () => {
      const user = userEvent.setup();
      const onSaved = vi.fn();
      const onClose = vi.fn();
      const defaultSave = saveLeaderboardRewardSetup.getMockImplementation()!;
      let summitAttempts = 0;
      saveLeaderboardRewardSetup.mockImplementation(
        async (clubId: string, payload: { program_version: number; rewards_enabled: boolean }) => {
          // The union wallet refuses Summit Club once, then covers it.
          if (clubId === 'club-3' && ++summitAttempts === 1) throw fundingRefusal;
          return defaultSave(clubId, payload);
        }
      );
      render(
        <LeaderboardPrizeWizard
          isOpen
          setup={setup}
          onClose={onClose}
          onSaved={onSaved}
          templateClubs={templateClubs}
        />
      );

      await reviewWithTemplate(user);
      await user.click(screen.getByRole('button', { name: 'Publish Prize Program' }));

      expect(await screen.findByRole('heading', { name: 'Template Results' })).toBeInTheDocument();
      expect(screen.getByText('Program V5 Published.')).toBeInTheDocument();
      // Beside a Retry button the refusal says what happened, not "close and reopen".
      expect(
        screen.getByText(
          "North Circuit Promo Wallet Cannot Cover This Club's Plan After Other Published Commitments."
        )
      ).toBeInTheDocument();
      expect(screen.queryByText(/Close And Reopen/)).not.toBeInTheDocument();
      // The step bar shows every step done while the results are on screen.
      expect(screen.getByRole('list', { name: 'Setup Progress' })).not.toContainHTML(
        'aria-current'
      );
      expect(onSaved).not.toHaveBeenCalled();

      getLeaderboardRewardSetup.mockClear();
      await user.click(screen.getByRole('button', { name: 'Retry Refused Clubs' }));
      expect(await screen.findByText('Program V8 Published.')).toBeInTheDocument();
      expect(getLeaderboardRewardSetup.mock.calls.map(([id]) => id)).toEqual(['club-3']);
      expect(screen.getByRole('button', { name: 'Retry Refused Clubs' })).toBeDisabled();

      await user.click(screen.getByRole('button', { name: 'Close Prize Setup' }));
      expect(onClose).not.toHaveBeenCalled();
      expect(onSaved).toHaveBeenCalledWith(
        expect.objectContaining({ club_id: 'club-1', program_version: 1 }),
        [
          expect.objectContaining({ club_id: 'club-2', ok: true }),
          expect.objectContaining({
            club_id: 'club-3',
            ok: true,
            message: 'Program V8 Published.',
          }),
        ]
      );
    });

    it('refuses a club that has left the union instead of funding the plan from its own wallet', async () => {
      const user = userEvent.setup();
      const onSaved = vi.fn();
      getLeaderboardRewardSetup.mockImplementation(async (clubId: string) => ({
        ...setup,
        club_id: clubId,
        program_version: versions[clubId],
        ...(clubId === 'club-2'
          ? { funding_owner_type: 'club', funding_source: 'club_promo_balance', union_id: null }
          : {}),
      }));
      render(
        <LeaderboardPrizeWizard
          isOpen
          setup={setup}
          onClose={vi.fn()}
          onSaved={onSaved}
          templateClubs={templateClubs}
        />
      );

      await reviewWithTemplate(user);
      await user.click(screen.getByRole('button', { name: 'Publish Prize Program' }));

      expect(
        await screen.findByText('This Club Is No Longer Funded By This Union.')
      ).toBeInTheDocument();
      expect(saveLeaderboardRewardSetup.mock.calls.map(([id]) => id)).toEqual(['club-1', 'club-3']);
      await user.click(screen.getByRole('button', { name: 'Done With Template Results' }));
      expect(onSaved).toHaveBeenCalledTimes(1);
    });

    it('offers no template to a standalone club', async () => {
      const user = userEvent.setup();
      render(<LeaderboardPrizeWizard isOpen setup={setup} onClose={vi.fn()} onSaved={vi.fn()} />);
      await user.click(screen.getByRole('button', { name: /Yes, Show Prizes/i }));
      await user.click(screen.getByRole('button', { name: 'Continue' }));
      await user.click(screen.getByRole('button', { name: 'Continue' }));
      await user.click(screen.getByRole('button', { name: 'Continue' }));
      expect(screen.queryByText('Use As A Union Template')).not.toBeInTheDocument();
    });
  });
});
