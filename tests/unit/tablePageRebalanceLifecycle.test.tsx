import React, { StrictMode, Suspense, startTransition, useLayoutEffect } from 'react';
import { act, cleanup, render, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TournamentRebalanceOptions } from '../../src/hooks/useTournamentRebalance';

import { useTournamentRebalance } from '../../src/hooks/useTournamentRebalance';

const transport = vi.hoisted(() => ({
  removed: vi.fn(),
  channels: [] as { bindings: (() => Promise<void> | void)[] }[],
}));
vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    channel: () => {
      const channel = { bindings: [] as (() => Promise<void> | void)[] };
      transport.channels.push(channel);
      return channel;
    },
    removeChannel: transport.removed,
  },
}));
vi.mock('../../src/services/RealtimeChannelService', () => ({ realtimeChannelService: {} }));
vi.mock('../../src/stores/useArenaStore', () => ({ useArenaStore: { getState: () => ({}) } }));
vi.mock('../../src/stores/useClubStore', () => ({ useClubStore: { getState: () => ({}) } }));
vi.mock('../../src/stores/useTableStore', () => ({ useTableStore: { getState: () => ({}) } }));
vi.mock('../../src/stores/useUnionStore', () => ({ useUnionStore: { getState: () => ({}) } }));
vi.mock('../../src/stores/useWalletStore', () => ({ useWalletStore: { getState: () => ({}) } }));
vi.mock('../../src/stores/useSettingsStore', () => ({
  useSettingsStore: { getState: () => ({}) },
}));
vi.mock('../../src/stores/useUserStore', () => ({ useUserStore: { getState: () => ({}) } }));
vi.unmock('../../src/core/MasterBus');
import { masterBus } from '../../src/core/MasterBus';

type Result = { data: { table_id?: string | null } | null; error: unknown };
function deferred() {
  let resolve!: (result: Result) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<Result>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function fixture(overrides: Partial<TournamentRebalanceOptions> = {}) {
  const reads: ReturnType<typeof deferred>[] = [];
  const auth = new Set<(value: { isAuthenticated: boolean; userId?: string | null }) => void>();
  const options: TournamentRebalanceOptions = {
    tableId: 'source',
    userId: 'account-a',
    routeTableId: 'source',
    subscribeAuth: (listener) => {
      auth.add(listener);
      return () => {
        auth.delete(listener);
      };
    },
    readRoster: vi.fn(() => {
      const read = deferred();
      reads.push(read);
      return read.promise;
    }),
    onTableInfoUpdate: vi.fn(),
    navigate: vi.fn(),
    refresh: vi.fn(),
    report: vi.fn(),
    ...overrides,
  };
  const view = renderHook((props: TournamentRebalanceOptions) => useTournamentRebalance(props), {
    initialProps: options,
  });
  const run = (guard = () => true) => {
    let pending!: Promise<void>;
    act(() => {
      pending = view.result.current('event', guard);
    });
    return pending;
  };
  const finish = async (
    index: number,
    table: string | null = 'destination',
    error: unknown = null
  ) => {
    await act(async () => {
      reads[index].resolve({ data: table ? { table_id: table } : null, error });
    });
  };
  const identity = (userId: string | null) =>
    act(() => {
      for (const listener of auth) listener({ isAuthenticated: userId !== null, userId });
    });
  return { options, view, reads, run, finish, identity };
}
afterEach(cleanup);

describe('actual rebalance lifecycle effect', () => {
  it.each(['source', 'another-table'])(
    'embedded %s routes through the parent only',
    async (routeTableId) => {
      const f = fixture({ embeddedTableId: 'source', routeTableId });
      const pending = f.run();
      await f.finish(0);
      await pending;
      expect(f.options.readRoster).toHaveBeenCalledWith('event', 'account-a');
      expect(f.options.onTableInfoUpdate).toHaveBeenCalledExactlyOnceWith({
        movedToTableId: 'destination',
      });
      expect(f.options.navigate).not.toHaveBeenCalled();
    }
  );
  it('standalone replaces the owned source route', async () => {
    const f = fixture();
    const pending = f.run();
    await f.finish(0);
    await pending;
    expect(f.options.navigate).toHaveBeenCalledExactlyOnceWith('/table/destination', {
      replace: true,
    });
    expect(f.options.onTableInfoUpdate).not.toHaveBeenCalled();
  });
  it('off-route standalone does not even start a read', async () => {
    const f = fixture({ routeTableId: 'other' });
    await f.run();
    expect(f.options.readRoster).not.toHaveBeenCalled();
  });
  it('same table refreshes, null does not move, current returned error refreshes and reports', async () => {
    const f = fixture();
    let p = f.run();
    await f.finish(0, 'source');
    await p;
    expect(f.options.refresh).toHaveBeenCalledTimes(1);
    p = f.run();
    await f.finish(1, null);
    await p;
    const error = new Error('roster unavailable');
    p = f.run();
    await f.finish(2, null, error);
    await p;
    expect(f.options.report).toHaveBeenCalledWith(error);
    expect(f.options.refresh).toHaveBeenCalledTimes(2);
    expect(f.options.navigate).not.toHaveBeenCalled();
  });
  it('reports a current rejected read but ignores rejection after source cleanup', async () => {
    const f = fixture();
    let alive = true;
    const first = f.run(() => alive);
    const error = new Error('current transport error');
    await act(async () => {
      f.reads[0].reject(error);
      await first;
    });
    expect(f.options.report).toHaveBeenCalledExactlyOnceWith(error);
    expect(f.options.refresh).toHaveBeenCalledOnce();
    const second = f.run(() => alive);
    alive = false;
    await act(async () => {
      f.reads[1].reject(new Error('stale transport error'));
      await second;
    });
    expect(f.options.report).toHaveBeenCalledOnce();
    expect(f.options.refresh).toHaveBeenCalledOnce();
  });
  it.each(['resolve', 'reject'])('an unmounted pending %s is inert', async (outcome) => {
    const f = fixture();
    const pending = f.run();
    f.view.unmount();
    await act(async () => {
      if (outcome === 'resolve')
        f.reads[0].resolve({ data: { table_id: 'destination' }, error: null });
      else f.reads[0].reject(new Error('late error'));
      await pending;
    });
    expect(f.options.navigate).not.toHaveBeenCalled();
    expect(f.options.refresh).not.toHaveBeenCalled();
    expect(f.options.report).not.toHaveBeenCalled();
  });
  it('retained binding starts no read after source cleanup and does not tear down the other holder', async () => {
    const f = fixture({ embeddedTableId: 'source' });
    // MasterBus leaves bindings on the shared channel until its last release.
    const key = 'test-rebalance-shared';
    const channel = masterBus.getOrCreateChannel(key);
    const second = masterBus.getOrCreateChannel(key);
    expect(second).toBe(channel);
    const wire = transport.channels.at(-1)!;
    let sourceAlive = true;
    const handler = f.view.result.current;
    wire.bindings.push(() => handler('event', () => sourceAlive));
    const other = vi.fn();
    wire.bindings.push(other);
    transport.removed.mockClear();
    sourceAlive = false;
    masterBus.removeRegisteredChannel(key);
    await act(async () => {
      await Promise.all(wire.bindings.map((fn) => fn()));
    });
    expect(f.options.readRoster).not.toHaveBeenCalled();
    expect(other).toHaveBeenCalledOnce();
    expect(transport.removed).not.toHaveBeenCalled();
    masterBus.removeRegisteredChannel(key);
    expect(transport.removed).toHaveBeenCalledExactlyOnceWith(channel);
    // The still-current hook can serve a new binding; cleanup did not kill it globally.
    const pending = f.run();
    await f.finish(0);
    await pending;
    expect(f.options.onTableInfoUpdate).toHaveBeenCalledOnce();
  });
  it.each([true, false])(
    'overlapping reads apply newest only (newest first: %s)',
    async (newestFirst) => {
      const f = fixture();
      const first = f.run();
      const second = f.run();
      if (newestFirst) {
        await f.finish(1, 'new');
        await f.finish(0, 'old');
      } else {
        await f.finish(0, 'old');
        expect(f.options.navigate).not.toHaveBeenCalled();
        await f.finish(1, 'new');
      }
      await Promise.all([first, second]);
      expect(f.options.navigate).toHaveBeenCalledExactlyOnceWith('/table/new', { replace: true });
    }
  );
  it.each(['route', 'table'])('%s change and return invalidates old read', async (change) => {
    const f = fixture();
    const pending = f.run();
    f.view.rerender({
      ...f.options,
      ...(change === 'route' ? { routeTableId: 'other' } : { tableId: 'other' }),
    });
    f.view.rerender(f.options);
    await f.finish(0);
    await pending;
    expect(f.options.navigate).not.toHaveBeenCalled();
    const next = f.run();
    await f.finish(1);
    await next;
    expect(f.options.navigate).toHaveBeenCalledOnce();
  });
  it.each(['account-b', null, 'account-a'])(
    'auth transition %s invalidates pending result',
    async (identity) => {
      const f = fixture();
      const pending = f.run();
      f.identity(identity);
      await f.finish(0);
      await pending;
      expect(f.options.navigate).not.toHaveBeenCalled();
      if (identity !== 'account-a') {
        await f.run();
        expect(f.reads).toHaveLength(1);
      } else {
        const next = f.run();
        await f.finish(1);
        await next;
        expect(f.options.navigate).toHaveBeenCalledOnce();
      }
    }
  );
  it('late initial identity cannot overwrite a newer auth event', async () => {
    const f = fixture({ userId: 'guest' });
    f.identity('account-b');
    f.view.rerender({ ...f.options, userId: 'account-a' });
    await f.run();
    expect(f.options.readRoster).not.toHaveBeenCalled();
    f.view.rerender({ ...f.options, userId: 'account-b' });
    const pending = f.run();
    await f.finish(0);
    await pending;
    expect(f.options.navigate).toHaveBeenCalledOnce();
  });
  it('uses the latest parent callback without invalidating an otherwise current read', async () => {
    const f = fixture({ embeddedTableId: 'source' });
    const pending = f.run();
    const latest = vi.fn();
    f.view.rerender({ ...f.options, onTableInfoUpdate: latest });
    await f.finish(0);
    await pending;
    expect(f.options.onTableInfoUpdate).not.toHaveBeenCalled();
    expect(latest).toHaveBeenCalledOnce();
  });
});

// Reuses independent review 0058's actual-hook Suspense/transition reproducer.
// Its commit spy distinguishes a rendered candidate from an accepted tree.
describe('committed rebalance publication', () => {
  for (const abort of [false, true]) {
    it.each(['parent', 'identity', 'route', 'table'])(
      `uncommitted %s render cannot alter a pending committed read (aborted: ${abort})`,
      async (change) => {
        const read = deferred();
        const never = new Promise<void>(() => {});
        const oldParent = vi.fn(),
          speculativeParent = vi.fn(),
          committed = vi.fn();
        const subscribeAuth = vi.fn(() => () => {});
        const readRoster = vi.fn(() => read.promise);
        let handler!: ReturnType<typeof useTournamentRebalance>;
        function Probe({ suspend = false }: { suspend?: boolean }) {
          const fn = useTournamentRebalance({
            tableId: suspend && change === 'table' ? 'speculative-table' : 'source',
            userId: suspend && change === 'identity' ? 'speculative-actor' : 'actor',
            routeTableId: suspend && change === 'route' ? 'speculative-route' : 'source',
            embeddedTableId: 'source',
            subscribeAuth,
            readRoster,
            onTableInfoUpdate: suspend ? speculativeParent : oldParent,
            navigate: vi.fn(),
            refresh: vi.fn(),
            report: vi.fn(),
          });
          useLayoutEffect(() => {
            handler = fn;
            committed(suspend);
          });
          if (suspend) throw never;
          return <div>committed source</div>;
        }
        const tree = (suspend = false) => (
          <Suspense fallback={<div>pending</div>}>
            <Probe suspend={suspend} />
          </Suspense>
        );
        const view = render(tree());
        let result!: Promise<void>;
        act(() => {
          result = handler('tournament', () => true);
        });
        await act(async () => {
          startTransition(() => view.rerender(tree(true)));
        });
        expect(committed.mock.calls).toEqual([[false]]);
        if (abort) view.rerender(tree());
        await act(async () => {
          read.resolve({ data: { table_id: 'destination' }, error: null });
          await result;
        });
        expect(speculativeParent).not.toHaveBeenCalled();
        expect(oldParent).toHaveBeenCalledExactlyOnceWith({ movedToTableId: 'destination' });
        expect(readRoster).toHaveBeenCalledExactlyOnceWith('tournament', 'actor');
      }
    );
  }

  it.each(['resolve', 'reject'])(
    'StrictMode replay fences the first setup pending %s',
    async (outcome) => {
      const reads: ReturnType<typeof deferred>[] = [];
      const pending: Promise<void>[] = [];
      const parent = vi.fn(),
        report = vi.fn(),
        refresh = vi.fn();
      const subscribeAuth = vi.fn(() => vi.fn());
      const readRoster = vi.fn(() => {
        const read = deferred();
        reads.push(read);
        return read.promise;
      });
      let current!: ReturnType<typeof useTournamentRebalance>;
      function Probe() {
        const handler = useTournamentRebalance({
          tableId: 'source',
          userId: 'actor',
          routeTableId: 'source',
          embeddedTableId: 'source',
          subscribeAuth,
          readRoster,
          onTableInfoUpdate: parent,
          navigate: vi.fn(),
          refresh,
          report,
        });
        useLayoutEffect(() => {
          current = handler;
          pending.push(handler('tournament', () => true));
        }, [handler]);
        return null;
      }
      const view = render(
        <StrictMode>
          <Probe />
        </StrictMode>
      );
      expect(reads).toHaveLength(2);
      await act(async () => {
        if (outcome === 'resolve') reads[0].resolve({ data: { table_id: 'stale' }, error: null });
        else reads[0].reject(new Error('prior setup'));
        await pending[0];
      });
      expect(parent).not.toHaveBeenCalled();
      expect(report).not.toHaveBeenCalled();
      expect(refresh).not.toHaveBeenCalled();
      await act(async () => {
        reads[1].resolve({ data: { table_id: 'current' }, error: null });
        await pending[1];
      });
      expect(parent).toHaveBeenCalledExactlyOnceWith({ movedToTableId: 'current' });
      view.unmount();
      await act(async () => {
        await current('tournament', () => true);
      });
      expect(reads).toHaveLength(2);
      expect(subscribeAuth).toHaveBeenCalledTimes(2);
      for (const result of subscribeAuth.mock.results) expect(result.value).toHaveBeenCalledOnce();
    }
  );
});
