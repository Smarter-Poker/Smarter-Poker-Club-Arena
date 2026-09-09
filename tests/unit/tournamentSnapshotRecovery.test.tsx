import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({
  user: { id: 'viewer' },
  getTournament: vi.fn(),
  reportError: vi.fn(),
  navigate: vi.fn(),
  channels: [] as any[],
  bus: new Map<string, Set<(event: any) => void>>(),
  queries: [] as any[],
}));
vi.mock('../../src/services/TournamentService', () => ({
  tournamentService: { getTournament: fixture.getTournament },
  tournamentUnregisterSuccessText: () => 'Unregistered',
}));
vi.mock('../../src/hooks/useAuthUser', () => ({ useAuthUser: () => ({ user: fixture.user }) }));
vi.mock('../../src/hooks/useTournamentRegistration', () => ({
  useTournamentRegistration: () => ({ register: vi.fn(), isRegistering: false }),
  isLateStatus: (status: string) => ['RUNNING', 'LATE_REG'].includes(status),
}));
vi.mock('../../src/context/InTabLobbyContext', () => ({ useAppNavigate: () => fixture.navigate }));
vi.mock('../../src/hooks/useMysteryBounty', () => ({ useMysteryBounty: () => ({}) }));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: fixture.reportError }));
vi.mock('../../src/components/common/Toast', () => ({
  useToast: () => ({ info: vi.fn(), success: vi.fn(), error: vi.fn() }),
}));
vi.mock('../../src/core/MasterBus', () => ({
  masterBus: {
    getOrCreateChannel: (key: string) => {
      const channel: any = {
        key,
        bindings: [],
        on: (_kind: string, filter: any, callback: any) => {
          channel.bindings.push({ filter, callback });
          return channel;
        },
        subscribe: (callback: any) => {
          channel.status = callback;
          return channel;
        },
      };
      fixture.channels.push(channel);
      return channel;
    },
    removeRegisteredChannel: vi.fn(),
    subscribeDebounced: (name: string, cb: (event: any) => void) => {
      const listeners = fixture.bus.get(name) ?? new Set();
      fixture.bus.set(name, listeners);
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  },
}));
vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    from: (table: string) => {
      const result = fixture.queries.findIndex((q) => q.table === table);
      const response =
        result >= 0 ? fixture.queries.splice(result, 1)[0].response : { data: [], error: null };
      const chain: any = { then: (yes: any, no: any) => Promise.resolve(response).then(yes, no) };
      for (const method of ['select', 'eq', 'order', 'not', 'in', 'maybeSingle'])
        chain[method] = () => chain;
      return chain;
    },
  },
}));
vi.mock('../../src/components/tournament/details/DetailOverviewTab', () => ({
  default: ({ tournament, entries, tables, isRegistered }: any) => (
    <output data-testid="snapshot">
      {JSON.stringify({
        id: tournament.id,
        name: tournament.name,
        level: tournament.current_level,
        entries: entries.map((e: any) => ({ id: e.id, chips: e.chips, table: e.table_id })),
        tables: tables.map((t: any) => t.id),
        isRegistered,
      })}
    </output>
  ),
}));
vi.mock('../../src/components/tournament/details/BlindsTab', () => ({ default: () => null }));
vi.mock('../../src/components/tournament/details/RankingTab', () => ({ default: () => null }));
vi.mock('../../src/components/tournament/details/EntriesTab', () => ({ default: () => null }));
vi.mock('../../src/components/tournament/details/UnionsTab', () => ({ default: () => null }));
vi.mock('../../src/components/tournament/details/TablesTab', () => ({ default: () => null }));
vi.mock('../../src/components/tournament/details/RewardsTab', () => ({ default: () => null }));
vi.mock('../../src/components/tournament/details/SatellitesTab', () => ({ default: () => null }));
vi.mock('../../src/components/tournament/FinalTableOverlay', () => ({
  FinalTableOverlay: () => null,
}));
vi.mock('../../src/components/tournament/MysteryBountyCelebration', () => ({
  default: () => null,
}));

import TournamentDetails from '../../src/pages/tournament/TournamentDetails';
const tournament = (id = 'a', extra: Record<string, unknown> = {}) => ({
  id,
  name: `Event ${id}`,
  status: 'RUNNING',
  starting_chips: 1000,
  buy_in_amount: 10,
  buy_in_fee: 1,
  current_level: 1,
  current_players: 1,
  blind_structure: [],
  payout_structure: [],
  ...extra,
});
const entry = (id = 'entry-a', extra: Record<string, unknown> = {}) => ({
  id,
  user_id: 'viewer',
  username: 'Player',
  status: 'playing',
  chips: 500,
  table_id: 'table-a',
  ...extra,
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const flush = async () => {
  await act(async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve();
  });
};
const snapshot = () => JSON.parse(screen.getByTestId('snapshot').textContent!);
function rows(table: string, response: any) {
  fixture.queries.push({ table, response });
}
function update(id = 'a') {
  for (const callback of fixture.bus.get('TOURNAMENT_UPDATED') ?? [])
    callback({ payload: { tournamentId: id } });
}
function Page({
  id = 'a',
  embedded = true,
  suppressAutoOpenTable = true,
}: {
  id?: string;
  embedded?: boolean;
  suppressAutoOpenTable?: boolean;
}) {
  return (
    <MemoryRouter initialEntries={[`/tournaments/${id}`]}>
      <Routes>
        <Route
          path="/tournaments/:tournamentId"
          element={
            <TournamentDetails
              tournamentIdOverride={embedded ? id : undefined}
              suppressAutoOpenTable={suppressAutoOpenTable}
            />
          }
        />
      </Routes>
    </MemoryRouter>
  );
}
beforeEach(() => {
  vi.useFakeTimers();
  fixture.user = { id: 'viewer' };
  fixture.channels.length = 0;
  fixture.bus.clear();
  fixture.queries.length = 0;
  fixture.getTournament.mockReset().mockImplementation(async (id) => tournament(id));
  fixture.reportError.mockClear();
  fixture.navigate.mockClear();
  Object.defineProperty(document, 'hidden', { configurable: true, value: false });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('Tournament details snapshot recovery', () => {
  it.each([true, false])(
    're-reads missed state on channel subscription (embedded=%s)',
    async (embedded) => {
      render(<Page embedded={embedded} />);
      await flush();
      fixture.getTournament.mockResolvedValue(tournament('a', { current_level: 7 }));
      act(() => fixture.channels[0].status('SUBSCRIBED'));
      await flush();
      expect(snapshot().level).toBe(7);
      expect(screen.queryByText('Loading Tournament...')).toBeNull();
    }
  );

  it('retains one follow-up read when refreshes arrive during a pending read', async () => {
    render(<Page />);
    await flush();
    const slow = deferred<any>();
    fixture.getTournament
      .mockReturnValueOnce(slow.promise)
      .mockResolvedValue(tournament('a', { current_level: 8 }));
    act(() => update());
    await flush();
    act(() => {
      for (let i = 0; i < 8; i++) update();
    });
    await flush();
    expect(fixture.getTournament).toHaveBeenCalledTimes(2);
    slow.resolve(tournament('a', { current_level: 2 }));
    await flush();
    expect(fixture.getTournament).toHaveBeenCalledTimes(3);
    expect(snapshot().level).toBe(8);
  });

  it('never lets a retired tournament read replace the current event', async () => {
    const view = render(<Page />);
    await flush();
    const old = deferred<any>();
    fixture.getTournament.mockReturnValueOnce(old.promise);
    act(() => update());
    await flush();
    view.rerender(<Page id="b" />);
    await flush();
    expect(snapshot().id).toBe('b');
    old.resolve(tournament('a'));
    await flush();
    expect(snapshot().id).toBe('b');
  });

  it('keeps confirmed entries and tables when their refresh is refused', async () => {
    rows('tournament_players', { data: [entry()], error: null });
    rows('tables', { data: [{ id: 'table-a', status: 'running' }], error: null });
    render(<Page />);
    await flush();
    rows('tournament_players', { data: null, error: { message: 'offline' } });
    rows('tables', { data: null, error: { message: 'offline' } });
    act(() => update());
    await flush();
    expect(snapshot().entries.map((e: any) => e.id)).toEqual(['entry-a']);
    expect(snapshot().tables).toEqual(['table-a']);
    expect(screen.getByRole('alert').textContent).toMatch(/refresh|updat/i);
  });

  it('reports an initial failed read instead of claiming an empty field', async () => {
    rows('tournament_players', { data: null, error: { message: 'offline' } });
    render(<Page />);
    await flush();
    expect(screen.queryByTestId('snapshot')).toBeNull();
    expect(screen.getByRole('alert').textContent).toMatch(/load|refresh/i);
    expect(screen.getByRole('button', { name: /try again/i })).toBeTruthy();
  });

  it('retains legitimate zero chips in a recovered snapshot', async () => {
    rows('tournament_players', {
      data: [entry('out', { chips: 0, status: 'eliminated' })],
      error: null,
    });
    render(<Page />);
    await flush();
    expect(snapshot().entries[0].chips).toBe(0);
  });

  it('ignores unrelated tournament invalidations', async () => {
    render(<Page />);
    await flush();
    act(() => update('elsewhere'));
    await flush();
    expect(fixture.getTournament).toHaveBeenCalledTimes(1);
  });

  it('clears a previous field on a scope change even if the new read fails', async () => {
    rows('tournament_players', { data: [entry()], error: null });
    const view = render(<Page />);
    await flush();
    fixture.getTournament.mockRejectedValueOnce(new Error('offline'));
    view.rerender(<Page id="b" />);
    await flush();
    expect(screen.queryByTestId('snapshot')).toBeNull();
    expect(screen.queryByText('Tournament Not Found')).toBeNull();
    expect(screen.getByRole('alert')).toBeTruthy();
  });

  it('rejects queued channel callbacks after their scope retires', async () => {
    const view = render(<Page />);
    await flush();
    const retired = fixture.channels[0];
    view.rerender(<Page id="b" />);
    await flush();
    act(() =>
      retired.bindings
        .find((b: any) => b.filter.table === 'tournaments')
        .callback({
          eventType: 'UPDATE',
          new: tournament('a', { current_level: 9 }),
        })
    );
    await flush();
    expect(snapshot().id).toBe('b');
    expect(snapshot().level).toBe(1);
  });

  it('does not erase a live entry update with an older in-flight snapshot', async () => {
    rows('tournament_players', { data: [entry()], error: null });
    render(<Page />);
    await flush();
    const old = deferred<any>();
    rows('tournament_players', old.promise);
    act(() => update());
    await flush();
    rows('tournament_players', { data: [entry('entry-a', { chips: 900 })], error: null });
    act(() =>
      fixture.channels[0].bindings
        .find((b: any) => b.filter.table === 'tournament_players')
        .callback({
          eventType: 'UPDATE',
          new: entry('entry-a', { chips: 900 }),
        })
    );
    await flush();
    old.resolve({ data: [entry()], error: null });
    await flush();
    expect(snapshot().entries[0].chips).toBe(900);
    expect(fixture.getTournament).toHaveBeenCalledTimes(2);
  });
  it('retires an old account read even when the tournament id stays the same', async () => {
    const view = render(<Page />);
    await flush();
    const old = deferred<any>();
    fixture.getTournament.mockReturnValueOnce(old.promise);
    act(() => update());
    await flush();
    fixture.user = { id: 'next-account' };
    fixture.getTournament.mockResolvedValue(tournament('a', { current_level: 6 }));
    view.rerender(<Page />);
    await flush();
    old.resolve(tournament('a', { current_level: 2 }));
    await flush();
    expect(snapshot().level).toBe(6);
    expect(snapshot().isRegistered).toBe(false);
  });

  it('retries an initial refusal and restores the actual field', async () => {
    rows('tournament_players', { data: null, error: { message: 'offline' } });
    render(<Page />);
    await flush();
    rows('tournament_players', { data: [entry()], error: null });
    fireEvent.click(screen.getByRole('button', { name: 'Try Again' }));
    await flush();
    expect(snapshot().entries[0].id).toBe('entry-a');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('opens the purchased seat after the complete snapshot resolves', async () => {
    rows('tournament_players', { data: [entry()], error: null });
    const tables = deferred<any>();
    rows('tables', tables.promise);
    render(<Page suppressAutoOpenTable={false} />);
    await flush();
    expect(fixture.navigate).not.toHaveBeenCalled();
    tables.resolve({ data: [{ id: 'table-a', status: 'running' }], error: null });
    await flush();
    expect(fixture.navigate).toHaveBeenCalledWith('/table/table-a');
  });
});
