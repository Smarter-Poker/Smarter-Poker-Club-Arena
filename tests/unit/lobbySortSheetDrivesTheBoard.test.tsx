import { fireEvent, render, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import LobbyTable from '../../src/components/lobby/LobbyTable';
import { cashEntry, type LobbyTableRow } from '../../src/components/lobby/lobbyEntries';
import { headingForOrder, orderForHeading } from '../../src/components/lobby/lobbySortBridge';

/* 2026-10-24: the filter sheet's "Sort The Board" chips did nothing on the
   cash tabs, Spins and Heads Up - the board always had a heading sort (the
   Stakes / Buy-In Low To High defaults) and that outranked the sheet. On MTT
   and ALL any heading tapped once outranked it for ever after. The sheet now
   drives the board, and a heading lights the matching chip. */
vi.mock('../../src/hooks/useSpinTierAvailability', () => ({
  useSpinTierAvailability: () => ({ can_draw_100x: false }),
}));
vi.mock('../../src/services/tableWarmup', () => ({
  observeLobbyTableWarmups: vi.fn(() => () => {}),
  warmTable: vi.fn(),
}));

const ctx = {
  waitlistedIds: new Set<string>(),
  seatedIds: new Set<string>(),
  registeredIds: new Set<string>(),
  favoriteIds: new Set<string>(),
};
const game = (id: string, bb: number, players: number) =>
  cashEntry({
    id,
    name: `PLO ${bb / 2}/${bb}`,
    game_variant: 'plo4',
    small_blind: bb / 2,
    big_blind: bb,
    min_buy_in: 20 * bb,
    max_buy_in: 100 * bb,
    current_players: players,
    max_players: 6,
    status: 'open',
  } as LobbyTableRow);
const entries = [game('mid', 2, 6), game('low', 1, 2), game('high', 4, 4)];

function board(category: string, onHeadingSort = vi.fn()) {
  const props = {
    entries,
    category: category as never,
    clubId: 'club-x',
    selectedId: null,
    onSelect: vi.fn(),
    onActivate: vi.fn(),
    ctx,
    onHeadingSort,
  };
  const view = render(
    <MemoryRouter>
      <LobbyTable {...props} requestedOrder={null} />
    </MemoryRouter>
  );
  const press = (key: string, seq: number) =>
    view.rerender(
      <MemoryRouter>
        <LobbyTable {...props} requestedOrder={{ key, seq }} />
      </MemoryRouter>
    );
  const ids = () =>
    Array.from(document.querySelectorAll('.lobby-table-wrap tbody tr[id]')).map((el) =>
      el.id.replace('lt-row-', '')
    );
  return { press, ids, onHeadingSort };
}

describe('the Sort The Board chips drive the board', () => {
  it('on a cash tab each chip takes effect, and Recommended returns the default', () => {
    localStorage.clear();
    const { press, ids } = board('OMAHA');
    expect(ids()).toEqual(['low', 'mid', 'high']); // default: Stakes Low To High
    press('stakes_high', 1);
    expect(ids()).toEqual(['high', 'mid', 'low']);
    press('players', 2);
    expect(ids()).toEqual(['mid', 'high', 'low']);
    press('stakes_low', 3);
    expect(ids()).toEqual(['low', 'mid', 'high']);
    press('players', 4);
    press('recommended', 5);
    expect(ids()).toEqual(['low', 'mid', 'high']);
    expect(
      JSON.parse(localStorage.getItem('ca_player_preference:guest:lobby:headingSort:OMAHA:club-x')!)
    ).toEqual({ key: '', dir: 'asc', chosen: false });
  });

  it('the same chip pressed again after a heading tap still applies', () => {
    localStorage.clear();
    const { press, ids } = board('OMAHA');
    press('stakes_high', 1);
    const head = document.querySelector('.lobby-table-wrap thead') as HTMLElement;
    const players = within(head).getByRole('columnheader', { name: /players/i });
    fireEvent.click(within(players).queryByRole('button') ?? players);
    expect(ids()).toEqual(['low', 'high', 'mid']); // Players asc from the heading
    press('stakes_high', 2);
    expect(ids()).toEqual(['high', 'mid', 'low']);
  });

  it('a chip on ALL clears a heading tapped earlier so the page order shows', () => {
    localStorage.clear();
    localStorage.setItem(
      'ca_player_preference:guest:lobby:headingSort:ALL:club-x',
      JSON.stringify({ key: 'cost', dir: 'asc', chosen: true })
    );
    const { press, ids } = board('ALL');
    expect(ids()).toEqual(['low', 'mid', 'high']);
    press('stakes_high', 1);
    expect(ids()).toEqual(['mid', 'low', 'high']); // the page's own order, as handed in
    expect(
      JSON.parse(localStorage.getItem('ca_player_preference:guest:lobby:headingSort:ALL:club-x')!)
    ).toEqual({ key: '', dir: 'asc', chosen: false });
  });

  it('a heading the player taps is reported so the sheet can light its chip', () => {
    localStorage.clear();
    const { onHeadingSort } = board('OMAHA');
    const head = document.querySelector('.lobby-table-wrap thead') as HTMLElement;
    const players = within(head).getByRole('columnheader', { name: /players/i });
    fireEvent.click(within(players).queryByRole('button') ?? players);
    expect(onHeadingSort).toHaveBeenLastCalledWith('players', 'asc');
  });
});

describe('lobbySortBridge', () => {
  it('maps every chip to the heading each tab sorts by', () => {
    expect(headingForOrder('HOLDEM', 'stakes_high')).toEqual({ key: 'stakes', dir: 'desc' });
    expect(headingForOrder('LIMIT', 'stakes_low')).toEqual({ key: 'stakes', dir: 'asc' });
    expect(headingForOrder('SPIN', 'stakes_high')).toEqual({ key: 'buyin', dir: 'desc' });
    expect(headingForOrder('MTT', 'stakes_low')).toEqual({ key: 'buyin', dir: 'asc' });
    expect(headingForOrder('SNG', 'players')).toEqual({ key: 'players', dir: 'desc' });
    expect(headingForOrder('MTT', 'starting_soon')).toBe('reset');
    expect(headingForOrder('OMAHA', 'recommended')).toBe('reset');
    expect(headingForOrder('ALL', 'stakes_high')).toBe('reset');
  });

  it('maps a heading back to the chip that says the same thing, or none', () => {
    expect(orderForHeading('OMAHA', 'stakes', 'desc')).toBe('stakes_high');
    expect(orderForHeading('ALL', 'cost', 'asc')).toBe('stakes_low');
    expect(orderForHeading('SPIN', 'buyin', 'desc')).toBe('stakes_high');
    expect(orderForHeading('HOLDEM', 'players', 'desc')).toBe('players');
    expect(orderForHeading('MTT', 'starts', 'asc')).toBe('starting_soon');
    expect(orderForHeading('HOLDEM', 'players', 'asc')).toBeNull();
    expect(orderForHeading('OMAHA', 'status', 'desc')).toBeNull();
  });
});
