import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const CLUB_ID = 'a41434bb-8d0c-400a-8f0d-e8b3d65afed4';

const snapshot = {
  range: { start: '2026-08-17', end: '2026-08-30', days: 14 },
  previous_range: { start: '2026-08-03', end: '2026-08-16', days: 14 },
  summary: {
    games: 12,
    total_winnings: 2450,
    mtt_winnings: 500,
    cash_winnings: 1950,
    fee: 321.5,
    cash_fee: 250,
    mtt_fee: 71.5,
    hands: 900,
  },
  previous: {
    games: 10,
    total_winnings: 2000,
    mtt_winnings: 400,
    cash_winnings: 1600,
    fee: 300,
    hands: 800,
  },
  delta: { fee_pct: 7.2, games_pct: 20, winnings_abs: 450, fee_abs: 21.5 },
  rows: [
    {
      kind: 'CASH',
      id: 'game-1',
      name: 'Shark Table One',
      variant: 'NLH',
      game_class: 'HOLDEM',
      stakes_tier: 'SMALL',
      blinds: '1 / 2',
      rake_percent: 10,
      started_at: '2026-08-30T12:00:00Z',
      status: 'complete',
      creator_id: 'player-1',
      creator_name: 'Dealer One',
      creator_avatar: null,
      fee: 42.5,
      winnings: 120,
      hands: 80,
      players: 6,
    },
  ],
  row_count: 1,
  union_id: 'union-1',
  data_updated_at: '2026-08-30T12:05:00Z',
  generated_at: '2026-08-30T12:05:02Z',
};

const playerBreakdown = {
  range: snapshot.range,
  rake_complete_through: '2026-08-29',
  totals: { players: 1, net: 120, rake: 42.5, hands: 80 },
  players: [
    {
      user_id: 'player-1',
      username: 'Table Regular',
      avatar_url: null,
      is_horse: true,
      net: 120,
      cash_net: 120,
      tournament_net: 0,
      rake: 42.5,
      hands: 80,
    },
  ],
  player_count: 1,
  generated_at: '2026-08-30T12:05:02Z',
};

vi.mock('../../src/hooks/useAuthUser', () => ({
  useAuthUser: () => ({ user: { id: 'owner-1' }, isHydrating: false }),
}));

vi.mock('react-router-dom', () => ({
  useNavigate: () => vi.fn(),
  useParams: () => ({ clubId: CLUB_ID }),
  useSearchParams: () => [new URLSearchParams()],
}));

vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    rpc: vi.fn(async (fn: string) => {
      if (fn === 'ca_club_data_snapshot') return { data: snapshot, error: null };
      if (fn === 'ca_club_player_breakdown') return { data: playerBreakdown, error: null };
      if (fn === 'ca_club_union_invoices') return { data: [], error: null };
      return { data: null, error: null };
    }),
    from: vi.fn(() => ({
      select: () => ({
        eq: () => ({ maybeSingle: async () => ({ data: { name: 'Shark Club' }, error: null }) }),
      }),
    })),
  },
}));

import ClubDataPage from '../../src/pages/club/ClubDataPage';

afterEach(() => cleanup());

describe('ClubDataPage', () => {
  it('renders the operator hero and live financial summary', async () => {
    render(<ClubDataPage />);

    expect(screen.getByRole('heading', { name: /Read The Room/i })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('2,450.00')).toBeInTheDocument());
    expect(screen.getByText('Shark Table One')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Export as CSV' })).toBeEnabled();
  });

  it('keeps internal player automation metadata out of the operator UI', async () => {
    render(<ClubDataPage />);

    fireEvent.click(screen.getByRole('tab', { name: 'Players' }));
    await waitFor(() => expect(screen.getByText('Table Regular')).toBeInTheDocument());
    expect(screen.queryByText('HORSE')).not.toBeInTheDocument();
  });
});
