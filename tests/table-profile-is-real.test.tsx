/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE TABLE PROFILE SHOWS REAL FIGURES, NOT SCENERY
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Tapping your own avatar mid-hand used to open a traced screenshot of a
 * competitor's profile sheet: four tabs that changed nothing, a Tag field that
 * discarded what you typed, badges hard-coded to "Newbie", and ten placeholder
 * squares under "Character Emojis" priced at a diamond emoji.
 *
 * These pin the replacement. They render the component rather than grepping
 * it, so they fail if the sheet stops READING the session service - which is
 * the specific way this could rot back into scenery.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

vi.mock('../src/lib/supabase', () => ({
  supabase: {
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: () => Promise.resolve({ data: { player_number: '884213' }, error: null }),
        }),
      }),
    }),
  },
}));

vi.mock('../src/hooks/useMasterBusSubscription', () => ({
  useMasterBusSubscription: vi.fn(),
}));

const stats = {
  tableId: 't1',
  userId: 'u1',
  sessionStartTime: Date.now() - 90 * 60_000, // 1h 30m ago
  initialStack: 1000,
  currentStack: 2450.5,
  buyInTotal: 1000,
  handsPlayed: 84,
  handsWon: 19,
  handsPerHour: 56,
  vpipHands: 21,
  vpipPercent: 25,
  pfrHands: 14,
  pfrPercent: 17,
  profitLoss: 1450.5,
  bigBlindsWon: 72,
  bigBlind: 20,
  trajectory: [] as [number, number][],
};

const getStats = vi.fn();
vi.mock('../src/services/SessionStatsService', () => ({
  sessionStatsService: {
    getStats: (id: string) => getStats(id),
  },
}));

import { ClubProfileModal } from '../src/components/table/ClubProfileModal';

const base = {
  isOpen: true,
  onClose: vi.fn(),
  userId: 'u1',
  username: 'DanTheMan',
  avatarUrl: '',
  clubName: 'Shark Club',
  tableId: 't1',
};

beforeEach(() => {
  getStats.mockReset();
  getStats.mockReturnValue(stats);
});

describe('the table profile is made of real numbers', () => {
  it('reads the session from the same service the Session Stats panel uses', () => {
    render(<ClubProfileModal {...base} />);
    expect(getStats).toHaveBeenCalledWith('t1');
  });

  it('shows the live stack, net and session figures', () => {
    render(<ClubProfileModal {...base} />);
    expect(screen.getByText('2,450.50')).toBeTruthy(); // stack
    expect(screen.getByText('+1,450.50')).toBeTruthy(); // net, marked as a win
    expect(screen.getByText('84')).toBeTruthy(); // hands
    expect(screen.getByText('19')).toBeTruthy(); // won
    expect(screen.getByText('25%')).toBeTruthy(); // vpip
    expect(screen.getByText('17%')).toBeTruthy(); // pfr
  });

  it('shows the real player number rather than an invented id', async () => {
    render(<ClubProfileModal {...base} />);
    await waitFor(() => expect(screen.getByText('ID: 884213')).toBeTruthy());
  });

  it('admits what it cannot read instead of printing a confident zero', () => {
    getStats.mockReturnValue(null);
    render(<ClubProfileModal {...base} />);
    // Every session figure falls back to the same honest marker.
    expect(screen.getAllByText('--').length).toBeGreaterThan(4);
  });

  it('carries none of the scenery it replaced', () => {
    const { container } = render(<ClubProfileModal {...base} />);
    const text = container.textContent || '';
    for (const gone of ['Newbie', 'Character Emojis', 'Recently Used', 'Free Emojis Left']) {
      expect(text).not.toContain(gone);
    }
    // The Tag field discarded everything typed into it; it is gone entirely.
    expect(container.querySelector('input')).toBeNull();
  });

  it('renders nothing at all when closed', () => {
    const { container } = render(<ClubProfileModal {...base} isOpen={false} />);
    expect(container.firstChild).toBeNull();
  });
});
