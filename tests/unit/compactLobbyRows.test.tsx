import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import LobbyTable from '../../src/components/lobby/LobbyTable';
import { cashEntry } from '../../src/components/lobby/lobbyEntries';

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
