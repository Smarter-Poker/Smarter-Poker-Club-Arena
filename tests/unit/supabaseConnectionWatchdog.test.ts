/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  UNIT TESTS — supabaseConnectionWatchdog
 * ═══════════════════════════════════════════════════════════════════════════════
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    from: vi.fn().mockReturnValue({
      select: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
    }),
    auth: { getUser: vi.fn().mockResolvedValue({ data: { user: null } }) },
  },
}));

import { supabaseConnectionWatchdog } from '../../src/utils/supabaseConnectionWatchdog';

describe('supabaseConnectionWatchdog', () => {
  it('should export supabaseConnectionWatchdog singleton', () => {
    expect(supabaseConnectionWatchdog).toBeDefined();
    expect(typeof supabaseConnectionWatchdog).toBe('object');
  });
});
