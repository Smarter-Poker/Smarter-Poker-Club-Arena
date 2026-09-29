/**
 * The Diamonds-to-Chips door reads the club the server knows (2026-09-21).
 *
 * Production logs: fn_diamond_games_entry answered 400 (22P02, invalid input
 * syntax for type uuid: "shark-club") on every read from a route that carries
 * the club's slug, so the Diamonds-to-Chips button and the bust prompt never
 * learned the player's balance there.
 */
import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useDiamondGamesEntry } from '../../src/hooks/useDiamondGamesEntry';

const SHARK = 'a41434bb-8d0c-400a-8f0d-e8b3d65afed4';
const state = vi.hoisted(() => ({
  read: vi.fn(),
  resolve: vi.fn(),
  listeners: new Map<string, (event: { payload: Record<string, unknown> }) => void>(),
}));
vi.mock('../../src/hooks/useAuthUser', () => ({
  useAuthUser: () => ({ user: { id: 'player-a' } }),
}));
vi.mock('../../src/services/DiamondGamesService', () => ({ default: { entry: state.read } }));
vi.mock('../../src/utils/clubIdResolver', () => ({ resolveClubUUID: state.resolve }));
vi.mock('../../src/core/MasterBus', () => ({
  masterBus: {
    subscribe: (name: string, listener: (event: { payload: Record<string, unknown> }) => void) => {
      state.listeners.set(name, listener);
      return () => state.listeners.delete(name);
    },
  },
}));

describe('the entry is read for the club the server knows', () => {
  it('sends the UUID for a slug route and follows balance events for that club', async () => {
    state.resolve.mockImplementation(async (id: string) => (id === 'shark-club' ? SHARK : id));
    state.read.mockResolvedValue({ ok: true, bust_prompt: false, member_chips: 12 });
    const { result } = renderHook(() => useDiamondGamesEntry('shark-club'));
    await waitFor(() => expect(result.current.entry?.member_chips).toBe(12));
    expect(state.read).toHaveBeenCalledTimes(1);
    expect(state.read).toHaveBeenCalledWith(SHARK);
    // Wallet events carry the UUID; they are this club's events.
    await act(async () => {
      state.listeners.get('BALANCE_UPDATED')?.({ payload: { userId: 'player-a', clubId: SHARK } });
    });
    await waitFor(() => expect(state.read).toHaveBeenCalledTimes(2));
    await act(async () => {
      state.listeners.get('BALANCE_UPDATED')?.({
        payload: { userId: 'player-a', clubId: '00000000-0000-0000-0000-00000000beef' },
      });
    });
    expect(state.read).toHaveBeenCalledTimes(2);
  });

  it('never calls the server with a slug when the club cannot be resolved', async () => {
    state.read.mockReset();
    state.resolve.mockRejectedValue(new Error('Club Not Found'));
    const { result } = renderHook(() => useDiamondGamesEntry('no-such-club'));
    await waitFor(() => expect(state.resolve).toHaveBeenCalled());
    expect(state.read).not.toHaveBeenCalled();
    // Unknown is never "bust".
    expect(result.current.entry).toBeNull();
  });
});
