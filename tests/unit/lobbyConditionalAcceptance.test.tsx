/** Conditional live catalogue coverage must not depend on funding a table.
 * Real card rendering and handlers; synthetic inputs and no network/wallet. */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ArenaLobbyGameCard } from '../../src/components/lobby/game-cards/ArenaLobbyGameCard';
import {
  cashEntry,
  tournamentEntry,
  type LobbyTournamentRow,
} from '../../src/components/lobby/lobbyEntries';
import type { LobbyRowContext } from '../../src/components/lobby/lobbyCardContext';
import { parseDiamondDoorContext } from '../e2e/helpers/diamond-door-context';

vi.mock('../../src/services/tableWarmup', () => ({ warmTable: vi.fn() }));
afterEach(cleanup);
const context = (): LobbyRowContext => ({
  waitlistedIds: new Set(),
  seatedIds: new Set(),
  registeredIds: new Set(),
  favoriteIds: new Set(),
  onJoinTable: vi.fn(),
  onRegister: vi.fn(),
  onViewTable: vi.fn(),
  onWaitlistToggle: vi.fn(),
});
const cash = cashEntry({
  id: 'cash-1',
  name: 'Synthetic Cash',
  game_variant: 'nlh',
  small_blind: 1,
  big_blind: 2,
  min_buy_in: 80,
  max_buy_in: 400,
  current_players: 0,
  max_players: 6,
  status: 'active',
});
const mtt = tournamentEntry({
  id: 'mtt-1',
  name: 'Synthetic MTT',
  game_type: 'NLH',
  buy_in_amount: 10,
  buy_in_fee: 1,
  guaranteed_prize: 0,
  start_time: new Date().toISOString(),
  status: 'REGISTERING',
  current_players: 2,
  max_players: 9,
  starting_chips: 1000,
  variant: 'mtt',
  format_contract: 'mtt-v1',
} as LobbyTournamentRow);
const rawContext = {
  arena: { id: 'arena-1', asset: 'diamonds', is_platform: true, union_id: null },
  member: true,
  role: 'player',
  cashGamesEnabled: true,
  tournamentsEnabled: true,
};

describe('actual Diamond door authority', () => {
  it.each([
    [true, true],
    [false, false],
    [true, false],
    [false, true],
  ])(
    'reads independent cash %s and tournament %s switches without assuming closed play',
    (cashGamesEnabled, tournamentsEnabled) => {
      expect(
        parseDiamondDoorContext({ ...rawContext, cashGamesEnabled, tournamentsEnabled })
      ).toEqual({ cashGamesEnabled, tournamentsEnabled });
    }
  );
  it.each([
    null,
    {},
    { ...rawContext, cashGamesEnabled: undefined },
    { ...rawContext, tournamentsEnabled: 'false' },
    { ...rawContext, member: false },
    { ...rawContext, role: 'owner' },
    { ...rawContext, arena: { ...rawContext.arena, union_id: 'union' } },
  ])('refuses unknown or unauthorized context instead of reporting closed or open', (value) => {
    expect(() => parseDiamondDoorContext(value)).toThrow();
  });
});

describe('rendered Diamond closed/open controls', () => {
  it.each([
    [false, false],
    [true, false],
    [false, true],
    [true, true],
  ])('renders cash %s and registration %s as independent doors', (cashOpen, tournamentOpen) => {
    const ctx = {
      ...context(),
      seatsClosedLabel: cashOpen ? undefined : 'Not Open Yet',
      registrationClosedLabel: tournamentOpen ? undefined : 'Not Open Yet',
    };
    render(
      <>
        <ArenaLobbyGameCard entry={cash} ctx={ctx} />
        <ArenaLobbyGameCard entry={mtt} ctx={ctx} />
      </>
    );
    const cards = screen.getAllByTestId('arena-lobby-game-card');
    for (const [index, open, allowed] of [
      [0, cashOpen, 'Join Table'],
      [1, tournamentOpen, 'Register'],
    ] as const) {
      const control = within(cards[index]).getByRole('button', {
        name: open ? allowed : 'Not Open Yet',
        exact: true,
      });
      expect((control as HTMLButtonElement).disabled).toBe(!open);
      fireEvent.click(control);
      const handler = index === 0 ? ctx.onJoinTable : ctx.onRegister;
      expect(handler).toHaveBeenCalledTimes(open ? 1 : 0);
    }
    fireEvent.click(within(cards[0]).getByRole('button', { name: 'View Table', exact: true }));
    fireEvent.click(within(cards[1]).getByRole('button', { name: 'Details', exact: true }));
    expect(ctx.onViewTable).toHaveBeenCalledTimes(2);
  });
});

describe('rendered full cash queue', () => {
  it('offers a real waitlist toggle without invoking Join or View, then permits leaving', () => {
    const full = { ...cash, status: 'full' as const, seated: 6, players: 6 };
    const ctx = context();
    const view = render(<ArenaLobbyGameCard entry={full} ctx={ctx} />);
    fireEvent.click(screen.getByRole('button', { name: 'Join Waitlist', exact: true }));
    expect(ctx.onWaitlistToggle).toHaveBeenCalledWith(full.id, true);
    expect(ctx.onJoinTable).not.toHaveBeenCalled();
    expect(ctx.onViewTable).not.toHaveBeenCalled();
    view.rerender(
      <ArenaLobbyGameCard entry={full} ctx={{ ...ctx, waitlistedIds: new Set([full.id]) }} />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Leave Waitlist', exact: true }));
    expect(ctx.onWaitlistToggle).toHaveBeenLastCalledWith(full.id, false);
    expect(ctx.onJoinTable).not.toHaveBeenCalled();
    expect(ctx.onViewTable).not.toHaveBeenCalled();
  });
});
