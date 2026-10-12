import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import HoleCardHeatmap from '../../src/components/stats/HoleCardHeatmap';
import SessionHistory from '../../src/components/stats/SessionHistory';
import TrophyRoom from '../../src/components/stats/TrophyRoom';
import TournamentsTab from '../../src/pages/stats/TournamentsTab';
import StatsFactsService from '../../src/services/StatsFactsService';
import { StatsEvidenceService } from '../../src/services/StatsEvidenceService';

vi.mock('../../src/services/StatsFactsService', () => ({
  default: {
    getHandGrid: vi.fn(),
    getClassHands: vi.fn(),
  },
}));

vi.mock('../../src/services/StatsEvidenceService', () => ({
  StatsEvidenceService: { list: vi.fn() },
}));

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location">{`${location.pathname}${location.search}`}</output>;
}

const renderWithRoutes = (node: React.ReactNode) =>
  render(
    <MemoryRouter initialEntries={['/stats?tab=hands&statsClub=club-7']}>
      <Routes>
        <Route
          path="*"
          element={
            <>
              {node}
              <LocationProbe />
            </>
          }
        />
      </Routes>
    </MemoryRouter>
  );

describe('Stats evidence destinations', () => {
  beforeEach(() => vi.clearAllMocks());

  it('opens the exact heatmap hand and preserves selected club evidence scope', async () => {
    vi.mocked(StatsFactsService.getHandGrid).mockResolvedValue({
      cells: [
        {
          hand_class: 'AA',
          hands: 31,
          hands_vpip: 31,
          hands_won: 20,
          vpip_pct: 1,
          net_bb: 8,
          ev_net_bb: 6,
          bb100: 25,
        },
      ],
      totals: { hands: 31, classes_seen: 1 },
      filters: { position: null, variant: null, days: null },
      generated_at: '',
      scope: 'chips',
    });
    vi.mocked(StatsFactsService.getClassHands).mockResolvedValue({
      hand_class: 'AA',
      hands: [
        {
          hand_id: 'hand-7',
          played_at: '2026-10-03T10:00:00Z',
          position: 'BTN',
          net: 20,
          net_bb: 10,
          big_blind: 2,
          variant: 'nlh',
          was_all_in: false,
          showdown: true,
          won: true,
          hole_cards: null,
        },
      ],
      scope: 'chips',
    });

    renderWithRoutes(<HoleCardHeatmap userId="user-1" clubId="club-7" />);
    fireEvent.click(await screen.findByRole('gridcell', { name: /AA, 31 Hands/i }));
    fireEvent.click(await screen.findByRole('link', { name: 'Open AA Hand Evidence' }));

    expect(screen.getByTestId('location')).toHaveTextContent(
      '/hand-history?hand=hand-7&source=stats&statsClub=club-7'
    );
  });

  it('links tournaments only when an authoritative tournament id exists', () => {
    const full = {
      recent_tournaments: [
        {
          tournament_id: 't-1',
          name: 'Friday Major',
          start_time: null,
          variant: 'nlh',
          is_mystery_bounty: false,
          finish_rank: 2,
          status: 'complete',
          prize: 100,
          bounty_winnings: 0,
          bounties: 0,
          total_won: 100,
          buyin: 10,
        },
        {
          tournament_id: null,
          name: 'Imported Result',
          start_time: null,
          variant: 'nlh',
          is_mystery_bounty: false,
          finish_rank: 4,
          status: 'complete',
          prize: 20,
          bounty_winnings: 0,
          bounties: 0,
          total_won: 20,
          buyin: 10,
        },
      ],
    } as never;
    const tourn = {
      entries: 2,
      cashes: 2,
      wins: 0,
      best_finish: 2,
      itm_percent: 1,
      total_buyins: 20,
      total_winnings: 120,
      total_prizes: 120,
      total_bounty_winnings: 0,
      total_bounties: 0,
      net_profit: 100,
      roi: 5,
    };
    const overall = { tourney_hands: 20 } as never;

    renderWithRoutes(<TournamentsTab full={full} tourn={tourn} overall={overall} />);
    fireEvent.click(screen.getByRole('link', { name: 'Open Friday Major Tournament Evidence' }));
    expect(screen.getByTestId('location')).toHaveTextContent('/tournaments/t-1?source=stats');
    expect(screen.getByText('Evidence Unavailable')).toBeInTheDocument();
  });

  it('loads trophy evidence on demand and exposes exact hand destinations', async () => {
    vi.mocked(StatsEvidenceService.list).mockResolvedValue({
      hands: [
        {
          hand_id: 'hand-9',
          club_id: 'club-7',
          table_id: 'table-1',
          tournament_id: null,
          played_at: '2026-10-03T10:00:00Z',
          game_variant: 'nlh',
          big_blind: 2,
          position: 'BTN',
          players_dealt: 6,
          hand_class: 'AA',
          invested: 10,
          returned: 30,
          net: 20,
          net_bb: 10,
          rake_paid: 1,
          vpip: true,
          pfr: true,
          three_bet: false,
          faced_three_bet: false,
          folded_to_three_bet: false,
          had_cbet_flop_opp: false,
          cbet_flop: false,
          saw_flop: true,
          went_to_showdown: true,
          won_at_showdown: true,
          aggressive_actions: 2,
          passive_actions: 0,
          was_all_in: false,
          ev_net_bb: 8,
          own_hole_cards: null,
          pot_size: 31,
          noted: false,
        } as never,
      ],
      has_more: false,
      next_cursor: null,
      scope: null,
      generated_at: '',
    });

    renderWithRoutes(
      <TrophyRoom
        userId="user-1"
        clubId="club-7"
        overall={{
          total_hands: 1,
          cash_hands: 1,
          hands_won: 1,
          vpip: 1,
          pfr: 1,
          three_bet_percent: 0,
          aggression_factor: 1,
          showdowns_total: 1,
          showdowns_won: 1,
          wtsd: 1,
          total_profit: 20,
          biggest_pot_won: 31,
          bb_per_100: 10,
          hours_played: 0,
        }}
        lifetimeHands={1}
      />
    );
    fireEvent.click(screen.getAllByRole('button', { name: 'Review Evidence' })[0]);
    await waitFor(() =>
      expect(StatsEvidenceService.list).toHaveBeenCalledWith('user-1', 'chips', 'club-7', {})
    );
    expect(await screen.findByRole('link', { name: /AA/i })).toHaveAttribute(
      'href',
      '/hand-history?hand=hand-9&source=stats&statsClub=club-7'
    );
    expect(screen.getAllByText('Individual Trophy Evidence Unavailable').length).toBeGreaterThan(0);
  });

  it('states that aggregate sessions have no fabricated hand identity', async () => {
    vi.useFakeTimers();
    renderWithRoutes(
      <SessionHistory
        initialSessions={[
          {
            id: 1,
            date: '2026-10-03',
            duration_minutes: 60,
            hands_played: 40,
            buy_in: 100,
            cash_out: 125,
            profit_loss: 25,
          },
        ]}
      />
    );
    await act(async () => vi.runAllTimers());
    fireEvent.click(screen.getByRole('button', { name: /Show Details/i }));
    expect(
      screen.getByText('Hand Evidence Unavailable For This Aggregated Session')
    ).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Open Hand/i })).not.toBeInTheDocument();
    vi.useRealTimers();
  });
});
