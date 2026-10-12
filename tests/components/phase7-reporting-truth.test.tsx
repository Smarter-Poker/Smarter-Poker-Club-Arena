import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import TournamentsTab from '../../src/pages/stats/TournamentsTab';
import RakeTab from '../../src/pages/stats/RakeTab';
import SessionHistory from '../../src/components/stats/SessionHistory';
import type { FullStats, OverallStats, TournamentSummary } from '../../src/pages/stats/types';

vi.mock('../../src/components/agent/DownlineRakePanel', () => ({ default: () => null }));

afterEach(cleanup);

const overall = {
  total_hands: 1,
  cash_hands: 0,
  tourney_hands: 1,
  tournaments_with_hands: 1,
  hands_won: 0,
  hands_lost: 1,
  vpip: 0,
  pfr: 0,
  three_bet_percent: 0,
  fold_to_three_bet: 0,
  cbet_flop: 0,
  aggression_factor: 0,
  showdowns_total: 0,
  showdowns_won: 0,
  wtsd: 0,
  total_profit: 0,
  total_winnings: 0,
  total_invested: 0,
  biggest_pot_won: 0,
  biggest_hand_loss: 0,
  bb_per_100: 0,
  hours_played: 0,
  hand_cap: 25_000,
  hands_capped: false,
} satisfies OverallStats;

const tournament = {
  entries: 1,
  cashes: 1,
  wins: 1,
  best_finish: 1,
  itm_percent: 1,
  total_buyins: 100,
  total_winnings: 250,
  total_prizes: 200,
  total_bounty_winnings: 50,
  total_bounties: 1,
  net_profit: 150,
  roi: 1.5,
} satisfies TournamentSummary;

describe('Phase 7 reporting truth', () => {
  it('labels reconstructed tournament accounting and distinguishes finalized dates', () => {
    const full = {
      recent_tournaments: [
        {
          tournament_id: 't-1',
          name: 'Final Table',
          start_time: '2026-09-01T00:00:00Z',
          ended_at: '2026-09-02T12:00:00Z',
          variant: 'nlh',
          is_mystery_bounty: false,
          finish_rank: 1,
          status: 'winner',
          prize: 200,
          bounty_winnings: 50,
          bounties: 1,
          total_won: 250,
          buyin: 100,
        },
      ],
    } as FullStats;

    render(
      <MemoryRouter>
        <TournamentsTab tourn={tournament} overall={overall} full={full} />
      </MemoryRouter>
    );

    expect(screen.getByText(/Registration, Rebuy,/)).toHaveTextContent('Not Yet Reconciled');
    expect(screen.getByText('Estimated Entry Costs')).toBeInTheDocument();
    expect(screen.getByText('Reconstructed Net')).toBeInTheDocument();
    expect(screen.getByText(/Finalized Sep 2, 2026/)).toBeInTheDocument();
    expect(screen.queryByText('Total Buy-Ins')).not.toBeInTheDocument();
  });

  it('marks a tournament result provisional when no final event date is supplied', () => {
    const full = {
      recent_tournaments: [
        {
          tournament_id: null,
          name: 'Still Running',
          start_time: '2026-09-01T00:00:00Z',
          ended_at: null,
          variant: 'nlh',
          is_mystery_bounty: false,
          finish_rank: null,
          status: 'playing',
          prize: 0,
          bounty_winnings: 0,
          bounties: 0,
          total_won: 0,
          buyin: 100,
        },
      ],
    } as FullStats;

    render(
      <MemoryRouter>
        <TournamentsTab tourn={tournament} overall={overall} full={full} />
      </MemoryRouter>
    );
    expect(screen.getByText(/Result May Be Provisional/)).toBeInTheDocument();
  });

  it('never calls hand-gap groups cashier sessions or their derived amounts buy-ins', () => {
    render(
      <SessionHistory
        rangeLabel="30 Days"
        initialSessions={[
          {
            id: 1,
            date: '2026-09-02T00:00:00Z',
            duration_minutes: 60,
            hands_played: 20,
            buy_in: 500,
            cash_out: 620,
            profit_loss: 120,
          },
        ]}
      />
    );

    expect(screen.getByRole('heading', { name: 'Hand-Derived Sessions' })).toBeInTheDocument();
    expect(screen.getByText(/These Are Not Cashier Sessions/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByText('Chips Invested In Hands')).toBeInTheDocument();
    expect(screen.getByText('Returned From Hands')).toBeInTheDocument();
    expect(screen.queryByText('Buy-In')).not.toBeInTheDocument();
    expect(screen.queryByText('Cash-Out')).not.toBeInTheDocument();
  });

  it('states rake coverage without presenting rakeback as part of the readout', () => {
    render(
      <RakeTab
        rakeLoading={false}
        rakeError={false}
        rakeStats={{
          hands: 20,
          raked_hands: 10,
          rake_paid: 25,
          rake_per_100: 125,
          rake_in_bb: 5,
          bb_per_100: 0,
          avg_rake_per_raked_hand: 2.5,
          first_hand_at: '2026-09-01T00:00:00Z',
          last_hand_at: '2026-09-02T00:00:00Z',
          days: 30,
        }}
        onRetryRake={vi.fn()}
        agentRoles={[]}
        agentRolesError={false}
        onRetryAgentRoles={vi.fn()}
        isOwnProfile
        panelResetKey="phase-7"
      />
    );

    expect(screen.getByText(/Rakeback Payments/)).toHaveTextContent('Not Included');
    expect(
      within(screen.getByText('Rake Paid').closest('.stat-row') as HTMLElement).getByText('25')
    ).toBeInTheDocument();
  });
});
