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

it('queues overflow in arrival order and plays it without requiring redelivery', () => {
  const { result } = renderHook(() => useTableAnimations('table-a', 'receiver', 2), {
    wrapper: StrictMode,
  });
  act(() => {
    for (let i = 0; i < 15; i++) result.current.receiveThrow(1, 2, 'beer');
  });
  expect(result.current.activeThrows.map((event) => event.id)).toEqual(
    Array.from({ length: 12 }, (_, i) => String(i + 1))
  );
  act(() => result.current.handleThrowComplete('1'));
  expect(result.current.activeThrows.at(-1)?.id).toBe('13');
  act(() => result.current.handleThrowComplete('1'));
  expect(result.current.activeThrows).toHaveLength(12);
  expect(result.current.activeThrows.at(-1)?.id).toBe('13');
  act(() => {
    result.current.handleThrowComplete('2');
    result.current.handleThrowComplete('3');
  });
  expect(result.current.activeThrows.slice(-3).map((event) => event.id)).toEqual([
    '13',
    '14',
    '15',
  ]);
  act(() => {
    for (const event of result.current.activeThrows) result.current.handleThrowComplete(event.id);
  });
  expect(result.current.activeThrows).toHaveLength(0);
});

it('deduplicates receipts while queued and after their queued playback completes', () => {
  const receipt = 'aa110000-0000-4000-8000-000000000001';
  const { result } = renderHook(() => useTableAnimations('table-a', 'receiver', 2));
  act(() => {
    for (let i = 0; i < 12; i++) result.current.receiveThrow(1, 2, 'beer');
    result.current.receiveThrow(1, 2, 'beer', receipt);
    result.current.receiveThrow(1, 2, 'beer', receipt.toUpperCase());
  });
  act(() => result.current.handleThrowComplete('1'));
  expect(result.current.activeThrows.filter((event) => event.id === receipt)).toHaveLength(1);
  act(() => result.current.handleThrowComplete(receipt));
  act(() => result.current.receiveThrow(1, 2, 'beer', receipt));
  expect(result.current.activeThrows).toHaveLength(11);
});

it('queues approved local throws behind receivers without losing their broadcast', async () => {
  const { result } = renderHook(() => useTableAnimations('table-a', 'sender', 1));
  act(() => {
    for (let i = 0; i < 12; i++) result.current.receiveThrow(2, 1, 'beer');
    result.current.setThrowTargetSeat(2);
  });
  await act(() => result.current.handleThrowableSelect({ id: 'beer' } as Throwable));
  expect(state.send).toHaveBeenCalledWith('table-a', 'sender', '[THROW:beer:2]', '13');
  expect(result.current.activeThrows).toHaveLength(12);
  act(() => result.current.handleThrowComplete('1'));
  expect(result.current.activeThrows.at(-1)).toMatchObject({ id: '13', fromSeat: 1, toSeat: 2 });
});

it('discards the old queue when changing tables or accounts', () => {
  const { result, rerender } = renderHook(({ table, user }) => useTableAnimations(table, user, 2), {
    initialProps: { table: 'table-a', user: 'receiver' },
  });
  for (const next of [
    { table: 'table-b', user: 'receiver' },
    { table: 'table-b', user: 'other' },
  ]) {
    act(() => {
      for (let i = 0; i < 15; i++) result.current.receiveThrow(1, 2, 'beer');
    });
    const previous = result.current.activeThrows[0].id;
    rerender(next);
    act(() => result.current.handleThrowComplete(previous));
    expect(result.current.activeThrows).toHaveLength(0);
  }
});

it('retains pending receipt identity after the completed-history window rolls over', () => {
  const receipt = 'aa110000-0000-4000-8000-000000000001';
  const { result } = renderHook(() => useTableAnimations('table-a', 'receiver', 2));
  act(() => {
    for (let i = 0; i < 12; i++) result.current.receiveThrow(1, 2, 'beer');
    result.current.receiveThrow(1, 2, 'beer', receipt);
    for (let i = 100000; i < 100513; i++) {
      result.current.receiveThrow(1, 2, 'beer', `bb110000-0000-4000-8000-000000${i}`);
    }
    result.current.receiveThrow(1, 2, 'beer', receipt.toUpperCase());
  });
  const played: string[] = [];
  while (result.current.activeThrows.length) {
    const batch = result.current.activeThrows.map((event) => event.id);
    played.push(...batch);
    act(() => batch.forEach((id) => result.current.handleThrowComplete(id)));
  }
  expect(played).toHaveLength(526);
  expect(played.filter((id) => id.toLowerCase() === receipt)).toHaveLength(1);
});
