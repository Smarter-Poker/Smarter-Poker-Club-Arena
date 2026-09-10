import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';

type QueryResult = { data: unknown; error: unknown };
type SeatRead = {
  userId: string;
  settled: boolean;
  resolve: (value: QueryResult) => void;
  reject: (error: Error) => void;
};
const state = vi.hoisted(() => ({
  user: { id: 'account-a' } as { id: string } | null,
  listeners: new Map<string, Set<(event: { payload: unknown }) => void>>(),
  reads: [] as SeatRead[],
  metadata: [] as string[][],
  metadataResults: [] as (QueryResult | Promise<QueryResult>)[],
  reports: new Map<string, (info: Record<string, unknown>) => void>(),
  inserts: [] as ((payload: unknown) => void)[],
  toast: { info: vi.fn(), warning: vi.fn(), error: vi.fn(), success: vi.fn() },
}));

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
    rpc: vi.fn(async () => ({ data: [], error: null })),
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
          on(_kind: string, _filter: unknown, callback: (payload: unknown) => void) {
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
vi.mock('../../src/services/SessionStatsService', () => ({
  sessionStatsService: { getStats: () => null },
}));
vi.mock('../../src/services/GameServerAPI', () => ({
  setSitOut: vi.fn(),
  submitAction: vi.fn(),
}));
vi.mock('../../src/utils/clubQuickLink', () => ({ resolveLobbyClubId: async () => null }));
vi.mock('../../src/utils/lazyWithRetry', () => ({
  lazyWithRetry: (loader: () => Promise<unknown>) => {
    if (!String(loader).includes('TablePage')) return () => <div>Lobby Page</div>;
    return function Felt({
      embeddedTableId,
      onTableInfoUpdate,
    }: {
      embeddedTableId: string;
      onTableInfoUpdate: (info: Record<string, unknown>) => void;
    }) {
      state.reports.set(embeddedTableId, onTableInfoUpdate);
      return <div data-testid={'felt-' + embeddedTableId}>Felt {embeddedTableId}</div>;
    };
  },
}));

import MultiTablePage from '../../src/pages/MultiTablePage';
import { masterBus } from '../../src/core/MasterBus';

function Location() {
  return <output data-testid="location">{useLocation().pathname}</output>;
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
  state.listeners.clear();
  state.reads.length = 0;
  state.metadata.length = 0;
  state.metadataResults.length = 0;
  state.inserts.length = 0;
  state.reports.clear();
  vi.clearAllMocks();
  localStorage.clear();
  sessionStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('Rendered MultiTable authoritative seat rebuild', () => {
  it('closes the final stale seated tab after successful zero-seat truth', async () => {
    await seatA();
    const read = await reconnect();
    const metadataBefore = state.metadata.length;
    await settle(read, []);
    expect(screen.queryByTestId('felt-A')).toBeNull();
    expect(state.metadata.length).toBe(metadataBefore);
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
