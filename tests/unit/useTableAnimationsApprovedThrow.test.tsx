import { act, cleanup, renderHook } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { useTableAnimations } from '../../src/hooks/useTableAnimations';
import type { Throwable } from '../../src/services/ThrowableService';
const state = vi.hoisted(() => ({ send: vi.fn(), id: 0 }));
vi.mock('../../src/services/RoomService', () => ({ roomService: { sendChat: state.send } }));
vi.mock('../../src/components/table/ThrowableImage', () => ({ preloadThrowableImages: vi.fn() }));
vi.mock('../../src/services/ThrowableService', () => ({
  throwableService: {
    createThrowEvent: (
      fromSeat: number,
      toSeat: number,
      throwableId: string,
      eventId?: string
    ) => ({
      id: eventId ?? String(++state.id),
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
  state.id = 0;
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
    ['table-a', 'user-a', '[THROW:beer:2]', '1'],
    ['table-a', 'user-a', '[THROW:beer:3]', '2'],
  ]);
});

it('carries the approved receipt identity to the local event and the receiving player', async () => {
  const receipt = 'aa110000-0000-4000-8000-000000000001';
  const sender = renderHook(() => useTableAnimations('table-a', 'sender', 1));
  const receiver = renderHook(() => useTableAnimations('table-a', 'receiver', 2));
  act(() => sender.result.current.setThrowTargetSeat(2));
  await act(() =>
    sender.result.current.handleThrowableSelect({ id: 'magic_8_ball' } as Throwable, receipt)
  );
  expect(state.send).toHaveBeenCalledWith('table-a', 'sender', '[THROW:magic_8_ball:2]', receipt);
  act(() => receiver.result.current.receiveThrow(1, 2, 'magic_8_ball', receipt));
  expect(sender.result.current.activeThrows[0].id).toBe(receipt);
  expect(receiver.result.current.activeThrows[0].id).toBe(receipt);
});

it('plays a delivered receipt once, including replays after completion and UUID case changes', () => {
  const receipt = 'aa110000-0000-4000-8000-000000000001';
  const { result } = renderHook(() => useTableAnimations('table-a', 'receiver', 2), {
    wrapper: StrictMode,
  });
  act(() => {
    result.current.receiveThrow(1, 2, 'beer', receipt);
    result.current.receiveThrow(1, 2, 'beer', receipt.toUpperCase());
  });
  expect(result.current.activeThrows).toHaveLength(1);
  act(() => result.current.handleThrowComplete(receipt));
  act(() => result.current.receiveThrow(1, 2, 'beer', receipt));
  expect(result.current.activeThrows).toHaveLength(0);
});

it('keeps distinct receipts and legacy throws even when their contents are identical', () => {
  const { result } = renderHook(() => useTableAnimations('table-a', 'receiver', 2));
  act(() => {
    result.current.receiveThrow(1, 2, 'beer', 'aa110000-0000-4000-8000-000000000001');
    result.current.receiveThrow(1, 2, 'beer', 'aa110000-0000-4000-8000-000000000002');
    result.current.receiveThrow(1, 2, 'beer');
    result.current.receiveThrow(1, 2, 'beer');
  });
  expect(result.current.activeThrows).toHaveLength(4);
});

it('clears the prior table and account playback scope', () => {
  const receipt = 'aa110000-0000-4000-8000-000000000001';
  const { result, rerender } = renderHook(({ table, user }) => useTableAnimations(table, user, 2), {
    initialProps: { table: 'table-a', user: 'receiver' },
  });
  act(() => {
    result.current.receiveThrow(1, 2, 'beer', receipt);
    result.current.setThrowTargetSeat(3);
    result.current.setShowThrowableSelector(true);
  });
  rerender({ table: 'table-b', user: 'receiver' });
  expect(result.current.activeThrows).toHaveLength(0);
  expect(result.current.throwTargetSeat).toBeNull();
  expect(result.current.showThrowableSelector).toBe(false);
  act(() => result.current.receiveThrow(1, 2, 'beer', receipt));
  expect(result.current.activeThrows).toHaveLength(1);
  rerender({ table: 'table-b', user: 'other-account' });
  expect(result.current.activeThrows).toHaveLength(0);
});

it('does not mark a capacity-rejected receipt as already played', () => {
  const receipt = 'aa110000-0000-4000-8000-000000000001';
  const { result } = renderHook(() => useTableAnimations('table-a', 'receiver', 2));
  act(() => {
    for (let i = 0; i < 12; i++) result.current.receiveThrow(1, 2, 'beer');
  });
  act(() => result.current.receiveThrow(1, 2, 'beer', receipt));
  expect(result.current.activeThrows).toHaveLength(12);
  act(() => result.current.handleThrowComplete(result.current.activeThrows[0].id));
  act(() => result.current.receiveThrow(1, 2, 'beer', receipt));
  expect(result.current.activeThrows.some((event) => event.id === receipt)).toBe(true);
});
