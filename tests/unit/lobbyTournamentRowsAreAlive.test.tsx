import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import LobbyTable, {
  HOT_GUARANTEE_THRESHOLD,
  tournamentClockLine,
  tournamentSignals,
} from '../../src/components/lobby/LobbyTable';
import {
  tournamentEntry,
  type LobbyEntry,
  type LobbyTournamentRow,
} from '../../src/components/lobby/lobbyEntries';

/**
 * Dan 2026-10-23, on the lobby:
 *
 *   "PLAYERS AND STATUS DON'T CHANGE WHEN THEY ARE CLICKED."
 *   "THE TOURNAMENTS NEED TO LOOK COOLER, MAYBE HAVE SOME SPECIAL ICONS NEXT
 *    TO EACH GAME FOR LIKE BOUNTY, HIGHLIGHT ALL GUARANTEES OVER 2.5K, ADD
 *    TIMERS FOR STARTING IN... OR LATE REG ENDS IN... (FREE ROLLS SHOULD ALSO
 *    BE HIGHLIGHTED)."
 */

vi.mock('../../src/services/tableWarmup', () => ({
  warmTable: vi.fn(),
  observeLobbyTableWarmups: () => () => undefined,
}));
vi.mock('../../src/hooks/useSpinTierAvailability', () => ({ useSpinTierAvailability: () => null }));
afterEach(() => {
  cleanup();
  try {
    localStorage.clear();
  } catch {
    /* storage unavailable: nothing was remembered */
  }
});

const tourn = (over: Partial<LobbyTournamentRow> = {}): LobbyTournamentRow =>
  ({
    id: 'g1',
    name: 'Nightly',
    format_contract: 'mtt-v1',
    game_type: 'NLH',
    buy_in_amount: 10,
    buy_in_fee: 1,
    guaranteed_prize: 0,
    start_time: new Date(Date.now() + 45 * 60000).toISOString(),
    status: 'REGISTERING',
    current_players: 3,
    max_players: 100,
    starting_chips: 5000,
    ...over,
  }) as unknown as LobbyTournamentRow;

const mtt = (over: Partial<LobbyTournamentRow> = {}, patch: Partial<LobbyEntry> = {}) => ({
  ...tournamentEntry(tourn(over), 'mtt'),
  ...patch,
});

describe('a tournament row says what makes it worth playing', () => {
  it('highlights a guarantee of 2.5K or more, and not one below it', () => {
    expect(HOT_GUARANTEE_THRESHOLD).toBe(2500);
    expect(tournamentSignals(mtt({ guaranteed_prize: 2500 }))).toContain('hot-gtd');
    expect(tournamentSignals(mtt({ guaranteed_prize: 2499 }))).not.toContain('hot-gtd');
  });

  it('highlights a freeroll', () => {
    expect(tournamentSignals(mtt({ buy_in_amount: 0, buy_in_fee: 0 }))).toContain('freeroll');
    expect(tournamentSignals(mtt())).not.toContain('freeroll');
  });

  it('names the bounty family by its most specific member', () => {
    const rules = (key: string) => [{ key, label: key, tip: key }];
    expect(tournamentSignals(mtt({}, { rules: rules('pko') }))).toContain('pko');
    expect(tournamentSignals(mtt({}, { rules: rules('mystery') }))).toContain('mystery');
    expect(tournamentSignals(mtt({}, { rules: rules('bounty') }))).toContain('bounty');
  });

  it('counts down to the start, and to the end of late registration', () => {
    const now = Date.now();
    const start = mtt({ start_time: new Date(now + 4 * 60000 + 31000).toISOString() });
    expect(tournamentClockLine(start, now)?.text).toBe('Starts In 4:31');
    const late = mtt({}, { status: 'late_reg' });
    // No readable late-reg window: no clock rather than a made-up one.
    expect(tournamentClockLine(late, now)).toBeNull();
  });

  it('prints the badges and the clock on the compact row', () => {
    const entry = mtt({ guaranteed_prize: 10000, name: 'Sunday Big' });
    render(
      <MemoryRouter>
        <LobbyTable
          entries={[entry]}
          category="MTT"
          selectedId={null}
          onSelect={vi.fn()}
          onActivate={vi.fn()}
          ctx={{
            onJoinTable: vi.fn(),
            onRegister: vi.fn(),
            onWaitlistToggle: vi.fn(),
            seatedIds: new Set(),
            registeredIds: new Set(),
            favoriteIds: new Set(),
            waitlistedIds: new Set(),
          }}
        />
      </MemoryRouter>
    );
    const list = screen.getByRole('table', { name: 'Games' });
    expect(within(list).getByText('10K GTD')).toBeTruthy();
    expect(within(list).getByText(/^Starts In /)).toBeTruthy();
  });
});

describe('a heading the player taps reorders the whole board', () => {
  it('Players reorders past a featured game instead of leaving it pinned on top', () => {
    const featured = mtt(
      { id: 'small', name: 'Featured Small', current_players: 5 },
      { featured: true }
    );
    const big = mtt({ id: 'big', name: 'Busy Big', current_players: 50 });
    render(
      <MemoryRouter>
        <LobbyTable
          entries={[featured, big]}
          clubId="sort-club"
          category="MTT"
          selectedId={null}
          onSelect={vi.fn()}
          onActivate={vi.fn()}
          ctx={{
            onJoinTable: vi.fn(),
            onRegister: vi.fn(),
            onWaitlistToggle: vi.fn(),
            seatedIds: new Set(),
            registeredIds: new Set(),
            favoriteIds: new Set(),
            waitlistedIds: new Set(),
          }}
        />
      </MemoryRouter>
    );
    const list = screen.getByRole('table', { name: 'Games' });
    const order = () =>
      within(list)
        .getAllByTestId('lobby-game-row')
        .map((r) => r.getAttribute('data-id'));
    // Default order: the featured game is pinned first.
    expect(order()).toEqual(['small', 'big']);
    const players = within(list)
      .getAllByRole('columnheader')
      .map((h) => h.querySelector('button')!)
      .find((b) => b.textContent?.startsWith('Players'))!;
    fireEvent.click(players); // ascending
    fireEvent.click(players); // descending
    expect(order()).toEqual(['big', 'small']);
  });
});
