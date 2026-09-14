import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import LobbyTable from '../../src/components/lobby/LobbyTable';
import { cashEntry, type LobbyEntry } from '../../src/components/lobby/lobbyEntries';
import { warmTable } from '../../src/services/tableWarmup';

vi.mock('../../src/services/tableWarmup', () => ({
  warmTable: vi.fn(),
  observeLobbyTableWarmups: () => () => {},
}));
vi.mock('../../src/hooks/useSpinTierAvailability', () => ({
  useSpinTierAvailability: () => false,
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function mount(variant = 'nlh', cluster = false) {
  const entry = cashEntry({
    id: 'e78717a2-294d-4b8f-a6ce-d42ec54b237f',
    name: variant + ' 1/2',
    game_variant: variant,
    small_blind: 1,
    big_blind: 2,
    min_buy_in: 80,
    max_buy_in: 400,
    current_players: 4,
    max_players: 6,
    status: 'active',
  });
  if (cluster)
    entry.game = {
      id: '11111111-1111-4111-8111-111111111111',
      mustMove: true,
      template: null,
      tables: 2,
      state: null,
    } as NonNullable<LobbyEntry['game']>;
  const select = vi.fn(),
    view = vi.fn(),
    join = vi.fn();
  const ctx = {
    seatedIds: new Set<string>(),
    waitlistedIds: new Set<string>(),
    registeredIds: new Set<string>(),
    favoriteIds: new Set<string>(),
    onViewTable: view,
    onJoinTable: join,
  };
  const result = render(
    <MemoryRouter>
      <LobbyTable
        entries={[entry]}
        category="ALL"
        selectedId={null}
        onSelect={select}
        onActivate={select}
        ctx={ctx}
      />
    </MemoryRouter>
  );
  const card = result.getByTestId('arena-lobby-game-card');
  return { ...result, entry, card, select, view, join };
}

describe('mobile game-card focus preserves the selected action', () => {
  it('keeps the desktop row details action available', () => {
    const { container, entry, select, view, join } = mount();
    const row = container.querySelector(`tr[data-id="${entry.id}"]`)!;
    fireEvent.click(row);
    expect(select).toHaveBeenCalledExactlyOnceWith(entry);
    expect(view).not.toHaveBeenCalled();
    expect(join).not.toHaveBeenCalled();
  });

  it.each(['nlh', 'plo4', 'plo5', 'plo6', 'plo8', 'flh', 'flo8', 'pineapple', 'short_deck'])(
    '%s focuses and clicks View without opening the details panel first',
    (variant) => {
      const { card, entry, select, view, join } = mount(variant);
      const button = within(card).getByRole('button', { name: 'View Table' });
      fireEvent.pointerDown(button);
      act(() => button.focus());
      expect(button).toHaveFocus();
      expect(select).not.toHaveBeenCalled();
      expect(view).not.toHaveBeenCalled();
      expect(join).not.toHaveBeenCalled();
      expect(warmTable).toHaveBeenCalledWith(entry.id);
      fireEvent.pointerUp(button);
      fireEvent.click(button);
      expect(view).toHaveBeenCalledExactlyOnceWith(entry);
      expect(select).not.toHaveBeenCalled();
      expect(join).not.toHaveBeenCalled();
    }
  );

  it('cluster View Game preserves the same table and keeps joining a separate action', () => {
    const { card, entry, select, view, join } = mount('nlh', true);
    const button = within(card).getByRole('button', { name: 'View Game' });
    act(() => button.focus());
    expect(select).not.toHaveBeenCalled();
    fireEvent.click(button);
    expect(view).toHaveBeenCalledExactlyOnceWith(entry);
    expect(join).not.toHaveBeenCalled();
    const joinButton = within(card).getByRole('button', { name: 'Join Game' });
    act(() => joinButton.focus());
    expect(join).not.toHaveBeenCalled();
    expect(select).not.toHaveBeenCalled();
    fireEvent.click(joinButton);
    expect(join).toHaveBeenCalledExactlyOnceWith(entry);
  });
});
