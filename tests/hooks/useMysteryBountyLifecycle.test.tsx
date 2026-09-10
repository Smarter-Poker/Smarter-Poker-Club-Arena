import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useMysteryBounty } from '../../src/hooks/useMysteryBounty';

const transport = vi.hoisted(() => ({
  requests: [] as { id: string; resolve: (value: unknown) => void }[],
  listeners: new Map<string, ((event: unknown) => void)[]>(),
  releases: vi.fn(),
}));
vi.mock('../../src/core/MasterBus', () => ({
  masterBus: {
    // Another mounted table holds these channels after this hook releases.
    hasChannel: () => true,
    getOrCreateChannel: (key: string) => ({
      on: (_kind: string, _filter: unknown, listener: (event: unknown) => void) => {
        transport.listeners.set(key, [...(transport.listeners.get(key) || []), listener]);
      },
    }),
    removeRegisteredChannel: transport.releases,
  },
}));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: vi.fn() }));
vi.mock('../../src/services/MysteryBountyService', () => ({
  MysteryBountyService: {
    getInventory: (id: string) =>
      new Promise((resolve) => transport.requests.push({ id, resolve })),
    getAllAwards: async (id: string) => ({ total: 1, rows: [{ awardId: id }] }),
    getLeaderboard: async (id: string) => [{ userId: id }],
  },
}));

async function finish(index: number) {
  await act(async () => {
    transport.requests[index].resolve({ profile: transport.requests[index].id });
  });
}
function reveal(id: string) {
  for (const listener of transport.listeners.get('t-break-' + id) || []) {
    listener({ payload: { type: 'mystery_bounty_revealed' } });
  }
}
const ids = () => transport.requests.map((r) => r.id);

beforeEach(() => {
  vi.useFakeTimers();
  transport.requests.length = 0;
  transport.listeners.clear();
  transport.releases.mockClear();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('mystery bounty event ownership', () => {
  it('loads the new event immediately and ignores an older response arriving last', async () => {
    const { result, rerender } = renderHook(({ id }) => useMysteryBounty(id, true), {
      initialProps: { id: 'A' },
    });
    rerender({ id: 'B' });
    expect(ids()).toEqual(['A', 'B']);
    await finish(1);
    expect(result.current.inventory?.profile).toBe('B');
    await finish(0);
    expect(result.current.inventory?.profile).toBe('B');
    expect(result.current.awards[0].awardId).toBe('B');
    expect(result.current.leaderboard[0].userId).toBe('B');
    expect(ids()).toEqual(['A', 'B']);
  });

  it('clears an old event while its successor is loading', async () => {
    const { result, rerender } = renderHook(({ id }) => useMysteryBounty(id, true), {
      initialProps: { id: 'A' },
    });
    await finish(0);
    rerender({ id: 'B' });
    expect(result.current.inventory).toBeNull();
    expect(result.current.awards).toEqual([]);
    expect(result.current.leaderboard).toEqual([]);
    expect(result.current.awardsTotal).toBe(0);
    expect(result.current.isLoading).toBe(true);
  });

  it('does not restore bounty data after the feature is disabled', async () => {
    const { result, rerender } = renderHook(({ enabled }) => useMysteryBounty('A', enabled), {
      initialProps: { enabled: true },
    });
    rerender({ enabled: false });
    await finish(0);
    expect(result.current.inventory).toBeNull();
    expect(result.current.awards).toEqual([]);
    expect(result.current.pendingReveals).toBe(0);
    expect(result.current.isLoading).toBe(false);
  });

  it('cancels the outgoing reveal timer and ignores its retained shared-channel listener', async () => {
    const { result, rerender } = renderHook(({ id }) => useMysteryBounty(id, true), {
      initialProps: { id: 'A' },
    });
    await finish(0);
    act(() => reveal('A'));
    rerender({ id: 'B' });
    await finish(1);
    act(() => {
      vi.advanceTimersByTime(350);
      reveal('A');
      vi.advanceTimersByTime(350);
    });
    expect(ids()).toEqual(['A', 'B']);
    expect(result.current.pendingReveals).toBe(0);
    expect(transport.releases).toHaveBeenCalledWith('t-break-A');
  });

  it('coalesces repeated reveals into one current-event follow-up without counting money locally', async () => {
    const { result } = renderHook(() => useMysteryBounty('A', true));
    act(() => {
      reveal('A');
      reveal('A');
      vi.advanceTimersByTime(350);
    });
    expect(ids()).toEqual(['A']);
    await finish(0);
    expect(ids()).toEqual(['A', 'A']);
    await finish(1);
    expect(result.current.awardsTotal).toBe(1);
    expect(result.current.awards).toHaveLength(1);
    expect(result.current.pendingReveals).toBe(0);
  });

  it('does not restart a queued fetch after unmount', async () => {
    const { result, unmount } = renderHook(() => useMysteryBounty('A', true));
    act(() => result.current.refresh());
    unmount();
    act(() => {
      reveal('A');
      vi.advanceTimersByTime(350);
    });
    await finish(0);
    expect(ids()).toEqual(['A']);
    expect(transport.releases).toHaveBeenCalledTimes(1);
  });
});
