/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  UNIT TESTS — AntiGravityBoot
 * ═══════════════════════════════════════════════════════════════════════════════
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    auth: { getUser: vi.fn().mockResolvedValue({ data: { user: null } }) },
    from: vi.fn().mockReturnValue({
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
    }),
  },
}));

vi.mock('../../src/core/IdentityDNA', () => ({
  initIdentityDNA: vi.fn().mockResolvedValue({ loaded: true }),
}));

vi.mock('../../src/core/MasterBus', () => ({
  masterBus: { init: vi.fn(), emit: vi.fn(), subscribe: vi.fn(() => vi.fn()) },
}));

import { getBootStatus, isSystemOnline } from '../../src/core/AntiGravityBoot';

describe('AntiGravityBoot', () => {
  it('should export getBootStatus as a function', () => {
    expect(typeof getBootStatus).toBe('function');
  });

  it('should export isSystemOnline as a function', () => {
    expect(typeof isSystemOnline).toBe('function');
  });

  it('should return null for getBootStatus before init', () => {
    expect(getBootStatus()).toBeNull();
  });

  it('should return false for isSystemOnline before init', () => {
    expect(isSystemOnline()).toBe(false);
  });
});
