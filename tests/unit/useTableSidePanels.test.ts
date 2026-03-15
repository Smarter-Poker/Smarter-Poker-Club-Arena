/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  UNIT TESTS — useTableSidePanels
 * ═══════════════════════════════════════════════════════════════════════════════
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    from: vi.fn().mockReturnValue({
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
    }),
    rpc: vi.fn().mockResolvedValue({ data: null, error: null }),
  },
}));

import { useTableSidePanels } from '../../src/hooks/useTableSidePanels';

describe('useTableSidePanels', () => {
  it('should export useTableSidePanels as a function', () => {
    expect(typeof useTableSidePanels).toBe('function');
  });
});
