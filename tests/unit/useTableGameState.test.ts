/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  UNIT TESTS — useTableGameState
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

import { useTableGameState } from '../../src/hooks/useTableGameState';

describe('useTableGameState', () => {
  it('should export useTableGameState as a function', () => {
    expect(typeof useTableGameState).toBe('function');
  });
});
