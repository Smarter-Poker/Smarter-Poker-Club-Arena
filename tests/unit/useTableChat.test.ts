/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  UNIT TESTS — useTableChat
 * ═══════════════════════════════════════════════════════════════════════════════
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
afterEach(cleanup);

vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    from: vi.fn().mockReturnValue({
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
      insert: vi.fn().mockResolvedValue({ data: null, error: null }),
    }),
    channel: vi.fn().mockReturnValue({
      on: vi.fn().mockReturnThis(),
      subscribe: vi.fn().mockReturnValue('subscribed'),
      unsubscribe: vi.fn(),
    }),
    removeChannel: vi.fn(),
  },
}));

import { useTableChat } from '../../src/hooks/useTableChat';

describe('useTableChat', () => {
  it('should export useTableChat as a function', () => {
    expect(typeof useTableChat).toBe('function');
  });
});

it('delivers throws with receipt identity while every reaction slot is occupied', () => {
  const received = vi.fn();
  const receipt = 'AA110000-0000-4000-8000-000000000001';
  const { result } = renderHook(() =>
    useTableChat(undefined, 'receiver', [{ id: 'sender' }], received)
  );
  act(() => {
    for (let i = 0; i < 20; i++)
      result.current.parseIncomingMessage('[REACTION:smile:1]', 'sender');
  });
  expect(result.current.activeReactions).toHaveLength(20);
  act(() => {
    result.current.parseIncomingMessage('[THROW:beer:2]', 'sender', receipt);
    result.current.parseIncomingMessage('[THROW:beer:2]', 'receiver', receipt);
  });
  expect(received).toHaveBeenCalledExactlyOnceWith(1, 2, 'beer', receipt.toLowerCase());
});


it('shows the granted seconds from the actual time-bank event contract', async () => {
  const { masterBus } = await import('../../src/core/MasterBus');
  const { result } = renderHook(() => useTableChat('table-timebank', 'receiver', []));
  await act(async () => { await Promise.resolve(); });
  const listener = vi.mocked(masterBus.subscribe).mock.calls.filter(([type]) => type === 'TIME_BANK_ACTIVATED').at(-1)?.[1];
  expect(listener).toBeTypeOf('function');
  act(() => {
    listener!({ type: 'TIME_BANK_ACTIVATED', timestamp: new Date().toISOString(), payload: {
      tableId: 'table-timebank', playerId: 'player-timebank',
      secondsGranted: 20, usesRemaining: 1, totalRemaining: 20,
    } } as any);
  });
  expect(result.current.chatMessages.at(-1)?.content).toBe(
    'Player play activated Time Bank (+20s)'
  );
});
