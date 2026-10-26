/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  UNIT TESTS — useTableTournament
 * ═══════════════════════════════════════════════════════════════════════════════
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    from: vi.fn().mockReturnValue({
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
    }),
    channel: vi.fn().mockReturnValue({
      on: vi.fn().mockReturnThis(),
      subscribe: vi.fn().mockReturnValue('subscribed'),
      unsubscribe: vi.fn(),
    }),
    removeChannel: vi.fn(),
  },
}));

vi.mock('../../src/core/MasterBus', () => ({
  masterBus: { emit: vi.fn(), subscribe: vi.fn(() => vi.fn()) },
}));

import { useTableTournament } from '../../src/hooks/useTableTournament';

describe('useTableTournament', () => {
  it('should export useTableTournament as a function', () => {
    expect(typeof useTableTournament).toBe('function');
  });
});

describe('the shared t-break channel (2026-10-24)', () => {
  it('unmounting does not close the break channel other holders share', async () => {
    const { renderHook } = await import('@testing-library/react');
    const shared = { unsubscribe: vi.fn(), state: 'joined' };
    const { result, unmount } = renderHook(() => useTableTournament());
    result.current.breakChannelRef.current = shared;
    unmount();
    // The registry's refcounted release (TablePage) is the only owner of this.
    expect(shared.unsubscribe).not.toHaveBeenCalled();
    expect(result.current.breakChannelRef.current).toBe(shared);
  });
});
