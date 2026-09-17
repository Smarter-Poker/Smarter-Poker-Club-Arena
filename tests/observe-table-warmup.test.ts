import { createElement, Fragment, StrictMode, type ComponentType } from 'react';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { MemoryRouter, useNavigate, type NavigateFunction } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const calls = vi.hoisted(() => ({
  emit: vi.fn(),
  warm: vi.fn(),
  tableMounted: vi.fn(),
  tableImport: vi.fn(),
  acquireWarm: vi.fn(),
}));
const auth = vi.hoisted(() => ({ user: null as { id: string } | null }));
vi.mock('../src/core/MasterBus', () => ({ masterBus: { emit: calls.emit } }));
vi.mock('../src/hooks/useAuthUser', () => ({ useAuthUser: () => ({ user: auth.user }) }));
vi.mock('../src/components/table/PortraitLock', () => ({ default: () => null }));
vi.mock('../src/components/bbj/BBJHitAnnouncer', () => ({ default: () => null }));
vi.mock('../src/utils/ChunkPreloader', () => ({ preloadRoute: vi.fn() }));
vi.mock('../src/services/TableService', () => ({
  tableService: { getSeatedPlayers: calls.warm },
}));
vi.mock('../src/lib/authToken', () => ({
  getFreshAccessToken: () => Promise.resolve('fixture-token'),
}));
vi.mock('../src/services/EngineSocketMux', () => ({
  isMuxEnabled: () => true,
  engineSocketMux: { isSubscribed: () => false, acquireWarm: calls.acquireWarm },
}));

beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  vi.doUnmock('../src/services/tableWarmup');
  calls.warm.mockResolvedValue([]);
  calls.acquireWarm.mockImplementation(() => ({ readyState: 0, close: vi.fn() }));
});
afterEach(async () => {
  cleanup();
  const warmup = await import('../src/services/tableWarmup').catch(() => null);
  warmup?.__resetTableWarmupForTests();
});

describe('observer entry preparation', () => {
  it('warms the actual table before the screen event and navigation', async () => {
    const { openTableAsObserver } = await import('../src/utils/observeTable');
    const order: string[] = [];
    calls.warm.mockImplementation(() => {
      order.push('warm');
      return Promise.resolve([]);
    });
    calls.emit.mockImplementation(() => order.push('screen'));
    const navigate = vi.fn(() => order.push('navigate'));
    expect(openTableAsObserver(navigate, { tableId: 'actual-table' })).toBe(true);
    expect(order).toEqual(['warm', 'screen', 'navigate']);
    expect(calls.warm).toHaveBeenCalledWith('actual-table');
    expect(navigate).toHaveBeenCalledWith('/table/actual-table');
  });
  it('does not warm or navigate an absent table', async () => {
    const { openTableAsObserver, requestObserveTable } = await import('../src/utils/observeTable');
    const navigate = vi.fn();
    expect(requestObserveTable({ tableId: '' })).toBe(false);
    expect(openTableAsObserver(navigate, { tableId: '' })).toBe(false);
    expect(calls.warm).not.toHaveBeenCalled();
    expect(calls.emit).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}

const TABLE = 'aaaaaaaa-1111-abcd-0123-111111111111';
const OTHER_TABLE = 'bbbbbbbb-2222-cdef-4567-222222222222';
const USER = 'cccccccc-3333-eeee-8888-333333333333';

describe('authenticated direct table entry preparation', () => {
  let tableChunk: ReturnType<typeof deferred<{ default: ComponentType }>>;
  let Layer: typeof import('../src/components/table/PersistentTableLayer').default;
  let navigate: NavigateFunction;

  function Table() {
    calls.tableMounted();
    return createElement('div', null, 'Mounted table');
  }

  function RouteControl() {
    navigate = useNavigate();
    return null;
  }

  function view(path: string, strict = false) {
    const layer = createElement(
      MemoryRouter,
      { initialEntries: [path] },
      createElement(Fragment, null, createElement(RouteControl), createElement(Layer))
    );
    return strict ? createElement(StrictMode, null, layer) : layer;
  }

  async function finishImports() {
    await act(async () => {
      tableChunk.resolve({ default: Table });
      await vi.dynamicImportSettled();
    });
  }

  beforeEach(async () => {
    auth.user = { id: USER };
    tableChunk = deferred();
    vi.doMock('../src/pages/MultiTablePage', () => {
      calls.tableImport();
      return tableChunk.promise;
    });
    Layer = (await import('../src/components/table/PersistentTableLayer')).default;
  });

  afterEach(async () => {
    cleanup();
    // Complete held imports after unmount so no pending module leaks to another case.
    await finishImports();
  });

  it('requests warmup before the lazy table chunk can mount', async () => {
    const entry = render(view(`/table/${TABLE}`));
    await waitFor(() => expect(calls.tableImport).toHaveBeenCalledOnce());
    await waitFor(() => expect(calls.warm).toHaveBeenCalledWith(TABLE));
    await waitFor(() => expect(calls.acquireWarm).toHaveBeenCalledOnce());
    expect(calls.acquireWarm.mock.calls[0][1]).toBe(TABLE);
    expect(calls.tableMounted).not.toHaveBeenCalled();

    // Rerenders and route query changes do not duplicate this intent.
    entry.rerender(view(`/table/${TABLE}`));
    await act(async () => navigate(`/table/${TABLE}?view=watch`));
    expect(calls.warm).toHaveBeenCalledTimes(1);
    await act(async () => {
      tableChunk.resolve({ default: Table });
      await vi.dynamicImportSettled();
    });
    expect(calls.tableMounted).toHaveBeenCalled();
  });

  it.each([
    '/',
    '/clubs/example',
    '/table',
    '/table/demo',
    `/table/${TABLE}x`,
    `/table/${TABLE}/extra`,
  ])('does not prepare an invalid or non-table route: %s', async (path) => {
    render(view(path));
    await finishImports();
    expect(calls.warm).not.toHaveBeenCalled();
    expect(calls.acquireWarm).not.toHaveBeenCalled();
  });

  it('waits for authentication before preparing a direct route', async () => {
    auth.user = null;
    const entry = render(view(`/table/${TABLE}`));
    await finishImports();
    expect(calls.warm).not.toHaveBeenCalled();
    expect(calls.tableImport).not.toHaveBeenCalled();

    auth.user = { id: USER };
    entry.rerender(view(`/table/${TABLE}`));
    await waitFor(() => expect(calls.warm).toHaveBeenCalledWith(TABLE));
  });

  it('warms only the current route after a delayed module load', async () => {
    render(view(`/table/${TABLE}`));
    // Native import callbacks are still pending; change context before they run.
    expect(calls.warm).not.toHaveBeenCalled();
    act(() => navigate(`/table/${OTHER_TABLE}`));
    await finishImports();
    await waitFor(() => expect(calls.warm).toHaveBeenCalledOnce());
    expect(calls.warm).toHaveBeenCalledWith(OTHER_TABLE);
  });

  it('does not warm a route left before its module loads', async () => {
    render(view(`/table/${TABLE}`));
    expect(calls.warm).not.toHaveBeenCalled();
    act(() => navigate('/'));
    await finishImports();
    expect(calls.warm).not.toHaveBeenCalled();
  });

  it('does not warm after logout before the module loads', async () => {
    const entry = render(view(`/table/${TABLE}`));
    expect(calls.warm).not.toHaveBeenCalled();
    auth.user = null;
    entry.rerender(view(`/table/${TABLE}`));
    await finishImports();
    expect(calls.warm).not.toHaveBeenCalled();
  });

  it('discards the old account callback when identity changes on the same route', async () => {
    const warmup = await import('../src/services/tableWarmup');
    const warmIntent = vi.spyOn(warmup, 'warmTable');
    const entry = render(view(`/table/${TABLE}`));
    expect(calls.warm).not.toHaveBeenCalled();
    auth.user = { id: 'dddddddd-4444-ffff-9999-444444444444' };
    entry.rerender(view(`/table/${TABLE}`));
    await finishImports();
    await waitFor(() => expect(calls.warm).toHaveBeenCalledTimes(1));
    expect(warmIntent).toHaveBeenCalledTimes(1);
    expect(calls.warm).toHaveBeenCalledWith(TABLE);
  });

  it('does not warm after unmount before the module loads', async () => {
    const entry = render(view(`/table/${TABLE}`));
    expect(calls.warm).not.toHaveBeenCalled();
    entry.unmount();
    await finishImports();
    expect(calls.warm).not.toHaveBeenCalled();
  });

  it('keeps StrictMode replay bounded to the active effect', async () => {
    const warmup = await import('../src/services/tableWarmup');
    const warmIntent = vi.spyOn(warmup, 'warmTable');
    render(view(`/table/${TABLE.toUpperCase()}`, true));
    await waitFor(() => expect(calls.warm).toHaveBeenCalledOnce());
    expect(warmIntent).toHaveBeenCalledTimes(1);
    expect(calls.warm).toHaveBeenCalledWith(TABLE.toUpperCase());
  });

  it('leaves table rendering available if speculative loading fails', async () => {
    const failedImport = vi.fn();
    vi.doMock('../src/services/tableWarmup', () => {
      failedImport();
      throw new Error('warmup chunk unavailable');
    });
    render(view(`/table/${TABLE}`));
    await finishImports();
    expect(failedImport).toHaveBeenCalledOnce();
    expect(calls.warm).not.toHaveBeenCalled();
    expect(calls.tableMounted).toHaveBeenCalled();
  });
});
