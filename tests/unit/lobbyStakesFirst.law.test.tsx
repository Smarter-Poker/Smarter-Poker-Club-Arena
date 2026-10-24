import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import LobbyTable from '../../src/components/lobby/LobbyTable';
import { cashEntry, type LobbyTableRow } from '../../src/components/lobby/lobbyEntries';
import { CASH_STYLES } from '../../src/components/lobby/advancedFilterSpec';

vi.mock('../../src/hooks/useSpinTierAvailability', () => ({
  useSpinTierAvailability: () => ({ can_draw_100x: false }),
}));

// Sorting exercises the real rows, not speculative network preparation.
// A route import surviving this test's teardown can log from the next worker.
vi.mock('../../src/utils/ChunkPreloader', () => ({
  prefetchIntent: () => ({ onMouseEnter() {}, onTouchStart() {}, onFocus() {} }),
  preloadRoute: vi.fn(),
}));
vi.mock('../../src/services/tableWarmup', () => ({
  warmTable: vi.fn(),
  observeLobbyTableWarmups: () => () => {},
}));

const ctx = {
  waitlistedIds: new Set<string>(),
  seatedIds: new Set<string>(),
  registeredIds: new Set<string>(),
  favoriteIds: new Set<string>(),
};
const variants = ['plo', 'plo5', 'plo6', 'plo8'];
function entry(variant: string, bb: number, suffix = '', players = 3) {
  return cashEntry({
    id: `${variant}-${bb}${suffix}`,
    name: `${variant.toUpperCase()} ${bb / 2}/${bb}`,
    game_variant: variant,
    small_blind: bb / 2,
    big_blind: bb,
    min_buy_in: 20 * bb,
    max_buy_in: 100 * bb,
    current_players: players,
    max_players: 6,
    status: 'open',
  } as LobbyTableRow);
}
function mount(entries = variants.flatMap((v) => [entry(v, 2), entry(v, 1)]).reverse()) {
  localStorage.clear();
  const props = {
    entries,
    category: 'OMAHA',
    selectedId: null,
    onSelect: vi.fn(),
    onActivate: vi.fn(),
    ctx,
    styleChoices: CASH_STYLES,
    selectedStyles: [],
    onStylesChange: vi.fn(),
  };
  const view = render(
    <MemoryRouter>
      <LobbyTable {...props} />
    </MemoryRouter>
  );
  const choose = (direction: 'High To Low' | 'Low To High', desktop = false) => {
    const scope = desktop
      ? document.querySelector('.lobby-table-wrap thead')!
      : document.querySelector('.arena-lobby-card-list thead')!;
    fireEvent.click(
      within(scope as HTMLElement).getByRole(desktop ? 'columnheader' : 'button', {
        name: /stakes/i,
      })
    );
    const menu = within(scope as HTMLElement).getByRole('group', { name: 'Stakes' });
    const option = within(menu).getByRole('button', { name: direction });
    fireEvent.pointerDown(option);
    fireEvent.click(option);
  };
  const ids = () =>
    Array.from(document.querySelectorAll('.lobby-table-wrap tbody tr[id]')).map((el) =>
      el.id.replace('lt-row-', '')
    );
  return { ...view, props, choose, ids };
}

describe('stakes lead the cash lobby across selected variants', () => {
  it.each([false, true])(
    'both stakes directions keep canonical variants at each price (desktop=%s)',
    (desktop) => {
      const { choose, ids, unmount, props } = mount();
      choose('High To Low', desktop);
      expect(ids()).toEqual([2, 1].flatMap((bb) => variants.map((v) => `${v}-${bb}`)));
      choose('Low To High', desktop);
      expect(ids()).toEqual([1, 2].flatMap((bb) => variants.map((v) => `${v}-${bb}`)));
      unmount();
      render(
        <MemoryRouter>
          <LobbyTable {...props} />
        </MemoryRouter>
      );
      expect(ids()).toEqual([1, 2].flatMap((bb) => variants.map((v) => `${v}-${bb}`)));
    }
  );

  it('an empty game stays in its stakes and variant group, after populated peers', () => {
    const { choose, ids } = mount([
      entry('plo', 2, '-empty', 0),
      entry('plo', 1),
      entry('plo', 2),
      entry('plo5', 2),
    ]);
    choose('High To Low');
    expect(ids()).toEqual(['plo-2', 'plo-2-empty', 'plo5-2', 'plo-1']);
    choose('Low To High');
    expect(ids()).toEqual(['plo-1', 'plo-2', 'plo-2-empty', 'plo5-2']);
  });
});
