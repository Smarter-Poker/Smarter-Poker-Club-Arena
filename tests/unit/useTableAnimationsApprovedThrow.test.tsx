import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useTableAnimations } from '../../src/hooks/useTableAnimations';
import type { Throwable } from '../../src/services/ThrowableService';
const state = vi.hoisted(() => ({ send: vi.fn(), id: 0 }));
vi.mock('../../src/services/RoomService', () => ({ roomService: { sendChat: state.send } }));
vi.mock('../../src/components/table/ThrowableImage', () => ({ preloadThrowableImages: vi.fn() }));
vi.mock('../../src/services/ThrowableService', () => ({
  throwableService: {
    createThrowEvent: (fromSeat: number, toSeat: number, throwableId: string) => ({
      id: String(++state.id),
      fromSeat,
      toSeat,
      throwableId,
    }),
  },
}));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  state.send.mockClear();
});
it('plays both server-approved throws even when responses arrive less than 1500 ms apart', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(10000);
  const { result } = renderHook(() => useTableAnimations('table-a', 'user-a', 1));
  const item = { id: 'beer' } as Throwable;
  act(() => result.current.setThrowTargetSeat(2));
  await act(() => result.current.handleThrowableSelect(item));
  act(() => result.current.setThrowTargetSeat(3));
  await act(() => result.current.handleThrowableSelect(item));
  expect(result.current.activeThrows.map((t) => t.toSeat)).toEqual([2, 3]);
  expect(state.send.mock.calls).toEqual([
    ['table-a', 'user-a', '[THROW:beer:2]'],
    ['table-a', 'user-a', '[THROW:beer:3]'],
  ]);
});
