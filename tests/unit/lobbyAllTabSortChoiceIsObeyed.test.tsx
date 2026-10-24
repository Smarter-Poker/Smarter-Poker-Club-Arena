import { fireEvent, render, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import LobbyTable from '../../src/components/lobby/LobbyTable';
import { cashEntry, type LobbyTableRow } from '../../src/components/lobby/lobbyEntries';

/* 2026-10-24, found live on the ALL tab: with the Sort By sheet set to
   "Stakes: High To Low", a featured 50 buy-in still sat above the 100s. ALL
   has no heading sort, so the page's chosen order IS the board, and the rule
   from 2026-10-23 ("A HEADING THE PLAYER CHOSE IS OBEYED") has to cover it:
   the featured pin decorates the default order only. */
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
const game = (id: string, bb: number, featured = false) =>
  cashEntry({
    id,
    name: `NLH ${bb / 2}/${bb}`,
    game_variant: 'nlh',
    small_blind: bb / 2,
    big_blind: bb,
    min_buy_in: 20 * bb,
    max_buy_in: 100 * bb,
    current_players: 3,
    max_players: 6,
    status: 'open',
    is_featured: featured,
  } as LobbyTableRow);

// The page has already put these in Stakes High To Low order.
const pageOrder = [game('high', 4), game('mid', 2), game('low-featured', 1, true)];

function board(orderChosen?: boolean) {
  localStorage.clear();
  render(
    <MemoryRouter>
      <LobbyTable
        entries={pageOrder}
        category="ALL"
        selectedId={null}
        onSelect={vi.fn()}
        onActivate={vi.fn()}
        ctx={ctx}
        orderChosen={orderChosen}
      />
    </MemoryRouter>
  );
  return () =>
    Array.from(document.querySelectorAll('.lobby-table-wrap tbody tr[id]')).map((el) =>
      el.id.replace('lt-row-', '')
    );
}

describe('the ALL tab obeys the Sort By order the player chose', () => {
  it('the default order still floats a featured game', () => {
    const ids = board();
    expect(ids()).toEqual(['low-featured', 'high', 'mid']);
  });

  it('a chosen Sort By keeps the page order: the featured pin stands down', () => {
    const ids = board(true);
    expect(ids()).toEqual(['high', 'mid', 'low-featured']);
  });

  it('a heading sort still decides the list once it is chosen', () => {
    const ids = board(true);
    const head = document.querySelector('.lobby-table-wrap thead') as HTMLElement;
    const stakes = within(head).getByRole('columnheader', { name: /stakes/i });
    fireEvent.click(within(stakes).queryByRole('button') ?? stakes);
    expect(ids()).toEqual(['low-featured', 'mid', 'high']);
  });
});

describe('the FEATURED chip says what the pin does', () => {
  it('names the pin as the default order, not an unconditional top spot', () => {
    board();
    const chip = document.querySelector('.lobby-table-wrap .lt-flag--featured');
    expect(chip?.getAttribute('title')).toBe(
      'Featured By The Host. Pinned To The Top Unless You Choose A Sort'
    );
  });
});

describe('the screen-reader status names the order that is actually in force', () => {
  it('announces the chosen Sort By when it, not a heading, orders the board', () => {
    localStorage.clear();
    render(
      <MemoryRouter>
        <LobbyTable
          entries={pageOrder}
          category="ALL"
          selectedId={null}
          onSelect={vi.fn()}
          onActivate={vi.fn()}
          ctx={ctx}
          orderChosen
          orderLabel="Stakes: High To Low"
        />
      </MemoryRouter>
    );
    const statuses = Array.from(document.querySelectorAll('[role="status"]')).map(
      (s) => s.textContent
    );
    expect(statuses).toContain('Sorted By Stakes: High To Low');
    expect(statuses).not.toContain('Default Order');
  });
});
