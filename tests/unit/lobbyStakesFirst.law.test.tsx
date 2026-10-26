import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import LobbyTable from '../../src/components/lobby/LobbyTable';
import { cashEntry, type LobbyTableRow } from '../../src/components/lobby/lobbyEntries';
import { CASH_STYLES } from '../../src/components/lobby/advancedFilterSpec';

vi.mock('../../src/hooks/useSpinTierAvailability', () => ({
  useSpinTierAvailability: () => ({ can_draw_100x: false }),
}));

// Stakes ordering does not exercise speculative transport or route loading.
// Keep those asynchronous imports inside the warm-up suite that owns them.
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

/* 2026-10-24: the same rule everywhere a price is sorted. */
const omahaGames = [
  { key: 'plo4', label: 'PLO' },
  { key: 'plo5', label: 'PLO5' },
  { key: 'plo6', label: 'PLO6' },
  { key: 'plo8', label: 'PLO8o' },
];
function rendered(props: Record<string, unknown>) {
  localStorage.clear();
  render(
    <MemoryRouter>
      <LobbyTable
        selectedId={null}
        onSelect={vi.fn()}
        onActivate={vi.fn()}
        ctx={ctx}
        {...(props as { entries: never; category: never })}
      />
    </MemoryRouter>
  );
  return () =>
    Array.from(document.querySelectorAll('.lobby-table-wrap tbody tr[id]')).map((el) =>
      el.id.replace('lt-row-', '')
    );
}

describe('every stakes order keeps one price together in canonical variant order', () => {
  it('the ALL tab Stakes heading groups each price by canonical variant, both directions', () => {
    // Arrival order is deliberately scrambled and player counts differ, so
    // only the canonical rank can produce the expected order.
    const entries = [
      entry('plo8', 2, '', 5),
      entry('nlh', 1, '', 2),
      entry('short_deck', 2, '', 4),
      entry('plo', 1, '', 6),
      entry('nlh', 2, '', 1),
      entry('pineapple', 2, '', 6),
      entry('plo5', 2, '', 3),
    ];
    const ids = rendered({ entries, category: 'ALL' });
    const head = document.querySelector('.lobby-table-wrap thead') as HTMLElement;
    const stakes = within(head).getByRole('columnheader', { name: /stakes/i });
    fireEvent.click(within(stakes).queryByRole('button') ?? stakes);
    expect(ids()).toEqual([
      'nlh-1',
      'plo-1',
      'nlh-2',
      'pineapple-2',
      'short_deck-2',
      'plo5-2',
      'plo8-2',
    ]);
    fireEvent.click(within(stakes).queryByRole('button') ?? stakes);
    expect(ids()).toEqual([
      'nlh-2',
      'pineapple-2',
      'short_deck-2',
      'plo5-2',
      'plo8-2',
      'nlh-1',
      'plo-1',
    ]);
  });

  it('Sort By Variant lists each variant by stakes, and the second tap reverses the stakes only', () => {
    const entries = [
      entry('plo5', 1, '', 6),
      entry('plo', 4, '', 6),
      entry('plo', 1, '', 1),
      entry('plo5', 4, '', 1),
      entry('plo', 2, '', 3),
    ];
    const ids = rendered({
      entries,
      category: 'OMAHA',
      variantChoices: omahaGames,
      selectedVariants: [],
      onVariantsChange: vi.fn(),
    });
    const bar = document.querySelector('.arena-lobby-card-list') as HTMLElement;
    const sortByVariant = () => {
      fireEvent.click(within(bar).getByRole('button', { name: /^game$/i }));
      const menu = within(bar).getByRole('group', { name: 'Game Variant' });
      fireEvent.click(within(menu).getByRole('button', { name: 'Sort By Variant' }));
    };
    sortByVariant();
    expect(ids()).toEqual(['plo-1', 'plo-2', 'plo-4', 'plo5-1', 'plo5-4']);
    sortByVariant();
    expect(ids()).toEqual(['plo-4', 'plo-2', 'plo-1', 'plo5-4', 'plo5-1']);
  });
});

describe('the ALL board keeps one printed stakes level together across betting structures', () => {
  it('a limit "1/2" (blinds 0.50/1) sits with the no-limit 1/2 games, both directions', () => {
    const ids = rendered({
      entries: [entry('flh', 1), entry('nlh', 1), entry('nlh', 2), entry('plo', 2)],
      category: 'ALL',
    });
    const head = document.querySelector('.lobby-table-wrap thead') as HTMLElement;
    const stakes = within(head).getByRole('columnheader', { name: /stakes/i });
    const press = () => fireEvent.click(within(stakes).queryByRole('button') ?? stakes);
    press();
    expect(ids()).toEqual(['nlh-1', 'nlh-2', 'plo-2', 'flh-1']);
    press();
    expect(ids()).toEqual(['nlh-2', 'plo-2', 'flh-1', 'nlh-1']);
  });
});
