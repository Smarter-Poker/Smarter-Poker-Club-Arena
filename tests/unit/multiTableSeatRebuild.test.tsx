import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation, useNavigate } from 'react-router-dom';
import { clearSessionSummary, peekSessionSummary } from '../../src/services/pendingSessionSummary';

type QueryResult = { data: unknown; error: unknown };
type SeatRead = {
  userId: string;
  settled: boolean;
  resolve: (value: QueryResult) => void;
  reject: (error: Error) => void;
};
const state = vi.hoisted(() => ({
  lightningSession: vi.fn(),
  user: { id: 'account-a' } as { id: string } | null,
  listeners: new Map<string, Set<(event: { payload: unknown }) => void>>(),
  reads: [] as SeatRead[],
  metadata: [] as string[][],
  finishRead: vi.fn(),
  moveSession: vi.fn(),
  reportAtUnmount: new Map<string, number | null>(),
  metadataResults: [] as (QueryResult | Promise<QueryResult>)[],
  reports: new Map<string, (info: Record<string, unknown>) => void>(),
  inserts: [] as ((payload: unknown) => void)[],
  toast: { info: vi.fn(), warning: vi.fn(), error: vi.fn(), success: vi.fn() },
}));

vi.mock('../../src/services/tournamentResult', () => ({ fetchTournamentResult: state.finishRead }));
vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    from(table: string) {
      let columns = '';
      let userId = '';
      let ids: string[] = [];
      const query = {
        select(value: string) {
          columns = value;
          return query;
        },
        eq(key: string, value: string) {
          if (key === 'user_id') userId = value;
          return query;
        },
        is() {
          return query;
        },
        in(_key: string, value: string[]) {
          ids = value;
          return query;
        },
        limit() {
          return query;
        },
        order() {
          return query;
        },
        neq() {
          return query;
        },
        maybeSingle() {
          return Promise.resolve({ data: null, error: null });
        },
        then(resolve: (value: QueryResult) => unknown, reject: (error: Error) => unknown) {
          if (table === 'table_seats') {
            const promise = new Promise<QueryResult>((yes, no) => {
              const read: SeatRead = {
                userId,
                settled: false,
                resolve(value) {
                  read.settled = true;
                  yes(value);
                },
                reject(error) {
                  read.settled = true;
                  no(error);
                },
              };
              state.reads.push(read);
            });
            return promise.then(resolve, reject);
          }
          if (table === 'tables' && columns.includes('tournament_id')) {
            state.metadata.push(ids);
            const queued = state.metadataResults.shift();
            if (queued) return Promise.resolve(queued).then(resolve, reject);
          }
          const data =
            table === 'tables'
              ? ids.map((id) => ({
                  id,
                  name: 'Table ' + id,
                  game_type: 'cash',
                  game_variant: 'nlh',
                  small_blind: 1,
                  big_blind: 2,
                  max_players: 6,
                  tournament_id: null,
                  club_id: null,
                }))
              : [];
          return Promise.resolve({ data, error: null }).then(resolve, reject);
        },
      };
      return query;
    },
    rpc: (...args: unknown[]) => state.lightningSession(...args),
    auth: { getSession: vi.fn(async () => ({ data: { session: null }, error: null })) },
  },
}));
vi.mock('../../src/core/MasterBus', () => {
  const subscribe = (event: string, handler: (event: { payload: unknown }) => void) => {
    const listeners = state.listeners.get(event) ?? new Set();
    listeners.add(handler);
    state.listeners.set(event, listeners);
    return () => listeners.delete(handler);
  };
  return {
    masterBus: {
      subscribe,
      subscribeDebounced: subscribe,
      emit(event: string, payload: unknown) {
        for (const handler of state.listeners.get(event) ?? []) handler({ payload });
      },
      getOrCreateChannel() {
        const channel = {
          on(
            _kind: string,
            filter: { table?: string; event?: string },
            callback: (payload: unknown) => void
          ) {
            if (filter.table === 'table_seats' && filter.event === 'INSERT')
              state.inserts.push(callback);
            return channel;
          },
          subscribe() {
            return channel;
          },
        };
        return channel;
      },
      removeRegisteredChannel: vi.fn(),
    },
  };
});
vi.mock('../../src/hooks/useAuthUser', () => ({
  useAuthUser: () => ({ user: state.user, isAuthenticated: !!state.user, isHydrating: false }),
}));
vi.mock('../../src/hooks/useUserTableSettings', () => ({
  useUserTableSettings: () => ({ settings: {} }),
}));
vi.mock('../../src/stores/useUserStore', () => {
  const current = () => ({ user: state.user, isAuthenticated: !!state.user });
  const store = Object.assign(
    (selector?: (value: ReturnType<typeof current>) => unknown) =>
      selector ? selector(current()) : current(),
    { getState: current }
  );
  return { useUserStore: store };
});
vi.mock('../../src/components/common/Toast', () => ({ useToast: () => state.toast }));
vi.mock('../../src/components/navigation/GlobalHeader', () => ({ default: () => null }));
vi.mock('../../src/components/table/LiveTablesBar', () => ({ default: () => null }));
vi.mock('../../src/components/table/HubFrame', () => ({ HubFrame: () => <div>Hub Page</div> }));
vi.mock('../../src/components/table/TableTabBar', () => ({
  TableTabBar: ({
    tabs,
    activeTabId,
    onTabSelect,
  }: {
    tabs: { id: string }[];
    activeTabId: string;
    onTabSelect: (id: string) => void;
  }) => (
    <>
      <div data-testid="tabs" data-active={activeTabId}>
        {tabs.map((tab) => tab.id).join(',')}
      </div>
      {tabs.map((tab) => (
        <button key={tab.id} data-testid={'tab-' + tab.id} onClick={() => onTabSelect(tab.id)}>
          Select {tab.id}
        </button>
      ))}
    </>
  ),
}));
vi.mock('../../src/components/table/ActionPanel', () => ({
  betSliderStep: () => 1,
  sliderUnitFor: () => 1,
}));
vi.mock('../../src/services/SoundService', () => ({
  soundService: new Proxy({}, { get: () => vi.fn() }),
  haptic: new Proxy({}, { get: () => vi.fn() }),
}));
vi.mock('../../src/hooks/useServerCashSessionProfit', () => ({
  useServerCashSessionProfit: () => ({}),
}));
vi.mock('../../src/services/SessionStatsService', () => ({
  sessionStatsService: { getStats: () => null, moveSession: state.moveSession },
}));
vi.mock('../../src/services/GameServerAPI', () => ({
  setSitOut: vi.fn(),
  submitAction: vi.fn(),
}));
vi.mock('../../src/utils/clubQuickLink', () => ({ resolveLobbyClubId: async () => null }));
vi.mock('../../src/utils/lazyWithRetry', () => ({
  lazyWithRetry: (loader: () => Promise<unknown>) => {
    if (!String(loader).includes('TablePage'))
      return function Lobby() {
        const navigate = useAppNavigate();
        const context = useInTabLobby();
        return (
          <button
            onClick={() =>
              navigate('/table/B', {
                state: {
                  tournamentSeat: {
                    tournamentId: 'event',
                    lobbyTabId: context?.getLobbyTabId?.(),
                  },
                },
              })
            }
          >
            Register In This Pill
          </button>
        );
      };
    return function Felt({
      embeddedTableId,
      onTableInfoUpdate,
    }: {
      embeddedTableId: string;
      onTableInfoUpdate: (info: Record<string, unknown>) => void;
    }) {
      state.reports.set(embeddedTableId, onTableInfoUpdate);
      React.useEffect(
        () => () => {
          state.reportAtUnmount.set(
            embeddedTableId,
            peekSessionSummary()?.tournament?.finishPlace ?? null
          );
        },
        [embeddedTableId]
      );
      return <div data-testid={'felt-' + embeddedTableId}>Felt {embeddedTableId}</div>;
    };
  },
}));

import MultiTablePage from '../../src/pages/MultiTablePage';
import { useAppNavigate, useInTabLobby } from '../../src/context/InTabLobbyContext';
import {
  resetLightningRegistryForTests,
  getLightningPoolSession,
} from '../../src/lightning/lightningSession';
import { masterBus } from '../../src/core/MasterBus';

function Location() {
  const navigate = useNavigate();
  return (
    <>
      <output data-testid="location">{useLocation().pathname}</output>
      <button onClick={() => navigate('/table/A')}>Enter Assigned Tournament</button>
    </>
  );
}
function page() {
  return (
    <MemoryRouter initialEntries={['/table/A']}>
      <MultiTablePage />
      <Location />
    </MemoryRouter>
  );
}
function mount() {
  return render(page());
}
async function settle(read: SeatRead, ids: string[]) {
  await act(async () => read.resolve({ data: ids.map((table_id) => ({ table_id })), error: null }));
}
async function seatA() {
  const view = mount();
  await waitFor(() => expect(state.reads).toHaveLength(1));
  await settle(state.reads[0], ['A']);
  await act(async () => masterBus.emit('TABLE_SEATED', { tableId: 'A', userId: 'account-a' }));
  for (const read of state.reads.filter((read) => !read.settled)) await settle(read, ['A']);
  expect(screen.getByTestId('felt-A')).toBeTruthy();
  return view;
}
async function reconnect() {
  const before = state.reads.length;
  await act(async () => masterBus.emit('WS_CONNECTED', {}));
  await waitFor(() => expect(state.reads.length).toBe(before + 1));
  return state.reads.at(-1)!;
}

beforeEach(() => {
  state.user = { id: 'account-a' };
  resetLightningRegistryForTests();
  state.lightningSession.mockReset();
  state.listeners.clear();
  state.reads.length = 0;
  state.metadata.length = 0;
  state.metadataResults.length = 0;
  state.inserts.length = 0;
  state.reports.clear();
  state.reportAtUnmount.clear();
  for (let i = 0; i < 6; i++) clearSessionSummary();
  vi.clearAllMocks();
  localStorage.clear();
  sessionStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('Rendered MultiTable authoritative seat rebuild', () => {
  it('enters the assigned game when its URL is already borrowed by the lobby', async () => {
    await seatA();
    await act(async () => masterBus.emit('OPEN_LOBBY_TAB', {}));
    expect(screen.getByTestId('tabs').getAttribute('data-active')).not.toBe('A');
    expect(screen.getByTestId('location').textContent).toBe('/table/A');
    fireEvent.click(screen.getByText('Enter Assigned Tournament'));
    await waitFor(() => expect(screen.getByTestId('tabs').getAttribute('data-active')).toBe('A'));
    expect(screen.getByTestId('felt-A')).toBeTruthy();
  });
  it('replaces the registration lobby pill rather than opening another page', async () => {
    await seatA();
    await act(async () => masterBus.emit('OPEN_LOBBY_TAB', {}));
    const before = screen.getByTestId('tabs').getAttribute('data-active');
    const count = screen.getByTestId('tabs').textContent?.split(',').length;
    expect(before).toContain('lobby:');
    fireEvent.click(screen.getByText('Register In This Pill'));
    await waitFor(() => expect(screen.getByTestId('tabs').getAttribute('data-active')).toBe('B'));
    expect(screen.queryByTestId('tab-' + before)).toBeNull();
    expect(screen.getByTestId('felt-A')).toBeTruthy();
    expect(screen.getByTestId('felt-B')).toBeTruthy();
    expect(screen.getByTestId('tabs').textContent?.split(',').length).toBe(count);
  });
  it('uses the initiating pill even if the seat event already opened the game in the background', async () => {
    await seatA();
    await act(async () => masterBus.emit('OPEN_LOBBY_TAB', {}));
    const lobby = screen.getByTestId('tabs').getAttribute('data-active');
    await act(async () => masterBus.emit('TABLE_SEATED', { tableId: 'B', userId: 'account-a' }));
    expect(screen.getByTestId('tabs').getAttribute('data-active')).toBe(lobby);
    fireEvent.click(screen.getByText('Register In This Pill'));
    await waitFor(() => expect(screen.getByTestId('tabs').getAttribute('data-active')).toBe('B'));
    expect(screen.getByTestId('tabs').textContent).toBe('A,B');
    expect(screen.queryByTestId('tab-' + lobby)).toBeNull();
  });
  it('consumes an admission lobby at the cap without a false blocked-seat warning', async () => {
    await seatA();
    await act(async () => masterBus.emit('TABLE_SEATED', { tableId: 'C', userId: 'account-a' }));
    await act(async () => masterBus.emit('TABLE_SEATED', { tableId: 'D', userId: 'account-a' }));
    await act(async () => masterBus.emit('OPEN_LOBBY_TAB', {}));
    const origin = screen.getByTestId('tabs').getAttribute('data-active')!;
    const blocked = vi.fn();
    state.listeners.set('TABLE_CAP_BLOCKED', new Set([blocked]));
    await act(async () =>
      masterBus.emit('TABLE_SEATED', {
        tableId: 'B',
        userId: 'account-a',
        registrationLobbyTabId: origin,
      })
    );
    expect(screen.getByTestId('tabs').textContent).toBe('A,C,D,B');
    expect(screen.queryByTestId('tab-' + origin)).toBeNull();
    expect(blocked).not.toHaveBeenCalled();
  });
  it('hands the game session over before a verified tournament seat insertion replaces the felt', async () => {
    await seatA();
    state.metadataResults.push({
      data: [
        { id: 'A', name: 'Old', tournament_id: 'event', small_blind: 1, big_blind: 2 },
        { id: 'B', name: 'New', tournament_id: 'event', small_blind: 1, big_blind: 2 },
      ],
      error: null,
    });
    expect(state.inserts.length).toBeGreaterThan(0);
    await act(async () => state.inserts[0]({ new: { table_id: 'B', left_at: null } }));
    await waitFor(() => expect(state.moveSession).toHaveBeenCalledWith('A', 'B', 'account-a'));
    expect(screen.getByTestId('felt-B')).toBeTruthy();
  });

  it('moves the seated source rather than an earlier observer of the same event', async () => {
    mount();
    await waitFor(() => expect(state.reads).toHaveLength(1));
    await settle(state.reads[0], ['B']);
    expect(screen.getByTestId('felt-A')).toBeTruthy();
    state.metadataResults.push({
      data: ['A', 'B', 'C'].map((id) => ({
        id,
        name: id,
        tournament_id: 'event',
        small_blind: 1,
        big_blind: 2,
      })),
      error: null,
    });
    await act(async () => state.inserts[0]({ new: { table_id: 'C', left_at: null } }));
    await waitFor(() => expect(state.moveSession).toHaveBeenCalledWith('B', 'C', 'account-a'));
    expect(state.moveSession).not.toHaveBeenCalledWith('A', 'C', 'account-a');
  });

  it('closes the final stale seated tab after successful zero-seat truth', async () => {
    await seatA();
    const read = await reconnect();
    const metadataBefore = state.metadata.length;
    await settle(read, []);
    expect(screen.queryByTestId('felt-A')).toBeNull();
    // Zero live seats still need one bounded read of the removed table:
    // its durable tournament result must be delivered before unmount.
    expect(state.metadata.length).toBe(metadataBefore + 1);
    expect(state.metadata.at(-1)).toEqual(['A']);
  });
  it('publishes the durable tournament finish before pruning unmounts its felt', async () => {
    await seatA();
    const read = await reconnect();
    state.metadataResults.push({
      data: [
        {
          id: 'A',
          name: 'Nightly',
          tournament_id: 'nightly-finish',
          club_id: 'club',
          union_id: null,
          arena: { id: 'club', asset: 'chips', is_platform: false, union_id: null },
        },
      ],
      error: null,
    });
    state.finishRead.mockResolvedValue({
      tournamentId: 'nightly-finish',
      userId: 'account-a',
      entryStatus: 'eliminated',
      finishPlace: 353,
      entrants: 375,
      prize: 0,
      bountyWinnings: 0,
      knockouts: 0,
      rebuys: 1,
      addOns: 1,
      buyInAmount: 35,
    });
    await settle(read, []);
    expect(screen.queryByTestId('felt-A')).toBeNull();
    expect(state.finishRead).toHaveBeenCalledWith('nightly-finish', 'account-a');
    expect(state.reportAtUnmount.get('A')).toBe(353);
    expect(peekSessionSummary()?.tournament).toMatchObject({
      finishPlace: 353,
      rebuys: 1,
      addOns: 1,
      buyInAmount: 35,
    });
  });
  it('preserves spectator and pending-buy-in tabs when only another table had a seat', async () => {
    mount();
    await waitFor(() => expect(state.reads).toHaveLength(1));
    await settle(state.reads[0], ['B']);
    expect(screen.getByTestId('felt-A')).toBeTruthy();
    expect(screen.getByTestId('felt-B')).toBeTruthy();
    await settle(await reconnect(), []);
    expect(screen.getByTestId('felt-A')).toBeTruthy();
    expect(screen.queryByTestId('felt-B')).toBeNull();
  });

  it.each([
    { data: [], error: { message: 'Read Failed' } },
    { data: null, error: null },
    { data: [{ table_id: null }], error: null },
  ])('retains seated tabs for an unknown seat response %j', async (result) => {
    await seatA();
    const read = await reconnect();
    expect(screen.getByTestId('felt-A')).toBeTruthy();
    await act(async () => read.resolve(result));
    expect(screen.getByTestId('felt-A')).toBeTruthy();
  });

  it('retains seated tabs after a rejected seat transport', async () => {
    await seatA();
    const read = await reconnect();
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await act(async () => read.reject(new Error('Offline')));
    expect(screen.getByTestId('felt-A')).toBeTruthy();
    expect(warning).toHaveBeenCalled();
  });

  it('does not reconcile from failed metadata for a nonempty seat set', async () => {
    await seatA();
    const read = await reconnect();
    state.metadataResults.push({ data: null, error: { message: 'Metadata Unavailable' } });
    await settle(read, ['B']);
    expect(screen.getByTestId('felt-A')).toBeTruthy();
    expect(screen.queryByTestId('felt-B')).toBeNull();
  });

  it.each(['A', 'B'])(
    'supersedes a stale zero read when TABLE_SEATED confirms %s',
    async (tableId) => {
      await seatA();
      const older = await reconnect();
      const before = state.reads.length;
      await act(async () => masterBus.emit('TABLE_SEATED', { tableId, userId: 'account-a' }));
      expect(state.reads.length).toBe(before + 1);
      const current = state.reads.at(-1)!;
      await settle(older, []);
      expect(screen.getByTestId('felt-' + tableId)).toBeTruthy();
      await settle(current, tableId === 'A' ? ['A'] : ['A', 'B']);
      expect(screen.getByTestId('felt-' + tableId)).toBeTruthy();
      expect(state.reads.length).toBe(before + 1);
    }
  );

  it('ignores an older same-account read after A to B to A account changes', async () => {
    const view = await seatA();
    const olderA = await reconnect();
    state.user = { id: 'account-b' };
    view.rerender(page());
    await waitFor(() => expect(state.reads.at(-1)?.userId).toBe('account-b'));
    await settle(state.reads.at(-1)!, ['B']);
    state.user = { id: 'account-a' };
    view.rerender(page());
    await waitFor(() => expect(state.reads.at(-1)?.userId).toBe('account-a'));
    await settle(state.reads.at(-1)!, ['C']);
    await settle(olderA, []);
    expect(screen.getByTestId('felt-C')).toBeTruthy();
    expect(screen.queryByTestId('felt-B')).toBeNull();
  });

  it('refreshes same-account auth scope without accepting the previous session read', async () => {
    await seatA();
    const older = await reconnect();
    const before = state.reads.length;
    await act(async () =>
      masterBus.emit('AUTH_STATE_CHANGED', {
        userId: 'account-a',
        isAuthenticated: true,
      })
    );
    expect(state.reads.length).toBe(before + 1);
    await settle(older, []);
    expect(screen.getByTestId('felt-A')).toBeTruthy();
    await settle(state.reads.at(-1)!, ['A']);
    expect(screen.getByTestId('felt-A')).toBeTruthy();
  });

  it('takes one fresh snapshot after new live cards and turn activation during a read', async () => {
    await seatA();
    const older = await reconnect();
    const before = state.reads.length;
    await act(async () => state.reports.get('A')!({ holeCards: 'Ah,Kd', isMyTurn: true }));
    await settle(older, []);
    expect(screen.getByTestId('felt-A')).toBeTruthy();
    expect(state.reads.length).toBe(before + 1);
    await settle(state.reads.at(-1)!, ['A']);
    expect(screen.getByTestId('felt-A')).toBeTruthy();
    expect(state.reads.length).toBe(before + 1);
  });

  it('allows cleanup despite repeated equal card strings, pot and deadline updates', async () => {
    await seatA();
    await act(async () => state.reports.get('A')!({ holeCards: 'Ah,Kd', isMyTurn: true }));
    const read = await reconnect();
    const count = state.reads.length;
    for (const pot of [10, 20, 30]) {
      await act(async () =>
        state.reports.get('A')!({
          holeCards: ['Ah', 'Kd'].join(','),
          isMyTurn: true,
          pot,
          turnDeadlineMs: pot + 1000,
        })
      );
    }
    await settle(read, []);
    expect(screen.queryByTestId('felt-A')).toBeNull();
    expect(state.reads.length).toBe(count);
  });

  it('uses the slots released by four stale seats for four current seats', async () => {
    await seatA();
    await settle(await reconnect(), ['A', 'B', 'C', 'D']);
    expect(screen.getByTestId('tabs').textContent).toBe('A,B,C,D');
    await settle(await reconnect(), ['E', 'F', 'G', 'H']);
    expect(screen.getByTestId('tabs').textContent).toBe('E,F,G,H');
  });

  it('does not reopen a voluntary leave while its cashout still has an active seat row', async () => {
    await seatA();
    await act(async () => masterBus.emit('TABLE_LEFT', { tableId: 'A' }));
    expect(screen.queryByTestId('felt-A')).toBeNull();
    await settle(state.reads.at(-1)!, ['A']);
    expect(screen.queryByTestId('felt-A')).toBeNull();
    await settle(await reconnect(), ['A']);
    expect(screen.queryByTestId('felt-A')).toBeNull();
    await act(async () => masterBus.emit('TABLE_SEATED', { tableId: 'A', userId: 'account-a' }));
    await settle(state.reads.at(-1)!, ['A']);
    expect(screen.getByTestId('felt-A')).toBeTruthy();
  });

  it('preserves deliberate lobby and hub pages when the last seat closes', async () => {
    await seatA();
    await act(async () => masterBus.emit('OPEN_LOBBY_TAB', {}));
    await act(async () =>
      masterBus.emit('OPEN_HUB_TAB', { path: '/hub/social', requestedBy: 'account-a' })
    );
    const ids = screen.getAllByTestId('tabs')[0].textContent!;
    expect(ids).toContain('lobby:');
    expect(ids).toContain('hub:');
    await settle(await reconnect(), []);
    const surviving = screen.getAllByTestId('tabs')[0].textContent!;
    expect(surviving).toContain('lobby:');
    expect(surviving).toContain('hub:');
    expect(screen.queryByTestId('felt-A')).toBeNull();
  });

  it('does not run an old deferred focus restore after a newer read begins', async () => {
    await seatA();
    await settle(await reconnect(), ['A', 'B', 'C']);
    await act(async () => screen.getByTestId('tab-B').click());
    const pending = await reconnect();
    sessionStorage.setItem('ca_last_active_table', 'C');
    await act(async () => new Promise((resolve) => setTimeout(resolve, 300)));
    expect(screen.getByTestId('tabs').getAttribute('data-active')).toBe('B');
    await settle(pending, ['A', 'B', 'C']);
  });
  it.each(['account-b', null])(
    'holds reads when auth event %s precedes the user-store render',
    async (nextUser) => {
      const view = await seatA();
      const older = await reconnect();
      const before = state.reads.length;
      await act(async () =>
        masterBus.emit('AUTH_STATE_CHANGED', {
          userId: nextUser,
          isAuthenticated: nextUser !== null,
        })
      );
      expect(state.reads.length).toBe(before);
      await act(async () => {
        masterBus.emit('TABLE_SEATED', { tableId: 'OLD', userId: 'account-a' });
        masterBus.emit('TABLE_LEFT', { tableId: 'A' });
      });
      expect(state.reads.length).toBe(before);
      expect(screen.queryByTestId('felt-OLD')).toBeNull();
      expect(screen.getByTestId('felt-A')).toBeTruthy();
      await settle(older, []);
      expect(screen.getByTestId('felt-A')).toBeTruthy();
      state.user = { id: 'account-b' };
      view.rerender(page());
      await waitFor(() => expect(state.reads.at(-1)?.userId).toBe('account-b'));
      await settle(state.reads.at(-1)!, ['B']);
      expect(screen.getByTestId('felt-B')).toBeTruthy();
      expect(screen.queryByTestId('felt-A')).toBeNull();
    }
  );

  it.each(['auth', 'membership'])(
    'discards metadata that finishes after %s changes',
    async (change) => {
      await seatA();
      const older = await reconnect();
      let finishMetadata!: (value: QueryResult) => void;
      state.metadataResults.push(
        new Promise<QueryResult>((resolve) => {
          finishMetadata = resolve;
        })
      );
      await settle(older, ['B']);
      expect(finishMetadata).toBeTypeOf('function');
      await act(async () => {
        if (change === 'auth')
          masterBus.emit('AUTH_STATE_CHANGED', {
            userId: 'account-a',
            isAuthenticated: true,
          });
        else masterBus.emit('TABLE_SEATED', { tableId: 'A', userId: 'account-a' });
      });
      const current = state.reads.at(-1)!;
      await settle(current, ['A']);
      await act(async () =>
        finishMetadata({
          data: [
            {
              id: 'B',
              name: 'Old Metadata',
              game_type: 'cash',
              tournament_id: null,
            },
          ],
          error: null,
        })
      );
      expect(screen.getByTestId('felt-A')).toBeTruthy();
      expect(screen.queryByTestId('felt-B')).toBeNull();
    }
  );

  it('reports the committed zero-seat closure exactly once under StrictMode', async () => {
    render(<React.StrictMode>{page()}</React.StrictMode>);
    await waitFor(() => expect(state.reads.length).toBe(2));
    for (const read of [...state.reads]) await settle(read, ['A']);
    state.toast.info.mockClear();
    await settle(await reconnect(), []);
    expect(screen.queryByTestId('felt-A')).toBeNull();
    expect(state.toast.info).toHaveBeenCalledTimes(1);
    expect(state.toast.info).toHaveBeenCalledWith(
      'Closed A Table You Are No Longer Seated At.',
      6000
    );
  });
});

const LIGHTNING_ANCHOR = '33333333-3333-4333-8333-333333333333';
const LIGHTNING_ROOM = '11111111-1111-4111-8111-111111111111';
const LIGHTNING_CLUSTER = '22222222-2222-4222-8222-222222222222';
function lightningMetadata() {
  state.metadataResults.push({
    data: [
      {
        id: LIGHTNING_ANCHOR,
        cluster_id: LIGHTNING_CLUSTER,
        name: 'Lightning NLH',
        small_blind: 1,
        big_blind: 2,
        max_players: 6,
        tournament_id: null,
      },
    ],
    error: null,
  });
}
function lightningAnswer() {
  return {
    data: { pool_session_id: LIGHTNING_ROOM, state: 'active', anchor_table_id: LIGHTNING_ANCHOR },
    error: null,
  };
}
it('cold lobby recovery mounts the private Lightning room and restores the return dock without a public anchor', async () => {
  lightningMetadata();
  state.lightningSession.mockResolvedValue(lightningAnswer());
  render(
    <MemoryRouter initialEntries={['/clubs']}>
      <MultiTablePage />
      <Location />
    </MemoryRouter>
  );
  await waitFor(() => expect(state.reads).toHaveLength(1));
  await settle(state.reads[0], [LIGHTNING_ANCHOR]);
  expect(screen.getByTestId('felt-' + LIGHTNING_ROOM)).toBeTruthy();
  expect(screen.queryByTestId('felt-' + LIGHTNING_ANCHOR)).toBeNull();
  expect(getLightningPoolSession(LIGHTNING_ROOM)?.clusterId).toBe(LIGHTNING_CLUSTER);
  fireEvent.click(screen.getAllByTestId('tab-' + LIGHTNING_ROOM)[0]);
  expect(screen.getByTestId('location').textContent).toBe('/table/' + LIGHTNING_ROOM);
});
it('a delayed Lightning ownership answer cannot register or mount the previous account room', async () => {
  lightningMetadata();
  let resolve!: (value: ReturnType<typeof lightningAnswer>) => void;
  state.lightningSession.mockReturnValue(
    new Promise((yes) => {
      resolve = yes;
    })
  );
  const view = mount();
  await waitFor(() => expect(state.reads).toHaveLength(1));
  await settle(state.reads[0], [LIGHTNING_ANCHOR]);
  state.user = { id: 'account-b' };
  view.rerender(page());
  await waitFor(() => expect(state.reads.at(-1)?.userId).toBe('account-b'));
  await settle(state.reads.at(-1)!, []);
  await act(async () => resolve(lightningAnswer()));
  expect(getLightningPoolSession(LIGHTNING_ROOM)).toBeNull();
  expect(screen.queryByTestId('felt-' + LIGHTNING_ROOM)).toBeNull();
});

it('a failed Lightning ownership read recovers from the original room-opened event without mounting an observer', async () => {
  lightningMetadata();
  state.lightningSession.mockResolvedValueOnce({ data: null, error: { message: 'offline' } });
  render(
    <MemoryRouter initialEntries={['/clubs']}>
      <MultiTablePage />
    </MemoryRouter>
  );
  await waitFor(() => expect(state.reads).toHaveLength(1));
  await settle(state.reads[0], [LIGHTNING_ANCHOR]);
  expect(screen.queryByTestId('felt-' + LIGHTNING_ANCHOR)).toBeNull();
  expect(screen.queryByTestId('felt-' + LIGHTNING_ROOM)).toBeNull();
  lightningMetadata();
  state.lightningSession.mockResolvedValue(lightningAnswer());
  await act(async () =>
    masterBus.emit('LIGHTNING_ROOM_OPENED', { userId: 'account-a', clusterId: LIGHTNING_CLUSTER })
  );
  await waitFor(() => expect(state.reads).toHaveLength(2));
  await settle(state.reads[1], [LIGHTNING_ANCHOR]);
  expect(screen.getByTestId('felt-' + LIGHTNING_ROOM)).toBeTruthy();
});

it('an existing seated table conversion offers its own View Game path instead of switching the tab', async () => {
  render(
    <MemoryRouter initialEntries={['/table/' + LIGHTNING_ANCHOR]}>
      <MultiTablePage />
    </MemoryRouter>
  );
  await waitFor(() => expect(state.reads).toHaveLength(1));
  await settle(state.reads[0], [LIGHTNING_ANCHOR]);
  await act(async () =>
    masterBus.emit('TABLE_SEATED', { tableId: LIGHTNING_ANCHOR, userId: 'account-a' })
  );
  for (const read of state.reads.filter((read) => !read.settled))
    await settle(read, [LIGHTNING_ANCHOR]);
  lightningMetadata();
  state.lightningSession.mockResolvedValue(lightningAnswer());
  await act(async () =>
    masterBus.emit('LIGHTNING_ROOM_OPENED', { userId: 'account-a', clusterId: LIGHTNING_CLUSTER })
  );
  await settle(state.reads.at(-1)!, [LIGHTNING_ANCHOR]);
  expect(screen.getByTestId('felt-' + LIGHTNING_ANCHOR)).toBeTruthy();
  expect(screen.queryByTestId('felt-' + LIGHTNING_ROOM)).toBeNull();
  expect(state.lightningSession).not.toHaveBeenCalled();
});
