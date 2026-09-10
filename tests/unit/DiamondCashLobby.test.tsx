import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UseMasterBusChannelOptions } from '../../src/hooks/useMasterBusChannel';

const mocks = vi.hoisted(() => ({
  subscription: null as UseMasterBusChannelOptions | null,
  query: vi.fn(),
  unsubscribe: vi.fn(),
}));
vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    from: () => {
      const chain: Record<string, unknown> = {};
      for (const method of ['select', 'eq', 'is', 'in']) chain[method] = () => chain;
      chain.order = mocks.query;
      return chain;
    },
  },
}));
vi.mock('../../src/core/MasterBus', () => ({
  masterBus: { subscribeDebounced: () => mocks.unsubscribe },
}));
vi.mock('../../src/hooks/useMasterBusChannel', () => ({
  useMasterBusChannel: (options: UseMasterBusChannelOptions) => {
    mocks.subscription = options;
  },
}));
vi.mock('../../src/context/InTabLobbyContext', () => ({ useAppNavigate: () => vi.fn() }));
vi.mock('../../src/components/lobby/game-cards/ArenaGameCard', () => ({
  default: ({ data }: { data: { players: string } }) => <div>{data.players}</div>,
}));
import DiamondCashLobby from '../../src/components/arena/DiamondCashLobby';

const table = (players: number) => ({
  id: 'table-1',
  name: 'Diamond NLH',
  small_blind: 1,
  big_blind: 2,
  min_buy_in: 40,
  max_buy_in: 200,
  current_players: players,
  max_players: 6,
});
async function openLobby() {
  let view!: ReturnType<typeof render>;
  await act(async () => {
    view = render(<DiamondCashLobby arenaId="diamond-arena" />);
  });
  return view;
}
async function flushRefresh() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(100);
  });
}

describe('Diamond Cash Lobby Cross-Device Refresh', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.query.mockReset().mockResolvedValue({ data: [table(1)], error: null });
    mocks.unsubscribe.mockReset();
    mocks.subscription = null;
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('refreshes a remote table change and coalesces a burst into one authoritative read', async () => {
    await openLobby();
    expect(screen.getByText('1/6')).toBeTruthy();
    expect(mocks.subscription).toMatchObject({
      table: 'tables',
      filter: 'club_id=eq.diamond-arena',
      event: '*',
    });
    mocks.query.mockResolvedValue({ data: [table(2)], error: null });
    act(() => {
      mocks.subscription!.onPayload({ eventType: 'UPDATE' });
      mocks.subscription!.onPayload({ eventType: 'UPDATE' });
    });
    await flushRefresh();
    expect(screen.getByText('2/6')).toBeTruthy();
    expect(mocks.query).toHaveBeenCalledTimes(2);
  });

  it('reconciles missed changes after reconnection and after a hidden tab becomes visible', async () => {
    await openLobby();
    mocks.query.mockResolvedValue({ data: [table(3)], error: null });
    act(() => mocks.subscription!.onSubscriptionStatus!('SUBSCRIBED'));
    await flushRefresh();
    expect(screen.getByText('3/6')).toBeTruthy();
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    act(() => mocks.subscription!.onPayload({ eventType: 'UPDATE' }));
    await flushRefresh();
    expect(mocks.query).toHaveBeenCalledTimes(2);
    mocks.query.mockResolvedValue({ data: [table(4)], error: null });
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    await flushRefresh();
    expect(screen.getByText('4/6')).toBeTruthy();
  });

  it('cancels queued reads and ignores late channel events after unmount', async () => {
    const view = await openLobby();
    const callback = mocks.subscription!.onPayload;
    act(() => callback({ eventType: 'UPDATE' }));
    view.unmount();
    act(() => callback({ eventType: 'UPDATE' }));
    await flushRefresh();
    expect(mocks.query).toHaveBeenCalledTimes(1);
    expect(mocks.unsubscribe).toHaveBeenCalledTimes(5);
  });
});
