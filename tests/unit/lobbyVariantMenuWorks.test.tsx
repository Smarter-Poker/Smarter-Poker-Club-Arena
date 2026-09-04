import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import LobbyTable from '../../src/components/lobby/LobbyTable';
import { cashEntry, type LobbyTableRow } from '../../src/components/lobby/lobbyEntries';
import { FILTER_SPECS } from '../../src/components/lobby/advancedFilterSpec';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE VARIANT SELECTOR ACTUALLY WORKS (Dan 2026-09-04)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Dan, verbatim: "THE VARIANT BUTTON HAS ZERO FUNCTIONALITY AND DOESN'T WORK AT
 * ALL, JUST SILENTLY FAILS." The screenshot was a pre-merge build, but a
 * heading that opens a menu is exactly the kind of thing a source grep cannot
 * prove. So this file RENDERS the lobby table, presses the heading, and
 * checks the menu, every item in it, the callback each one fires, and the
 * two ways it closes - as a thumb would.
 */

vi.mock('../../src/hooks/useSpinTierAvailability', () => ({
  useSpinTierAvailability: () => ({ can_draw_100x: false }),
}));

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

const ctx = {
  waitlistedIds: new Set<string>(),
  seatedIds: new Set<string>(),
  registeredIds: new Set<string>(),
  favoriteIds: new Set<string>(),
};

const holdem = FILTER_SPECS.HOLDEM.games!;

function renderLobby(selected: string[] = [], onVariantsChange = vi.fn()) {
  const utils = render(
    <MemoryRouter>
      <LobbyTable
        entries={[
          cashEntry(table({ id: 'a', name: 'NLH 1/2' })),
          cashEntry(table({ id: 'b', name: 'Pineapple 1', game_variant: 'pineapple' })),
        ]}
        category="HOLDEM"
        selectedId={null}
        onSelect={() => {}}
        onActivate={() => {}}
        ctx={ctx}
        variantChoices={holdem}
        selectedVariants={selected}
        onVariantsChange={onVariantsChange}
      />
    </MemoryRouter>
  );
  const bar = screen.getByRole('toolbar', { name: 'Sort Games' });
  const chip = within(bar).getByRole('button', { name: /variant/i });
  /* The same menu is rendered under the phone bar AND under the desktop
     heading (one is display:none per breakpoint), so every query here is
     scoped to the bar's copy. */
  const menu = () => within(bar).queryByRole('group', { name: 'Game Variant' });
  return { ...utils, bar, chip, menu, onVariantsChange };
}

describe('the Variant heading on the phone sort bar', () => {
  it('is a menu button, closed until pressed', () => {
    const { chip, menu } = renderLobby();
    expect(chip).toHaveAttribute('aria-haspopup', 'menu');
    expect(chip).toHaveAttribute('aria-expanded', 'false');
    expect(menu()).toBeNull();
  });

  it('opens the menu with All, every game on the tab in order, and Sort By Variant', () => {
    const { chip, menu: getMenu } = renderLobby();
    fireEvent.click(chip);
    expect(chip).toHaveAttribute('aria-expanded', 'true');
    const menu = getMenu()!;
    expect(menu).not.toBeNull();
    const items = within(menu)
      .getAllByRole('button')
      .map((b) => b.textContent?.trim());
    expect(items[0]).toBe('All');
    expect(items[items.length - 1]).toBe('Sort By Variant');
    // One item per game the tab sells, between All and the sort, in the
    // spec's canonical order (No Limit, Pineapple, Short Deck).
    expect(items.length).toBe(holdem.length + 2);
    expect(items.slice(1, -1).map((s) => s?.toLowerCase())).toEqual(
      ['no limit', 'pineapple', 'short deck'].slice(0, holdem.length)
    );
    // With nothing selected, All is the pressed one.
    expect(within(menu).getByRole('button', { name: 'All' })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
  });

  it('adds a game on press and reports the new selection to the page', () => {
    const { chip, menu: getMenu, onVariantsChange } = renderLobby([]);
    fireEvent.click(chip);
    const menu = getMenu()!;
    fireEvent.click(within(menu).getByRole('button', { name: /pineapple/i }));
    expect(onVariantsChange).toHaveBeenCalledTimes(1);
    expect(onVariantsChange).toHaveBeenCalledWith(['pineapple']);
    // Picking one game keeps the menu open so a second can be added.
    expect(getMenu()).not.toBeNull();
  });

  it('removes a game that is already selected, and All clears the lot', () => {
    const { chip, menu: getMenu, onVariantsChange } = renderLobby(['nlh', 'pineapple']);
    fireEvent.click(chip);
    const menu = getMenu()!;
    expect(within(menu).getByRole('button', { name: /pineapple/i })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    fireEvent.click(within(menu).getByRole('button', { name: /pineapple/i }));
    expect(onVariantsChange).toHaveBeenLastCalledWith(['nlh']);

    fireEvent.click(within(menu).getByRole('button', { name: 'All' }));
    expect(onVariantsChange).toHaveBeenLastCalledWith([]);
    // All is a terminal choice: the menu closes on it.
    expect(getMenu()).toBeNull();
  });

  it('shows how many games are chosen on the heading', () => {
    const { chip } = renderLobby(['nlh', 'pineapple']);
    // The desktop heading prints the count; the phone chip keeps the label.
    expect(chip.textContent).toMatch(/variant/i);
    expect(document.body.textContent).toContain('2 ▾');
  });

  it('Sort By Variant sorts the list and closes the menu', () => {
    const { bar, chip, menu: getMenu } = renderLobby();
    fireEvent.click(chip);
    const menu = getMenu()!;
    fireEvent.click(within(menu).getByRole('button', { name: 'Sort By Variant' }));
    expect(getMenu()).toBeNull();
    expect(within(bar).getByRole('status')).toHaveTextContent(/Sorted By Variant/);
  });

  it('closes on a second press of the heading, on Escape, and on a tap outside', () => {
    const { chip, menu } = renderLobby();
    // Press again. A pointerdown lands on the heading before its click does;
    // the outside-tap closer must not treat the heading as "outside" or the
    // click that follows re-opens what it just closed.
    fireEvent.click(chip);
    expect(menu()).not.toBeNull();
    fireEvent.pointerDown(chip);
    fireEvent.click(chip);
    expect(menu()).toBeNull();
    expect(chip).toHaveAttribute('aria-expanded', 'false');

    // Escape.
    fireEvent.click(chip);
    expect(menu()).not.toBeNull();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(menu()).toBeNull();

    // Outside tap.
    fireEvent.click(chip);
    expect(menu()).not.toBeNull();
    fireEvent.pointerDown(document.body);
    expect(menu()).toBeNull();
  });

  it('is plain sort heading on a tab with nothing to choose', () => {
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
    const chip = within(bar).getByRole('button', { name: /variant/i });
    expect(chip).not.toHaveAttribute('aria-haspopup');
    fireEvent.click(chip);
    expect(screen.queryByRole('group', { name: 'Game Variant' })).toBeNull();
  });
});

describe('the page wires the menu to the saved filter', () => {
  const page = readFileSync(resolve(process.cwd(), 'src/pages/ClubHomePage.tsx'), 'utf8');

  it("reads and writes the same `games` filter the Advanced Filters sheet does, on Hold'em and Omaha", () => {
    expect(page).toContain("gameType === 'HOLDEM' || gameType === 'OMAHA'");
    expect(page).toContain('variantChoices: vSpec.games');
    expect(page).toContain('selectedVariants: vVal.games');
    expect(page).toMatch(
      /onVariantsChange: \(games: string\[\]\) => \{[\s\S]*?setAdvFilters\(next\);[\s\S]*?saveFilters\(resolvedClubId, next\)/
    );
    // Both tabs the menu serves declare their games in the spec.
    expect(FILTER_SPECS.HOLDEM.games?.length).toBeGreaterThan(0);
    expect(FILTER_SPECS.OMAHA.games?.length).toBeGreaterThan(0);
  });
});
