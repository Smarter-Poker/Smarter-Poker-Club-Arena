import { cleanup, fireEvent, render, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import LobbyTable from '../../src/components/lobby/LobbyTable';
import { cashEntry, type LobbyTableRow } from '../../src/components/lobby/lobbyEntries';
vi.mock('../../src/services/tableWarmup', () => ({
  warmTable: vi.fn(),
  observeLobbyTableWarmups: () => () => {},
}));
vi.mock('../../src/hooks/useSpinTierAvailability', () => ({ useSpinTierAvailability: () => null }));
afterEach(() => {
  cleanup();
  localStorage.clear();
});
const ctx = {
  waitlistedIds: new Set<string>(),
  seatedIds: new Set<string>(),
  registeredIds: new Set<string>(),
  favoriteIds: new Set<string>(),
};
const entries = [2, 1].map((bb) =>
  cashEntry({
    id: `game-${bb}`,
    name: `NLH ${bb}`,
    game_variant: 'nlh',
    small_blind: bb / 2,
    big_blind: bb,
    min_buy_in: 20 * bb,
    max_buy_in: 100 * bb,
    current_players: 3,
    max_players: 6,
    status: 'open',
  } as LobbyTableRow)
);
function board() {
  render(
    <MemoryRouter>
      <LobbyTable
        entries={entries}
        category="HOLDEM"
        selectedId={null}
        onSelect={() => {}}
        onActivate={() => {}}
        ctx={ctx}
      />
    </MemoryRouter>
  );
}
const ids = () =>
  Array.from(document.querySelectorAll('.compact-lobby tbody tr[data-id]')).map((el) =>
    el.getAttribute('data-id')
  );
describe('Game is fixed information, never a popup or sort control (owner2026-10-31)', () => {
  it('prints a static Game heading and ignores pointer and keyboard sorting', () => {
    board();
    const header = document.querySelector('.compact-lobby thead') as HTMLElement;
    const game = within(header).getByRole('columnheader', { name: /^game$/i });
    expect(within(game).queryByRole('button')).toBeNull();
    expect(game).not.toHaveAttribute('aria-sort');
    const before = ids();
    fireEvent.click(game);
    fireEvent.keyDown(game, { key: 'Enter' });
    expect(ids()).toEqual(before);
    expect(document.querySelector('.lt-variant-menu')).toBeNull();
    const desktop = document.querySelector('.lobby-table-wrap thead') as HTMLElement;
    const variant = within(desktop).getByText('Variant').closest('th')!;
    expect(variant).not.toHaveAttribute('tabindex');
    expect(variant).not.toHaveAttribute('aria-haspopup');
  });
  it.each(['name', 'variant'])(
    'drops a retired saved %s sort while keeping direct stakes sorting',
    (key) => {
      localStorage.setItem(
        'ca_player_preference:guest:lobby:headingSort:HOLDEM:any',
        JSON.stringify({ key, dir: 'desc', chosen: true })
      );
      board();
      expect(ids()).toEqual(['game-1', 'game-2']);
      const compact = document.querySelector('.compact-lobby thead') as HTMLElement;
      fireEvent.click(within(compact).getByRole('button', { name: /stakes/i }));
      expect(ids()).toEqual(['game-2', 'game-1']);
      expect(document.querySelector('[aria-haspopup="menu"]')).toBeNull();
    }
  );
});
