import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import LobbyTable from '../../src/components/lobby/LobbyTable';
import { cashEntry, type LobbyTableRow } from '../../src/components/lobby/lobbyEntries';

/* Post-deploy run 40292901952: the Join Lightning check picked lobby rows by
   the word "Lightning" in their name, and eight games named Lightning that
   were not running Lightning (variants taken off Lightning on 2026-10-25,
   nine-handed pilots, games below the switch-on count) filled every try.
   A row now says whether its game is live in Lightning mode, from the same
   `game.lightning` that turns its door into Join Lightning. */
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
const base = (id: string, name: string) =>
  cashEntry({
    id,
    name,
    game_variant: 'nlh',
    small_blind: 1,
    big_blind: 2,
    min_buy_in: 40,
    max_buy_in: 200,
    current_players: 3,
    max_players: 6,
    status: 'open',
  } as LobbyTableRow);

const live = base('live', 'NLH 1/2 Lightning Games');
const named = base('named', 'FLO8 0.25/0.50 Lightning Games');
const entries = [
  { ...live, game: { ...(live.game ?? {}), lightning: { players: 5, status: 'running' } } },
  named,
] as unknown as ReturnType<typeof cashEntry>[];

describe('a lobby row says when its game is live in Lightning mode', () => {
  it('marks only the game whose door is Join Lightning', () => {
    localStorage.clear();
    render(
      <MemoryRouter>
        <LobbyTable
          entries={entries}
          category="ALL"
          selectedId={null}
          onSelect={vi.fn()}
          onActivate={vi.fn()}
          ctx={ctx}
        />
      </MemoryRouter>
    );
    const marked = Array.from(document.querySelectorAll('tr[data-lightning="on"]')).map((el) =>
      el.getAttribute('data-id')
    );
    expect(marked.length).toBeGreaterThan(0);
    expect(new Set(marked)).toEqual(new Set(['live']));
    const unmarked = document.querySelectorAll('tr[data-id="named"]');
    expect(unmarked.length).toBeGreaterThan(0);
    unmarked.forEach((el) => expect(el.hasAttribute('data-lightning')).toBe(false));
  });
});
