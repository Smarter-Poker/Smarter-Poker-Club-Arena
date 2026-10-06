import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import PerformanceTab from '../../src/pages/stats/PerformanceTab';
import type { OverallStats } from '../../src/pages/stats/types';
import type { StatsMetricAvailabilityContract } from '../../src/services/statsContract';
import type { CashOpportunityStats } from '../../src/services/StatsFactsService';

vi.mock('../../src/components/stats/EVLuckChart', () => ({ default: () => null }));
vi.mock('../../src/components/stats/CashIntelligencePanel', () => ({ default: () => null }));

afterEach(cleanup);

const overall: OverallStats = {
  total_hands: 1_200,
  cash_hands: 1_000,
  tourney_hands: 200,
  tournaments_with_hands: 4,
  hands_won: 300,
  hands_lost: 900,
  vpip: 0.25,
  pfr: 0.18,
  three_bet_percent: 0,
  fold_to_three_bet: 0.4,
  cbet_flop: 0.5,
  aggression_factor: 1.4,
  showdowns_total: 100,
  showdowns_won: 50,
  wtsd: 0.3,
  total_profit: 200,
  total_winnings: 1_500,
  total_invested: 1_300,
  biggest_pot_won: 300,
  biggest_hand_loss: -150,
  bb_per_100: 2,
  hours_played: 10,
  hand_cap: 25_000,
  hands_capped: false,
};

const availability: StatsMetricAvailabilityContract = {
  three_bet_percent: false,
  three_bet_numerator: 24,
  three_bet_opportunities: null,
  fold_to_three_bet: true,
  fold_to_three_bet_opportunities: 50,
  cbet_flop: true,
  cbet_flop_opportunities: 100,
  aggression_factor: true,
  aggression_factor_denominator: 80,
  wtsd: true,
  wtsd_opportunities: 200,
  hours_played: false,
};

const exactCash = {
  contract_version: 2,
  coverage: {
    source: 'ca_hand_facts',
    from: '2026-09-01T00:00:00Z',
    club_id: 'club-1',
    exact_hands: 100,
    unavailable_hands: 0,
  },
  opportunities: {
    three_bet: { opportunities: 20, actions: 4 },
    four_bet: { opportunities: 0, actions: 0 },
    steal: { opportunities: 0, actions: 0 },
    squeeze: { opportunities: 0, actions: 0 },
    blind_defense: { opportunities: 0, actions: 0 },
    cbet_flop: { opportunities: 10, actions: 7 },
    barrel_turn: { opportunities: 0, actions: 0 },
    barrel_river: { opportunities: 0, actions: 0 },
    check_raise: { opportunities: 0, actions: 0 },
    donk: { opportunities: 0, actions: 0 },
    probe: { opportunities: 0, actions: 0 },
  },
  actions_by_street: {
    preflop: { aggressive: 0, passive: 0 },
    flop: { aggressive: 0, passive: 0 },
    turn: { aggressive: 0, passive: 0 },
    river: { aggressive: 0, passive: 0 },
  },
  context: {
    in_position_hands: 0,
    position_measured_hands: 0,
    average_effective_stack_bb: null,
  },
} satisfies CashOpportunityStats;

describe('Performance cash-stat evidence', () => {
  it('shows exact opportunities and confidence beside measurable rates', () => {
    render(
      <PerformanceTab
        clubId="club-1"
        metricAvailability={availability}
        overall={overall}
        showdownWinRate="50.0%"
        isOwnProfile={false}
        panelResetKey="cash-intelligence"
        targetUserId="user-1"
        windowDays={30}
        printing={false}
      />
    );

    const cbet = screen.getByText('C-Bet Flop').closest('.stat-row');
    expect(cbet).not.toBeNull();
    expect(within(cbet as HTMLElement).getByText(/100 Opportunities/)).toHaveTextContent(
      '95% Confidence 40.4% To 59.6%'
    );

    const wtsd = screen.getByText('WTSD').closest('.stat-row');
    expect(within(wtsd as HTMLElement).getByText(/200 Opportunities/)).toBeInTheDocument();
  });

  it('never presents an action count as a rate when its opportunity denominator is absent', () => {
    render(
      <PerformanceTab
        metricAvailability={availability}
        overall={overall}
        showdownWinRate="50.0%"
        isOwnProfile={false}
        panelResetKey="cash-intelligence"
        targetUserId="user-1"
        windowDays={30}
        printing={false}
      />
    );

    const threeBet = screen.getByText('3-Bet %').closest('.stat-row');
    expect(threeBet).not.toBeNull();
    expect(within(threeBet as HTMLElement).getByText('Not Yet Measured')).toBeInTheDocument();
    expect(
      within(threeBet as HTMLElement).getByText('Opportunity Denominator Unavailable')
    ).toBeInTheDocument();
  });

  it('overlays canonical cash opportunity rates when exact facts are available', () => {
    render(
      <PerformanceTab
        metricAvailability={availability}
        overall={overall}
        showdownWinRate="50.0%"
        isOwnProfile={false}
        panelResetKey="cash-intelligence"
        targetUserId="user-1"
        windowDays={30}
        printing={false}
        cashOpportunityStats={exactCash}
      />
    );
    const threeBet = screen.getByText('3-Bet %').closest('.stat-row');
    expect(within(threeBet as HTMLElement).getByText('20.0%')).toBeInTheDocument();
    const cbet = screen.getByText('C-Bet Flop').closest('.stat-row');
    expect(within(cbet as HTMLElement).getByText('70.0%')).toBeInTheDocument();
  });
});
