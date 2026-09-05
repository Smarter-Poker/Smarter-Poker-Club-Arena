import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import LobbyTable from '../../src/components/lobby/LobbyTable';
import {
  cashEntry,
  cashTitleLines,
  type LobbyTableRow,
} from '../../src/components/lobby/lobbyEntries';
import {
  CASH_STYLES,
  FILTER_SPECS,
  emptyFilterValue,
  isFilterActive,
  rowPassesFilter,
} from '../../src/components/lobby/advancedFilterSpec';
import { sanitizeStore } from '../../src/components/lobby/AdvancedFilters';
import { CASH_TEMPLATES } from '../../src/config/cashGames';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE STAKES MENU AND THE STYLE SUBTITLE (Dan 2026-09-04)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Dan, verbatim: "UNDER ALL THE GAMES TITLES INSTEAD OF REPEATING THE STAKES
 * AGAIN, SHOULD JUST SAY 'CLASSIC' 'ACTION' OR 'MADNESS' ON THE DESK TOP
 * DISPLAY. 2, YOU NEED TO ADD AN 'ACTION SELECTOR' IN THE STAKES DROP DOWN
 * WHERE USERS CAN SELECT 'CLASSIC' 'ACTION' OR 'MADNESS' AS AN OPTION. AND THE
 * BAR POP UP SHOULD HAVE A 'SORT' HIGH TO LOW, OR LOW TO HIGH INSIDE OF IT."
 *
 * The screenshot showed "NLH 0.10/0.25" over ".10/.25 Classic": the name had
 * been through formatGameTitle (which drops a leading zero) and the stripper
 * required one, so every micro table printed its stakes twice.
 */

vi.mock('../../src/hooks/useSpinTierAvailability', () => ({
  useSpinTierAvailability: () => ({ can_draw_100x: false }),
}));

const ROOT = resolve(__dirname, '../..');
const read = (p: string) => readFileSync(resolve(ROOT, p), 'utf8');

const table = (over: Partial<LobbyTableRow>): LobbyTableRow =>
  ({
    id: 't',
    name: 'NLH 1/2',
    game_variant: 'nlh',
    small_blind: 1,
    big_blind: 2,
    min_buy_in: 80,
    max_buy_in: 400,
    current_players: 3,
    max_players: 6,
    status: 'open',
    ...over,
  }) as LobbyTableRow;

describe('the second line of a templated game is its style, never its stakes', () => {
  it('reads the template off the game row', () => {
    for (const t of CASH_TEMPLATES) {
      const e = cashEntry(
        table({
          name: `NLH 0.10/0.25 ${t.label}`,
          small_blind: 0.1,
          big_blind: 0.25,
          cluster_id: 'g',
          cluster_template: t.id,
          cluster_must_move: true,
        })
      );
      const lines = cashTitleLines(e);
      expect(lines.subtitle).toBe(t.label);
      expect(lines.subtitle).not.toMatch(/\d/);
      expect(lines.headline).toMatch(/^NLH/);
    }
  });

  it('strips a leading-dot stake off an untemplated name (the formatGameTitle shape)', () => {
    const e = cashEntry(table({ name: 'NLH 0.05/0.10', small_blind: 0.05, big_blind: 0.1 }));
    expect(e.name).toBe('NLH .05/.10');
    expect(cashTitleLines(e).subtitle).toBeNull();
    const named = cashEntry(
      table({ name: 'NLH 0.25/0.50 Late Night', small_blind: 0.25, big_blind: 0.5 })
    );
    expect(cashTitleLines(named).subtitle).toBe('Late Night');
  });
});

describe('the Game Style filter', () => {
  const spec = FILTER_SPECS.HOLDEM;
  const row = (style: string | null) => ({
    variant: 'nlh',
    price: 2,
    seats: 6,
    seatsTaken: 3,
    name: 'NLH 1/2',
    style,
    row: {},
    settings: {},
  });

  it('is offered on every cash tab, in the vocabulary order, and on no tournament tab', () => {
    expect(CASH_STYLES.map((s) => s.key)).toEqual(['classic', 'action', 'madness']);
    for (const tab of ['HOLDEM', 'OMAHA', 'LIMIT'] as const) {
      expect(FILTER_SPECS[tab].styles).toBe(CASH_STYLES);
    }
    for (const tab of ['MTT', 'SPIN', 'SNG'] as const) {
      expect(FILTER_SPECS[tab].styles).toBeUndefined();
    }
  });

  it('nothing chosen shows everything; a chosen style hides the others AND the untemplated', () => {
    const none = emptyFilterValue(spec);
    expect(rowPassesFilter(spec, none, row('action'))).toBe(true);
    expect(rowPassesFilter(spec, none, row(null))).toBe(true);
    const action = { ...none, styles: ['action'] };
    expect(rowPassesFilter(spec, action, row('action'))).toBe(true);
    expect(rowPassesFilter(spec, action, row('ACTION'))).toBe(true);
    expect(rowPassesFilter(spec, action, row('classic'))).toBe(false);
    expect(rowPassesFilter(spec, action, row(null))).toBe(false);
    expect(isFilterActive(spec, none)).toBe(false);
    expect(isFilterActive(spec, action)).toBe(true);
  });

  it('a saved value from before this field, and a key this build does not define, both survive', () => {
    const legacy = sanitizeStore({
      HOLDEM: { ...emptyFilterValue(spec), styles: undefined },
    } as never);
    expect(legacy.HOLDEM?.styles).toEqual([]);
    const junk = sanitizeStore({
      HOLDEM: { ...emptyFilterValue(spec), styles: ['madness', 'turbo'] },
    });
    expect(junk.HOLDEM?.styles).toEqual(['madness']);
  });

  it('the club home hands the row its template and the sheet has a Game Style section', () => {
    const page = read('src/pages/ClubHomePage.tsx');
    expect(page).toMatch(/style: table\.cluster_template \?\? null,/);
    expect(page).toMatch(/styleChoices: sSpec\.styles,/);
    expect(page).toMatch(
      /gameType === 'HOLDEM' \|\| gameType === 'OMAHA' \|\| gameType === 'LIMIT'/
    );
    const sheet = read('src/components/lobby/AdvancedFilters.tsx');
    expect(sheet).toMatch(/<h3>Game Style<\/h3>/);
    expect(sheet).toMatch(/chipRow\(spec\.styles, 'styles', value\.styles \?\? \[\]\)/);
  });
});

const ctx = {
  waitlistedIds: new Set<string>(),
  seatedIds: new Set<string>(),
  registeredIds: new Set<string>(),
  favoriteIds: new Set<string>(),
};

function renderLobby(selected: string[] = [], onStylesChange = vi.fn()) {
  const utils = render(
    <MemoryRouter>
      <LobbyTable
        entries={[
          cashEntry(table({ id: 'a', name: 'NLH 1/2 Classic', cluster_template: 'classic' })),
          cashEntry(
            table({
              id: 'b',
              name: 'NLH 2/5 Action',
              small_blind: 2,
              big_blind: 5,
              cluster_template: 'action',
            })
          ),
        ]}
        category="HOLDEM"
        selectedId={null}
        onSelect={() => {}}
        onActivate={() => {}}
        ctx={ctx}
        styleChoices={CASH_STYLES}
        selectedStyles={selected}
        onStylesChange={onStylesChange}
      />
    </MemoryRouter>
  );
  const bar = screen.getByRole('toolbar', { name: 'Sort Games' });
  const chip = within(bar).getByRole('button', { name: /stakes/i });
  /* Rendered under the phone bar AND the desktop heading (one is display:none
     per breakpoint); every query is scoped to the bar's copy. */
  const menu = () => within(bar).queryByRole('group', { name: 'Stakes' });
  return { ...utils, bar, chip, menu, onStylesChange };
}

describe('the Stakes heading on the phone sort bar', () => {
  it('is a menu trigger, closed until pressed', () => {
    const { chip, menu } = renderLobby();
    expect(chip).toHaveAttribute('aria-haspopup', 'menu');
    expect(chip).toHaveAttribute('aria-expanded', 'false');
    expect(menu()).toBeNull();
  });

  it('opens to All, the three styles in order, then High To Low and Low To High', () => {
    const { chip, menu } = renderLobby();
    fireEvent.click(chip);
    const m = menu();
    expect(m).not.toBeNull();
    const items = within(m!)
      .getAllByRole('button')
      .map((b) => b.textContent?.trim());
    expect(items).toEqual(['All', 'Classic', 'Action', 'Madness', 'High To Low', 'Low To High']);
    expect(within(m!).getByRole('button', { name: 'All' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('a style toggles into the saved selection; All clears it and closes', () => {
    const { chip, menu, onStylesChange } = renderLobby(['classic']);
    fireEvent.click(chip);
    fireEvent.click(within(menu()!).getByRole('button', { name: 'Action' }));
    expect(onStylesChange).toHaveBeenLastCalledWith(['classic', 'action']);
    fireEvent.click(within(menu()!).getByRole('button', { name: 'Classic' }));
    expect(onStylesChange).toHaveBeenLastCalledWith([]);
    expect(menu()).not.toBeNull();
    fireEvent.click(within(menu()!).getByRole('button', { name: 'All' }));
    expect(onStylesChange).toHaveBeenLastCalledWith([]);
    expect(menu()).toBeNull();
  });

  it('High To Low sorts the board by stakes descending, Low To High ascending, and closes', () => {
    const { chip, menu, bar } = renderLobby();
    const rowsInOrder = () =>
      Array.from(document.querySelectorAll('.lobby-table-wrap .lt-name__line1')).map((el) =>
        el.textContent?.trim()
      );
    fireEvent.click(chip);
    fireEvent.click(within(menu()!).getByRole('button', { name: 'High To Low' }));
    expect(menu()).toBeNull();
    expect(within(bar).getByRole('status').textContent).toMatch(/Sorted By Stakes, Descending/);
    expect(rowsInOrder()[0]).toMatch(/2\/5/);
    fireEvent.click(chip);
    expect(within(menu()!).getByRole('button', { name: 'High To Low' })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    fireEvent.click(within(menu()!).getByRole('button', { name: 'Low To High' }));
    expect(within(bar).getByRole('status').textContent).toMatch(/Sorted By Stakes, Ascending/);
    expect(rowsInOrder()[0]).toMatch(/1\/2/);
  });

  it('closes on Escape and on a tap outside', () => {
    const { chip, menu } = renderLobby();
    fireEvent.click(chip);
    expect(menu()).not.toBeNull();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(menu()).toBeNull();
    fireEvent.click(chip);
    expect(menu()).not.toBeNull();
    fireEvent.pointerDown(document.body);
    expect(menu()).toBeNull();
  });

  it('without style choices the Stakes chip is a plain sort toggle, as before', () => {
    render(
      <MemoryRouter>
        <LobbyTable
          entries={[cashEntry(table({ id: 'a' }))]}
          category="HOLDEM"
          selectedId={null}
          onSelect={() => {}}
          onActivate={() => {}}
          ctx={ctx}
        />
      </MemoryRouter>
    );
    const bar = screen.getByRole('toolbar', { name: 'Sort Games' });
    const chip = within(bar).getByRole('button', { name: /stakes/i });
    expect(chip).not.toHaveAttribute('aria-haspopup');
  });
});

describe('the desktop Stakes heading carries the same menu', () => {
  it('is wired to the same open state, the same items and the same sort', () => {
    const src = read('src/components/lobby/LobbyTable.tsx');
    const th = src.slice(src.indexOf('<thead'), src.indexOf('<tbody'));
    expect(th).toMatch(/col\.key === 'stakes' && hasStakesMenu && stakesMenuOpen/);
    expect(th).toMatch(/onSort=\{\(dir\) => applySort\(COL_STAKES, dir\)\}/);
    expect(src).toMatch(/const applySort = \(col: ColumnDef, dir: SortDir\)/);
    expect(src).toMatch(
      /writeSort\(clubId, category, next\);\s*\};\s*\n\s*const handleHeaderClick/
    );
  });
});
