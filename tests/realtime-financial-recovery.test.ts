import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';

const mocks = vi.hoisted(() => ({
  user: { id: 'player-a' } as { id: string } | null,
  emit: vi.fn(),
}));
vi.mock('../src/core/MasterBus', () => ({ masterBus: { emit: mocks.emit } }));
vi.mock('../src/hooks/useAuthUser', () => ({ useAuthUser: () => ({ user: mocks.user }) }));
vi.mock('../src/utils/lazyWithRetry', () => ({ hardReload: vi.fn(async () => {}) }));
vi.mock('../src/lib/sessionRevoked', () => ({
  handleEngineAuthRejection: vi.fn(async () => 'unknown'),
}));
vi.mock('../src/services/clientConnectionBeacon', () => ({ reportConnectionEvent: vi.fn() }));
vi.mock('../src/services/EngineStateClient', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/services/EngineStateClient')>();
  return {
    ...real,
    engineChannelClient: new real.EngineChannelClient({
      baseUrl: 'https://engine.example',
      getToken: async () => 'token',
    }),
  };
});
import { engineChannelClient } from '../src/services/EngineStateClient';
import { useRealtimeFinancials } from '../src/hooks/useRealtimeFinancials';

class Socket {
  static instances: Socket[] = [];
  static CONNECTING = 0;
  static OPEN = 1;
  readyState = 0;
  onopen: (() => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(..._args: unknown[]) {
    Socket.instances.push(this);
  }
  send(_data: string) {}
  close(code = 1000, reason = '') {
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  frame(message: unknown) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
}
const latest = () => Socket.instances[Socket.instances.length - 1];
const refreshes = () => mocks.emit.mock.calls.filter(([event]) => event === 'BALANCE_UPDATED');
async function mountConnected() {
  const hook = renderHook(() => useRealtimeFinancials());
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  act(() => latest().open());
  return hook;
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  vi.stubGlobal('WebSocket', Socket);
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  Socket.instances = [];
  mocks.user = { id: 'player-a' };
});
afterEach(() => {
  cleanup();
  engineChannelClient.disconnect();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('financial snapshots across real channel recovery', () => {
  it('refreshes after the first open to cover changes since the initial page read', async () => {
    await mountConnected();
    expect(refreshes()).toHaveLength(1);
    act(() => latest().frame({ type: 'CHANNEL_PONG' }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(refreshes()).toHaveLength(1);
  });
  it.each(['online', 'pageshow', 'visibilitychange'])(
    'refreshes when %s reopens a closed socket',
    async (event) => {
      await mountConnected();
      mocks.emit.mockClear();
      act(() => latest().close(1006, 'network lost'));
      await act(async () => {
        (event === 'visibilitychange' ? document : window).dispatchEvent(new Event(event));
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(Socket.instances).toHaveLength(2);
      act(() => latest().open());
      expect(refreshes()).toHaveLength(1);
    }
  );
  it('still refreshes after a scheduled reconnect', async () => {
    await mountConnected();
    mocks.emit.mockClear();
    act(() => latest().close(1006, 'network lost'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });
    expect(Socket.instances).toHaveLength(2);
    act(() => latest().open());
    expect(refreshes()).toHaveLength(1);
  });
  it.each(['unmount', 'signout'])('removes refresh and financial listeners on %s', async (exit) => {
    const hook = await mountConnected();
    if (exit === 'unmount') hook.unmount();
    else {
      mocks.user = null;
      hook.rerender();
    }
    mocks.emit.mockClear();
    act(() => latest().close(1006, 'network lost'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });
    act(() => {
      latest().open();
      latest().frame({
        type: 'FINANCIAL_UPDATE',
        userId: 'player-a',
        walletType: 'PLAYER',
        available: 12,
        total: 12,
      });
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(mocks.emit).not.toHaveBeenCalled();
  });
  it('keeps live financial events scoped to the current user', async () => {
    await mountConnected();
    mocks.emit.mockClear();
    act(() =>
      latest().frame({
        type: 'FINANCIAL_UPDATE',
        userId: 'player-b',
        walletType: 'PLAYER',
        available: 99,
        total: 99,
      })
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(mocks.emit).not.toHaveBeenCalled();
    act(() =>
      latest().frame({
        type: 'FINANCIAL_UPDATE',
        userId: 'player-a',
        walletType: 'PLAYER',
        available: 12,
        total: 12,
        ledgerEntry: { direction: 'out' },
      })
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(refreshes()).toHaveLength(1);
    expect(mocks.emit).toHaveBeenCalledWith('WALLET_REFRESHED', {
      walletType: 'PLAYER',
      available: 12,
      total: 12,
    });
    expect(mocks.emit).toHaveBeenCalledWith('TRANSACTION_LOGGED', {
      entry: { direction: 'out' },
      direction: 'out',
    });
  });
});
