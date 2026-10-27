import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { InTabLobbyContext, type InTabLobbyNav } from '../../src/context/InTabLobbyContext';

vi.mock('../../src/services/TournamentService', () => ({
  tournamentService: { getTournament: vi.fn(async () => null) },
}));
vi.mock('../../src/services/TableService', () => ({
  tableService: { getAveragePot: vi.fn(async () => null) },
}));
vi.mock('../../src/services/WaitlistService', () => ({
  waitlistService: { getTableWaitlist: vi.fn(async () => []) },
}));
vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    from: () => ({
      select: () => ({
        eq: () => {
          const result = Promise.resolve({ data: [], count: 0, error: null });
          return { is: () => result, then: result.then.bind(result) };
        },
      }),
    }),
  },
}));

import GameLobbyPanel from '../../src/components/lobby/GameLobbyPanel';
import {
  cashEntry,
  tournamentEntry,
  type LobbyEntry,
  type LobbyTournamentRow,
} from '../../src/components/lobby/lobbyEntries';

afterEach(cleanup);

const entry = tournamentEntry(
  {
    id: 'event-a',
    name: 'Evening Event',
    format_contract: 'mtt-v1',
    status: 'RUNNING',
    variant: 'nlh',
    current_players: 10,
    max_players: 100,
    buy_in_amount: 20,
    starting_chips: 1000,
  } as LobbyTournamentRow,
  'mtt'
);

function Location() {
  const location = useLocation();
  return <output data-testid="route">{location.pathname + location.search}</output>;
}

function mountDrawer(
  inTab?: InTabLobbyNav,
  selected: LobbyEntry = entry,
  onViewCashTable?: (id: string) => void,
  busy = false
) {
  const drawer = (
    <GameLobbyPanel
      entry={selected}
      clubId="club-a"
      currentUserId="viewer"
      waitlisted={false}
      seated={false}
      registered
      busy={busy}
      onClose={vi.fn()}
      onJoinTable={vi.fn()}
      onViewCashTable={onViewCashTable}
      onWaitlistToggle={vi.fn()}
      onRegister={vi.fn()}
      onUnregister={vi.fn()}
      onSpinJoin={vi.fn()}
    />
  );
  render(
    <MemoryRouter initialEntries={['/table/live']}>
      <Location />
      <Routes>
        <Route
          path="/table/live"
          element={
            <>
              <div data-testid="running-table">Running Table And Action Bar</div>
              {inTab ? (
                <InTabLobbyContext.Provider value={inTab}>{drawer}</InTabLobbyContext.Provider>
              ) : (
                drawer
              )}
            </>
          }
        />
        <Route path="/tournaments/:id" element={<div>Tournament Page</div>} />
        <Route path="/table/:id" element={<div>Selected Table</div>} />
      </Routes>
    </MemoryRouter>
  );
}

function tabNavigation(accept = true): InTabLobbyNav {
  return {
    openTournament: vi.fn(() => accept),
    openHub: vi.fn(() => false),
    goBack: vi.fn(),
  };
}

for (const action of ['Details', 'Return To Tournament']) {
  describe(`${action} from the selected tournament card`, () => {
    it('uses the embedded lobby destination and keeps its running table mounted', () => {
      const navigation = tabNavigation();
      mountDrawer(navigation);
      fireEvent.click(screen.getByRole('button', { name: action, exact: true }));
      expect(navigation.openTournament).toHaveBeenCalledExactlyOnceWith({
        tournamentId: 'event-a',
        search: '?club=club-a',
      });
      expect(screen.getByTestId('route')).toHaveTextContent('/table/live');
      expect(screen.getByTestId('running-table')).toBeInTheDocument();
    });

    it('keeps normal navigation outside an embedded lobby', () => {
      mountDrawer();
      fireEvent.click(screen.getByRole('button', { name: action, exact: true }));
      expect(screen.getByTestId('route')).toHaveTextContent('/tournaments/event-a?club=club-a');
      expect(screen.queryByTestId('running-table')).toBeNull();
    });
  });
}

it('falls back to normal navigation when the embedded container declines the destination', () => {
  const navigation = tabNavigation(false);
  mountDrawer(navigation);
  fireEvent.click(screen.getByRole('button', { name: 'Details', exact: true }));
  expect(navigation.openTournament).toHaveBeenCalledExactlyOnceWith({
    tournamentId: 'event-a',
    search: '?club=club-a',
  });
  expect(screen.getByTestId('route')).toHaveTextContent('/tournaments/event-a?club=club-a');
});

it('keeps cash-table navigation outside the tournament interception', () => {
  const navigation = tabNavigation();
  const cash = cashEntry({
    id: 'cash-a',
    name: 'Cash Game',
    game_variant: 'nlh',
    status: 'active',
    small_blind: 1,
    big_blind: 2,
    min_buy_in: 40,
    max_buy_in: 200,
    current_players: 2,
    max_players: 6,
  });
  mountDrawer(navigation, cash);
  fireEvent.click(screen.getByRole('button', { name: 'View Table', exact: true }));
  expect(navigation.openTournament).not.toHaveBeenCalled();
  expect(screen.getByTestId('route').textContent).toBe('/table/cash-a');
});

it('cash Details uses the prepared-entry door instead of navigating an unready felt', () => {
  const prepare = vi.fn();
  const cash = cashEntry({
    id: 'cash-a',
    name: 'Cash Game',
    game_variant: 'nlh',
    status: 'active',
    small_blind: 1,
    big_blind: 2,
    min_buy_in: 40,
    max_buy_in: 200,
    current_players: 2,
    max_players: 6,
  });
  mountDrawer(undefined, cash, prepare);
  fireEvent.click(screen.getByRole('button', { name: 'View Table', exact: true }));
  expect(prepare).toHaveBeenCalledExactlyOnceWith('cash-a');
  expect(screen.getByTestId('route').textContent).toBe('/table/live');
});

it('preserves tournament Details navigation while an unrelated action is busy', () => {
  mountDrawer(undefined, entry, undefined, true);
  fireEvent.click(screen.getByRole('button', { name: 'Details', exact: true }));
  expect(screen.getByTestId('route')).toHaveTextContent('/tournaments/event-a?club=club-a');
});
