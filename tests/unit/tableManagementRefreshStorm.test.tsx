/**
 * Table Management must survive its own event feed.
 *
 * Shipped bug, 2026-09-02: the board sat on "Loading Live Game Controls..."
 * forever on a busy club. Every game_management_events row for the scope is
 * delivered to the page as a refresh, and Deep Stack Society was writing ~5.5
 * of them a second, while one full load is five sequential round trips and was
 * measured at ~11 seconds against production. Refreshes therefore stacked, and
 * because each entry re-asserted setLoading(true) while only a load still
 * "current" at the END could clear it, none of them ever cleared it. The rows,
 * counts and health were dropped by the same guard, which is why every counter
 * read 0 while the header, set before the first long await, read correctly.
 *
 * These tests pin the three properties that fix required: a refresh storm
 * cannot stack, a background refresh never puts a rendered board back behind
 * the spinner, and - the trap the coalescing itself opened - an operator
 * arriving is never demoted to a background refresh just because one happened
 * to be in flight when they arrived.
 */
import { render, screen, waitFor } from '@testing-library/react';
import { act } from 'react';
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  listCalls: 0,
  listResolvers: [] as Array<(value: unknown) => void>,
  busHandlers: [] as Array<() => void>,
  resync: { current: null as null | (() => void) },
}));

const page = () => ({ total: 1, live: 1, scheduled: 0 });

vi.mock('../../src/hooks/useAuthUser', () => ({
  useAuthUser: () => ({ user: { id: 'operator-1' } }),
}));

vi.mock('../../src/hooks/useMasterBusSubscription', () => ({
  useMasterBusSubscription: () => {},
  // No debounce here on purpose: this test is about the page's own coalescing,
  // not about the shared hook's timer.
  useMasterBusSubscriptions: (_events: string[], handler: () => void) => {
    if (!mocks.busHandlers.includes(handler)) mocks.busHandlers.push(handler);
  },
}));

vi.mock('../../src/hooks/useGameManagementRealtime', () => ({
  useGameManagementRealtime: ({ onResync }: { onResync: () => void }) => {
    mocks.resync.current = onResync;
    return 'live';
  },
  default: () => 'live',
}));

vi.mock('../../src/utils/clubIdResolver', () => ({
  resolveClubUUID: async () => 'club-uuid-1',
}));

vi.mock('../../src/utils/errorReporter', () => ({ reportError: () => {} }));

vi.mock('../../src/services/GameAccessService', () => ({
  fetchGameCreationAccess: async () => ({ allowed: true, unionId: null, reason: 'ok' }),
}));

vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({
            data: { id: 'club-uuid-1', name: 'Deep Stack Society' },
            error: null,
          }),
        }),
      }),
    }),
  },
}));

vi.mock('../../src/services/UnionService', () => ({
  unionService: { isUnionAdmin: async () => false },
}));

vi.mock('../../src/components/common/Toast', () => ({
  useToast: () => ({ success: () => {}, error: () => {}, info: () => {} }),
}));

vi.mock('../../src/services/GameManagementService', () => ({
  gameManagementService: {
    list: () => {
      mocks.listCalls += 1;
      return new Promise((resolve) => mocks.listResolvers.push(resolve));
    },
    getContracts: async () => [],
    getCommandReceipts: async () => [],
    getHealth: async () => ({
      latestEventSequence: 0,
      lastEventAt: null,
      eventsLastHour: 0,
      commandsLast24h: 0,
      rejectedLast24h: 0,
      integrityAlerts: 0,
      scheduledPending: 0,
      scheduledRejected24h: 0,
      eventRows: 0,
      retentionDays: 30,
    }),
  },
}));

import GameManagementPage from '../../src/pages/GameManagementPage';

const renderBoard = () =>
  render(
    <MemoryRouter initialEntries={['/clubs/deep-stack-society-11192/table-management']}>
      <Routes>
        <Route
          path="/clubs/:clubId/table-management"
          element={<GameManagementPage scope="club" />}
        />
      </Routes>
    </MemoryRouter>
  );

const GoToAnotherClub = () => {
  const navigate = useNavigate();
  return (
    <button data-testid="go" onClick={() => navigate('/clubs/midway-social-9001/table-management')}>
      go
    </button>
  );
};

const renderBoardWithNav = () =>
  render(
    <MemoryRouter initialEntries={['/clubs/deep-stack-society-11192/table-management']}>
      <GoToAnotherClub />
      <Routes>
        <Route
          path="/clubs/:clubId/table-management"
          element={<GameManagementPage scope="club" />}
        />
      </Routes>
    </MemoryRouter>
  );

const settleFirstList = async () => {
  const resolve = mocks.listResolvers.shift();
  expect(resolve, 'the board never reached fn_list_managed_games').toBeTruthy();
  await act(async () => {
    resolve!({
      items: [
        {
          id: 'table-1',
          kind: 'table',
          name: 'Friday Deep Stack',
          status: 'running',
          club_id: 'club-uuid-1',
          game_variant: 'NLH',
          players: 6,
          max_players: 9,
          small_blind: 1,
          big_blind: 2,
          min_buy_in: 40,
          max_buy_in: 200,
        },
      ],
      counts: page(),
      nextCursor: null,
    });
  });
};

describe('Table Management under its own refresh storm', () => {
  beforeEach(() => {
    mocks.listCalls = 0;
    mocks.listResolvers.length = 0;
    mocks.busHandlers.length = 0;
    mocks.resync.current = null;
  });

  it('coalesces refreshes that arrive while a load is still running', async () => {
    renderBoard();
    await waitFor(() => expect(mocks.listCalls).toBe(1));

    // The feed this page listens to ran at ~5.5 events a second. Every one of
    // these used to start its own load.
    await act(async () => {
      for (let i = 0; i < 12; i += 1) mocks.busHandlers.forEach((fire) => fire());
      mocks.resync.current?.();
    });

    expect(
      mocks.listCalls,
      'a refresh that arrives mid-load must be queued once, never stacked'
    ).toBe(1);

    await settleFirstList();

    // Exactly one queued rerun is served after the first load lands.
    await waitFor(() => expect(mocks.listCalls).toBe(2));
  });

  it('leaves the loading state once the first load lands, storm or no storm', async () => {
    renderBoard();
    await waitFor(() => expect(mocks.listCalls).toBe(1));
    await act(async () => {
      for (let i = 0; i < 12; i += 1) mocks.busHandlers.forEach((fire) => fire());
    });

    await settleFirstList();

    await waitFor(() =>
      expect(screen.queryByText(/Loading Live Game Controls/i)).not.toBeInTheDocument()
    );
    expect(await screen.findByText('Friday Deep Stack')).toBeInTheDocument();
  });

  it('never puts a rendered board back behind the spinner for a background refresh', async () => {
    renderBoard();
    await waitFor(() => expect(mocks.listCalls).toBe(1));
    await settleFirstList();
    await screen.findByText('Friday Deep Stack');

    await act(async () => {
      mocks.busHandlers.forEach((fire) => fire());
      mocks.resync.current?.();
    });

    // The refresh is running (its list promise is unresolved) and the rows the
    // operator was reading are still on screen.
    await waitFor(() => expect(mocks.listCalls).toBe(2));
    expect(screen.queryByText(/Loading Live Game Controls/i)).not.toBeInTheDocument();
    expect(screen.getByText('Friday Deep Stack')).toBeInTheDocument();
  });

  /**
   * The regression coalescing introduces if the queued load is always silent.
   *
   * Switching clubs empties the board by design - a different club's games are
   * not this club's. If that reload is served silently because a background
   * refresh happened to be in flight when the operator navigated, they are
   * shown an empty board with no spinner, which reads as "this club has no
   * games" rather than "still loading". The queued load must inherit the
   * loudest request folded into it.
   */
  it('shows the spinner when an operator changes club mid-load, not an empty board', async () => {
    renderBoardWithNav();
    await waitFor(() => expect(mocks.listCalls).toBe(1));

    // The operator navigates while the first club's load is still in flight.
    await act(async () => {
      screen.getByTestId('go').click();
    });
    expect(mocks.listCalls, 'the navigation must be queued, not stacked').toBe(1);

    await settleFirstList();

    // The queued load is for a different club, so it clears the board - and it
    // must say so.
    await waitFor(() => expect(mocks.listCalls).toBe(2));
    expect(screen.queryByText('Friday Deep Stack')).not.toBeInTheDocument();
    expect(screen.getByText(/Loading Live Game Controls/i)).toBeInTheDocument();
  });
});
