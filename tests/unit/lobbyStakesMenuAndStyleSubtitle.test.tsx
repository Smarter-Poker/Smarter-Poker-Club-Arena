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

// Sorting and style selection are local UI behavior. Keep table warm-up at
// its transport boundary, as the variant-menu fixture does; its dedicated
// lifecycle suites cover the real subscription and cleanup paths.
vi.mock('../../src/services/tableWarmup', () => ({
  warmTable: vi.fn(),
  observeLobbyTableWarmups: vi.fn(() => () => undefined),
}));

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
    expect(CASH_STYLES.map((s) => s.key)).toEqual(['classic', 'madness', 'straight_madness']);
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
    const old = sanitizeStore({
      HOLDEM: { ...emptyFilterValue(spec), styles: ['action', 'madness'] },
    });
    expect(old.HOLDEM?.styles).toEqual(['madness']);
  });

  it('the club home hands the row its template and the sheet has a Game Style section', () => {
    const page = read('src/pages/ClubHomePage.tsx');
    expect(page).toMatch(/style: cashStyleKeyOf\(table as unknown as LobbyTableRow\),/);
    expect(page).not.toContain('onStylesChange:');
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
          cashEntry(
            table({
              id: 'a',
              cluster_id: 'g1',
              name: 'NLH 1/2 Classic',
              cluster_template: 'classic',
            })
          ),
          cashEntry(
            table({
              id: 'b',
              cluster_id: 'g2',
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
  const bar = document.querySelector<HTMLElement>('.arena-lobby-card-list')!;
  const chip = within(bar).getByRole('button', { name: /stakes/i });
  /* Rendered under the phone bar AND the desktop heading (one is display:none
     per breakpoint); every query is scoped to the bar's copy. */
  const menu = () => within(bar).queryByRole('group', { name: 'Stakes' });
  return { ...utils, bar, chip, menu, onStylesChange };
}

describe('Lightning Games lobby identity', () => {
  it('replaces the dot with the painted bolt only for Lightning rows, including legacy aliases', () => {
    renderLobby();
    const icons = screen.getAllByRole('img', { name: 'Lightning Games' });
    expect(icons).toHaveLength(2);
    for (const icon of icons) {
      expect(icon.getAttribute('src')).toContain('lightning_bolt-192-242cf8769546.webp');
      expect(icon.closest('tr')?.getAttribute('data-cash-format')).toBe('madness');
      expect(icon.closest('tr')?.getAttribute('data-lightning-format')).toBe('true');
    }
    expect(document.querySelector('tr[data-cash-format="classic"] .lt-lightning-icon')).toBeNull();
    expect(read('src/components/lobby/ClubLobbyCommandTop.css')).toContain(
      "tr[data-cash-format='madness'] td.lt-col-name::before"
    );
  });
  it('does not mark ordinary Madness or variants excluded from Lightning', () => {
    render(
      <MemoryRouter>
        <LobbyTable
          entries={[
            cashEntry(
              table({
                id: 'ordinary-madness',
                cluster_id: 'g1',
                cluster_template: 'classic',
                big_blind_ante_enabled: true,
                nit_game: true,
                maintain_percent_min: 50,
                bomb_pot_enabled: true,
              })
            ),
            cashEntry(
              table({
                id: 'excluded',
                cluster_id: 'g2',
                cluster_template: 'action',
                game_variant: 'short_deck',
              })
            ),
          ]}
          category="HOLDEM"
          selectedId={null}
          onSelect={() => {}}
          onActivate={() => {}}
          ctx={ctx}
        />
      </MemoryRouter>
    );
    expect(screen.queryByRole('img', { name: 'Lightning Games' })).toBeNull();
    expect(document.querySelector('tr[data-lightning-format="true"]')).toBeNull();
  });
});

describe('Stakes headings directly adjust the same board without popups', () => {
  it('toggles the compact sort and never opens a menu or changes style filters', () => {
    const { chip, menu, onStylesChange } = renderLobby();
    const rows = () =>
      Array.from(document.querySelectorAll('.compact-lobby tbody tr[data-id]')).map((el) =>
        el.getAttribute('data-id')
      );
    expect(rows()).toEqual(['a', 'b']);
    fireEvent.click(chip);
    expect(rows()).toEqual(['b', 'a']);
    expect(menu()).toBeNull();
    expect(chip).not.toHaveAttribute('aria-haspopup');
    expect(onStylesChange).not.toHaveBeenCalled();
    fireEvent.click(chip);
    expect(rows()).toEqual(['a', 'b']);
  });
  it('supports desktop pointer and keyboard sorting with no popup', () => {
    renderLobby();
    const head = document.querySelector('.lobby-table-wrap thead') as HTMLElement;
    const stakes = within(head).getByRole('columnheader', { name: /stakes/i });
    fireEvent.click(stakes);
    expect(stakes).toHaveAttribute('aria-sort', 'descending');
    fireEvent.keyDown(stakes, { key: 'Enter' });
    expect(stakes).toHaveAttribute('aria-sort', 'ascending');
    expect(document.querySelector('.lt-stakes-menu')).toBeNull();
  });
});

describe('schedule frames paint above opaque table cells', () => {
  it('keeps all four featured and Lightning edges on the cell paint layer', () => {
    for (const path of [
      'src/components/lobby/CompactLobbyRows.css',
      'src/components/lobby/LobbyTable.css',
    ]) {
      const css = read(path);
      for (const identity of ['.is-featured', "[data-lightning-format='true']"]) {
        const escaped = identity.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        for (const edge of ['first-child', 'last-child']) {
          const rule = css.match(new RegExp(escaped + ' td:' + edge + ' {([^}]+)}'));
          expect(rule, `${path}: ${identity} ${edge}`).not.toBeNull();
          expect(rule![1]).toContain('inset 0 2px 0');
          expect(rule![1]).toContain('inset 0 -2px 0');
          expect(rule![1]).toContain(edge === 'first-child' ? 'inset 2px 0 0' : 'inset -2px 0 0');
        }
      }
    }
  });
});
