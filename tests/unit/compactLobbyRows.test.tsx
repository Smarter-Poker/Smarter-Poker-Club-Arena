import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import LobbyTable from '../../src/components/lobby/LobbyTable';
import {
  cashEntry,
  tournamentEntry,
  tournamentStatus,
  type LobbyTournamentRow,
} from '../../src/components/lobby/lobbyEntries';

vi.mock('../../src/services/tableWarmup', () => ({
  warmTable: vi.fn(),
  observeLobbyTableWarmups: () => () => undefined,
}));
vi.mock('../../src/hooks/useSpinTierAvailability', () => ({ useSpinTierAvailability: () => null }));
afterEach(cleanup);

const game = cashEntry({
  id: 'compact-cash',
  name: 'Classic',
  game_variant: 'nlh',
  small_blind: 1,
  big_blind: 2,
  min_buy_in: 80,
  max_buy_in: 400,
  current_players: 3,
  max_players: 6,
  status: 'active',
});

function mount() {
  const onSelect = vi.fn();
  const writers = { onJoinTable: vi.fn(), onRegister: vi.fn(), onWaitlistToggle: vi.fn() };
  render(
    <MemoryRouter>
      <LobbyTable
        entries={[game]}
        category="HOLDEM"
        selectedId={null}
        onSelect={onSelect}
        onActivate={onSelect}
        ctx={{
          ...writers,
          seatedIds: new Set(),
          registeredIds: new Set(),
          favoriteIds: new Set(),
          waitlistedIds: new Set(),
        }}
      />
    </MemoryRouter>
  );
  return { onSelect, writers, list: screen.getByRole('table', { name: 'Games' }) };
}

describe('compact lobby selection is a pre-commit detail step', () => {
  it('renders a compact row, opens details once, and never joins or spends', () => {
    const { list, onSelect, writers } = mount();
    expect(
      within(list)
        .getAllByRole('columnheader')
        .map((h) => h.querySelector('button')?.childNodes[0]?.textContent)
    ).toEqual(['Game', 'Stakes', 'Players', 'Status']);
    fireEvent.click(within(list).getByRole('button', { name: /^Details:/ }));
    expect(onSelect).toHaveBeenCalledExactlyOnceWith(game);
    for (const writer of Object.values(writers)) expect(writer).not.toHaveBeenCalled();
    expect(screen.queryByTestId('arena-lobby-game-card')).toBeNull();
  });
  it('makes the whole row selectable without invoking a purchase action', () => {
    const { list, onSelect, writers } = mount();
    fireEvent.click(within(list).getByText(game.stakesLabel!));
    expect(onSelect).toHaveBeenCalledExactlyOnceWith(game);
    for (const writer of Object.values(writers)) expect(writer).not.toHaveBeenCalled();
  });
});

const eventRow = {
  id: 'favorite-event',
  name: 'Evening Event',
  game_type: 'NLH',
  tournament_type: 'MTT',
  format_contract: 'mtt-v1',
  variant: 'mtt',
  status: 'REGISTERING',
  start_time: '2026-10-29T20:00:00Z',
  started_at: null,
  buy_in_amount: 10,
  buy_in_fee: 1,
  current_players: 2,
  max_players: 9,
  starting_chips: 10000,
  late_reg_mins: 0,
} as LobbyTournamentRow;

describe('favorites are reachable in the mobile board', () => {
  it.each(['cash', 'mtt', 'spin', 'sng'] as const)(
    'toggles %s without opening or buying',
    (kind) => {
      const entry = kind === 'cash' ? game : tournamentEntry(eventRow, kind);
      const onSelect = vi.fn();
      const onToggleFavorite = vi.fn();
      const draw = (favorite: boolean) => (
        <MemoryRouter>
          <LobbyTable
            entries={[entry]}
            category={kind === 'cash' ? 'HOLDEM' : (kind.toUpperCase() as 'MTT' | 'SPIN' | 'SNG')}
            selectedId={null}
            onSelect={onSelect}
            onActivate={onSelect}
            ctx={{
              seatedIds: new Set(),
              registeredIds: new Set(),
              waitlistedIds: new Set(),
              favoriteIds: new Set(favorite ? [entry.id] : []),
              onToggleFavorite,
            }}
          />
        </MemoryRouter>
      );
      const { rerender } = render(draw(false));
      let board = screen.getByRole('table', { name: 'Games' });
      fireEvent.click(within(board).getByRole('button', { name: 'Add To Favorites' }));
      expect(onToggleFavorite).toHaveBeenLastCalledWith(entry.id, true, kind);
      expect(onSelect).not.toHaveBeenCalled();
      rerender(draw(true));
      board = screen.getByRole('table', { name: 'Games' });
      const remove = within(board).getByRole('button', { name: 'Remove From Favorites' });
      expect(remove.getAttribute('aria-pressed')).toBe('true');
      fireEvent.click(remove);
      expect(onToggleFavorite).toHaveBeenLastCalledWith(entry.id, false, kind);
      expect(onSelect).not.toHaveBeenCalled();
    }
  );
  it('uses actual start evidence before an older registering status', () => {
    expect(tournamentStatus({ ...eventRow, started_at: '2026-10-29T20:01:00Z' })).toEqual({
      key: 'running',
      label: 'Running',
    });
    expect(tournamentStatus(eventRow).key).toBe('starting_soon');
    expect(
      tournamentStatus({ ...eventRow, status: 'CANCELLED', started_at: '2026-10-29T20:01:00Z' }).key
    ).toBe('closed');
  });
});
