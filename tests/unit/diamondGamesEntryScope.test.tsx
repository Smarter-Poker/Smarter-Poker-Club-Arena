import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useDiamondGamesEntry } from '../../src/hooks/useDiamondGamesEntry';
const state = vi.hoisted(() => ({ user: { id: 'a' }, read: vi.fn() }));
vi.mock('../../src/hooks/useAuthUser', () => ({ useAuthUser: () => ({ user: state.user }) }));
vi.mock('../../src/services/DiamondGamesService', () => ({ default: { entry: state.read } }));
vi.mock('../../src/core/MasterBus', () => ({ masterBus: { subscribe: () => () => undefined } }));
describe('entry eligibility stays with its account', () => {
  it('discards a late zero-chip result after switching accounts and fails closed on unavailable state', async () => {
    let resolveOld!: (v: unknown) => void;
    state.read.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveOld = resolve;
        })
    );
    state.read.mockResolvedValueOnce({ ok: true, bust_prompt: false, member_chips: 10 });
    const { result, rerender } = renderHook(() => useDiamondGamesEntry('club-a'));
    state.user = { id: 'b' };
    rerender();
    await waitFor(() => expect(result.current.entry?.member_chips).toBe(10));
    await act(async () => resolveOld({ ok: true, bust_prompt: true, member_chips: 0 }));
    expect(result.current.entry?.bust_prompt).toBe(false);
    state.read.mockRejectedValueOnce(new Error('Unavailable'));
    await act(async () => {
      await result.current.refresh();
    });
    expect(result.current.entry).toBeNull();
  });
});
