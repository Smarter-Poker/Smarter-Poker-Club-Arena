import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/* Dan 2026-10-24: "NO PART OF THE LIGHTNING GAMES OR FUNCTIONALITY SHOULD BE
   TOUCHING THE CLASSIC GAMES." A table page asks whether its game is
   Lightning before it knows. A Classic game answers once and is never asked
   again; a Lightning game keeps its 30 s refresh; a failed read is retried. */

const rpc = vi.fn();
vi.mock('../../src/lib/supabase', () => ({ supabase: { rpc: (...a: unknown[]) => rpc(...a) } }));
vi.mock('../../src/lightning/lightningSessionApi', () => ({
  fetchLightningPoolHealth: vi.fn(async () => null),
}));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: vi.fn() }));

import {
  LIGHTNING_LOBBY_REFRESH_MS,
  useLightningLobbyStates,
} from '../../src/lightning/lightningLobbyFeed';

const classicAnswer = { data: { lightning: null }, error: null };
const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

describe('the table page asks a Classic game about Lightning once', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    rpc.mockReset();
  });
  afterEach(() => vi.useRealTimers());

  it('a Classic game is asked once and never polled again', async () => {
    rpc.mockResolvedValue(classicAnswer);
    const ids = ['classic-game'];
    const { result } = renderHook(() => useLightningLobbyStates(ids, { settleClassic: true }));
    await act(flush);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(result.current['classic-game']).toBeNull();
    for (let i = 0; i < 4; i++) {
      await act(async () => {
        vi.advanceTimersByTime(LIGHTNING_LOBBY_REFRESH_MS);
        await flush();
      });
    }
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it('a failed read is not an answer, so it is asked again', async () => {
    rpc.mockResolvedValueOnce({ data: null, error: new Error('down') });
    rpc.mockResolvedValue(classicAnswer);
    const ids = ['classic-game'];
    renderHook(() => useLightningLobbyStates(ids, { settleClassic: true }));
    await act(flush);
    expect(rpc).toHaveBeenCalledTimes(1);
    await act(async () => {
      vi.advanceTimersByTime(LIGHTNING_LOBBY_REFRESH_MS);
      await flush();
    });
    expect(rpc).toHaveBeenCalledTimes(2);
    await act(async () => {
      vi.advanceTimersByTime(LIGHTNING_LOBBY_REFRESH_MS * 3);
      await flush();
    });
    expect(rpc).toHaveBeenCalledTimes(2);
  });

  it('without the option (the club lobby board) the refresh is unchanged', async () => {
    rpc.mockResolvedValue(classicAnswer);
    const ids = ['any-game'];
    renderHook(() => useLightningLobbyStates(ids));
    await act(flush);
    await act(async () => {
      vi.advanceTimersByTime(LIGHTNING_LOBBY_REFRESH_MS * 2);
      await flush();
    });
    expect(rpc).toHaveBeenCalledTimes(3);
  });
});
