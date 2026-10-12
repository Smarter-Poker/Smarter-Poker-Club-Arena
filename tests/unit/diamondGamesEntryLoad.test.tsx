/**
 * The entry read costs a database round trip (2026-10-01: 4,709 calls in three
 * days of test traffic). A tab return inside RETURN_FRESH_MS reads nothing new,
 * and a burst of wallet events is answered by one read, not one per event.
 */
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  EVENT_COALESCE_MS,
  RETURN_FRESH_MS,
  useDiamondGamesEntry,
} from '../../src/hooks/useDiamondGamesEntry';

const state = vi.hoisted(() => ({
  read: vi.fn(),
  listeners: new Map<string, (event: { payload: Record<string, unknown> }) => void>(),
}));
vi.mock('../../src/hooks/useAuthUser', () => ({ useAuthUser: () => ({ user: { id: 'a' } }) }));
vi.mock('../../src/services/DiamondGamesService', () => ({ default: { entry: state.read } }));
vi.mock('../../src/utils/clubIdResolver', () => ({ resolveClubUUID: async (id: string) => id }));
vi.mock('../../src/core/MasterBus', () => ({
  masterBus: {
    subscribe: (name: string, listener: (event: { payload: Record<string, unknown> }) => void) => {
      state.listeners.set(name, listener);
      return () => state.listeners.delete(name);
    },
  },
}));

const settle = (ms: number) => act(async () => new Promise((r) => setTimeout(r, ms)));

afterEach(() => {
  vi.restoreAllMocks();
  state.read.mockReset();
});

describe('the entry read is not spent on news it already has', () => {
  it('a tab return just after a read is answered by that read, a later one reads', async () => {
    let now = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    state.read.mockResolvedValue({ ok: true, bust_prompt: false, member_chips: 10 });
    const { unmount } = renderHook(() => useDiamondGamesEntry('club-a'));
    await waitFor(() => expect(state.read).toHaveBeenCalledTimes(1));

    // Focus and visibilitychange fire together on a return: neither reads yet.
    now += 2_000;
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(state.read).toHaveBeenCalledTimes(1);

    // Past the window, the pair reads exactly once.
    now += RETURN_FRESH_MS;
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await waitFor(() => expect(state.read).toHaveBeenCalledTimes(2));
    await settle(EVENT_COALESCE_MS + 50);
    expect(state.read).toHaveBeenCalledTimes(2);
    unmount();
  });

  it('a burst of wallet events reads once, and a wallet event is never gated by freshness', async () => {
    state.read.mockResolvedValue({ ok: true, bust_prompt: false, member_chips: 10 });
    const { unmount } = renderHook(() => useDiamondGamesEntry('club-a'));
    await waitFor(() => expect(state.read).toHaveBeenCalledTimes(1));
    await act(async () => {
      state.listeners.get('BALANCE_UPDATED')?.({ payload: { userId: 'a', clubId: 'club-a' } });
      state.listeners.get('DIAMOND_BALANCE_CHANGED')?.({ payload: {} });
      state.listeners.get('TABLE_LEFT')?.({ payload: { userId: 'a' } });
    });
    expect(state.read).toHaveBeenCalledTimes(1);
    await settle(EVENT_COALESCE_MS + 50);
    expect(state.read).toHaveBeenCalledTimes(2);
    unmount();
  });

  it('an unmount inside the burst window reads nothing afterwards', async () => {
    state.read.mockResolvedValue({ ok: true, bust_prompt: false, member_chips: 10 });
    const { unmount } = renderHook(() => useDiamondGamesEntry('club-a'));
    await waitFor(() => expect(state.read).toHaveBeenCalledTimes(1));
    act(() => {
      state.listeners.get('DIAMOND_BALANCE_CHANGED')?.({ payload: {} });
    });
    unmount();
    await settle(EVENT_COALESCE_MS + 50);
    expect(state.read).toHaveBeenCalledTimes(1);
  });
});
