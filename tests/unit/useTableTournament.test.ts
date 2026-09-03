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
