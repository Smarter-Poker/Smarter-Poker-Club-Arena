/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  UNIT TESTS — useRealtimeRecovery
 * ═══════════════════════════════════════════════════════════════════════════════
 */
import { describe, it, expect, vi } from 'vitest';
import { renderHook } from '@testing-library/react';

vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    channel: vi.fn().mockReturnValue({
      on: vi.fn().mockReturnThis(),
      subscribe: vi.fn().mockReturnValue('subscribed'),
      unsubscribe: vi.fn(),
    }),
    removeChannel: vi.fn(),
  },
}));

import { useRealtimeRecovery } from '../../src/hooks/useRealtimeRecovery';

describe('useRealtimeRecovery', () => {
  it('should export useRealtimeRecovery as a function', () => {
    expect(typeof useRealtimeRecovery).toBe('function');
  });

  it('should accept a channel name and recovery callback', () => {
    const recovery = vi.fn();
    const { unmount } = renderHook(() => useRealtimeRecovery('test-channel', recovery));
    unmount();
    // No crash = success
  });
});
