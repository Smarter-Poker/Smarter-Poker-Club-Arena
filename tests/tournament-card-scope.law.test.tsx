import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { formatGameTitle } from '../src/utils/formatGameTitle';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setVisiblePokerTable } from '../src/lib/visiblePokerTable';
import { MemoryRouter } from 'react-router-dom';
import { MttPremiumCard } from '../src/components/lobby/game-cards/MttPremiumCard';
import { arenaGameCardDataFromEntry } from '../src/components/lobby/game-cards/arenaGameCardAdapter';
import { tournamentEntry } from '../src/components/lobby/lobbyEntries';
import type { LobbyTournamentRow } from '../src/components/lobby/lobbyEntries';

const mocks = vi.hoisted(() => ({ select: vi.fn(), report: vi.fn(), seats: [] as unknown[] }));
vi.mock('../src/lib/supabase', () => ({
  supabase: {
    from: (table: string) => ({
      select: (...args: unknown[]) => {
        if (table === 'tournaments') {
          mocks.select(...args);
          return {
            eq: (_: string, id: string) => ({
              maybeSingle: async () => ({
                data: ['missing', 'denied'].includes(id) ? null : { name: `Target ${id}` },
                error: id === 'denied' ? new Error('Permission Denied') : null,
              }),
            }),
          };
        }
        const query = {
          eq: () => query,
          is: () => query,
          limit: async () => ({ data: mocks.seats, error: null }),
        };
        return query;
      },
    }),
  },
}));
vi.mock('../src/hooks/useAuthUser', () => ({ useAuthUser: () => ({ user: { id: 'viewer' } }) }));
vi.mock('../src/hooks/useMasterBusSubscription', () => ({ useMasterBusSubscription: vi.fn() }));
vi.mock('../src/services/tableWarmup', () => ({ warmTable: vi.fn() }));
vi.mock('../src/utils/errorReporter', () => ({ reportError: mocks.report }));
import TournamentAutoSeat from '../src/components/tournament/TournamentAutoSeat';

const now = Date.parse('2026-10-18T18:00:00Z');
function card(overrides: Partial<LobbyTournamentRow> = {}) {
  const row: LobbyTournamentRow = {
    id: 'event',
    name: 'Nightly 10K',
    game_type: 'NLH',
    format_contract: 'mtt-v2',
    buy_in_amount: 35,
    buy_in_fee: 0,
    guaranteed_prize: 10000,
    start_time: new Date(now + 10000).toISOString(),
    status: 'REGISTERING',
    current_players: 11,
    max_players: null,
    starting_chips: 20000,
    ...overrides,
  };
  return arenaGameCardDataFromEntry(tournamentEntry(row, 'mtt'));
}
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
  sessionStorage.clear();
  setVisiblePokerTable(null);
});

describe('tournament card information', () => {
  it('puts the authoritative guarantee and variant in the title; omits zero guarantees', () => {
    expect(card().title).toBe('Nightly 10K (NLH) · 10K Guaranteed');
    expect(card({ guaranteed_prize: 0 }).title).toBe('Nightly 10K (NLH)');
    expect(card({ name: 'Nightly 10K Guaranteed' }).title).toBe('Nightly 10K Guaranteed (NLH)');
  });
  it('ticks the actual start countdown through zero without the Starting Soon phrase or rule clutter', () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const data = card();
    data.rules = [{ key: 'rebuy', label: 'REBUY', tip: 'Rebuy' }];
    data.featured = true;
    render(<MttPremiumCard data={data} actions={{ primaryLabel: 'Register' }} />);
    expect(screen.getByText('Starts In 0:10')).toBeTruthy();
    expect(screen.queryByText(/Starting Soon|REBUY|Featured|More Rules/)).toBeNull();
    act(() => vi.advanceTimersByTime(11000));
    expect(screen.getByText('Starts In 0:00')).toBeTruthy();
  });
  it('ticks late registration using its real minute deadline and stops when finalized', () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const data = card({
      status: 'RUNNING',
      started_at: new Date(now - 50000).toISOString(),
      late_reg_mins: 1,
    });
    const view = render(<MttPremiumCard data={data} actions={{ primaryLabel: 'Register' }} />);
    expect(screen.getByText('Late Reg 0:10 Left')).toBeTruthy();
    act(() => vi.advanceTimersByTime(1000));
    expect(screen.getByText('Late Reg 0:09 Left')).toBeTruthy();
    view.rerender(
      <MttPremiumCard
        data={card({ status: 'RUNNING', prize_pool_finalized: true })}
        actions={{ primaryLabel: 'Watch' }}
      />
    );
    expect(screen.getByText('Late Reg Closed')).toBeTruthy();
  });
  it.each(['missing', 'denied'])(
    'shows an explicit unavailable destination for %s reads',
    async (target) => {
      render(
        <MttPremiumCard
          data={card({ satellite_target_id: target })}
          actions={{ primaryLabel: 'Register' }}
        />
      );
      expect(await screen.findByText('Satellite Destination Unavailable')).toBeTruthy();
      if (target === 'denied') expect(mocks.report).toHaveBeenCalled();
    }
  );
  it('resolves the destination event below a satellite title', async () => {
    render(
      <MttPremiumCard
        data={card({ satellite_target_id: 'main-event' })}
        actions={{ primaryLabel: 'Register' }}
      />
    );
    expect(await screen.findByText('Wins A Seat Into Target Main-Event')).toBeTruthy();
    expect(mocks.select).toHaveBeenCalledWith('name');
  });
});

describe('blinding-off popup belongs to its own table', () => {
  it.each(['/table/cash', '/table/other-tournament', '/clubs/diamond-arena'])(
    'does not interrupt %s or mark that warning as already seen',
    async (path) => {
      mocks.seats = [
        {
          table_id: 'away-table',
          joined_at: '2020-01-01',
          stack: 30000,
          is_sitting_out: true,
          tables: { tournament_id: 't', status: 'running', name: 'Sunday 200 - Table 4' },
        },
      ];
      render(
        <MemoryRouter initialEntries={[path]}>
          <TournamentAutoSeat />
        </MemoryRouter>
      );
      await act(async () => {});
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(sessionStorage.getItem('ca_tourney_blindoff_warned')).toBeNull();
    }
  );
  it('does not warn over a lobby borrowing the tournament table URL', async () => {
    mocks.seats = [
      {
        table_id: 'away-table',
        stack: 30000,
        is_away: true,
        tables: { tournament_id: 't', status: 'running', name: 'Sunday 200 - Table 4' },
      },
    ];
    render(
      <MemoryRouter initialEntries={['/table/away-table']}>
        <TournamentAutoSeat />
      </MemoryRouter>
    );
    await act(async () => {});
    expect(screen.queryByRole('dialog')).toBeNull();
  });
  it('shows the warning at the matching tournament table', async () => {
    setVisiblePokerTable('away-table');
    mocks.seats = [
      {
        table_id: 'away-table',
        joined_at: '2020-01-01',
        stack: 30000,
        is_sitting_out: true,
        tables: { tournament_id: 't', status: 'running', name: 'Sunday 200 - Table 4' },
      },
    ];
    render(
      <MemoryRouter initialEntries={['/table/away-table']}>
        <TournamentAutoSeat />
      </MemoryRouter>
    );
    await waitFor(() =>
      expect(screen.getByRole('dialog', { name: 'You Are Being Blinded Off' })).toBeTruthy()
    );
  });
});

it('prints game acronyms uppercase in the Game Running notification', () => {
  const source = readFileSync(resolve(__dirname, '../src/pages/MultiTablePage.tsx'), 'utf8');
  expect(source).toMatch(/multi-table-page__take-seat-name[^]*?formatGameTitle\(target.name\)/);
  expect(formatGameTitle('nlh 50/100')).toBe('NLH 50/100');
});
