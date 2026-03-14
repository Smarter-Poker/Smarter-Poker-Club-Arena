/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  UNIT TESTS — InviteService
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Tests invite code generation:
 * - generateCode: 8-char alphanumeric, excludes ambiguous characters (0, O, 1, I)
 * - getInviteUrl: proper URL construction
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mock dependencies ────────────────────────────────────────────────────

vi.mock('../../src/lib/supabase', () => {
  const buildChain = (): any => {
    const handler: ProxyHandler<any> = {
      get: (_target, prop) => {
        if (prop === 'maybeSingle' || prop === 'single')
          return () => Promise.resolve({ data: null, error: null });
        if (prop === 'then')
          return (resolve: (v: any) => void) => resolve({ data: null, error: null });
        return vi.fn().mockReturnValue(new Proxy({}, handler));
      },
    };
    return new Proxy({}, handler);
  };
  return {
    supabase: {
      from: () => buildChain(),
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user: null }, error: null }) },
      functions: { invoke: vi.fn().mockResolvedValue({ data: null, error: null }) },
    },
  };
});

vi.mock('../../src/utils/clubIdResolver', () => ({
  resolveClubUUID: (id: string) => Promise.resolve(id),
}));

// ─── Import AFTER mocks ──────────────────────────────────────────────────

import { InviteService } from '../../src/services/InviteService';

describe('InviteService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ─────────────────────────────────────────────────────────────────────────
  // GENERATE CODE
  // ─────────────────────────────────────────────────────────────────────────

  describe('generateCode', () => {
    it('should generate an 8-character code', () => {
      const code = InviteService.generateCode();
      expect(code.length).toBe(8);
    });

    it('should only contain allowed characters (no 0, O, 1, I)', () => {
      const allowed = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
      for (let i = 0; i < 50; i++) {
        const code = InviteService.generateCode();
        for (const char of code) {
          expect(allowed).toContain(char);
        }
      }
    });

    it('should generate unique codes', () => {
      const codes = new Set<string>();
      for (let i = 0; i < 100; i++) {
        codes.add(InviteService.generateCode());
      }
      expect(codes.size).toBe(100); // All unique
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // GET INVITE URL
  // ─────────────────────────────────────────────────────────────────────────

  describe('getInviteUrl', () => {
    it('should construct URL with code parameter', () => {
      const url = InviteService.getInviteUrl('ABC12345');
      expect(url).toContain('/invite?code=ABC12345');
    });
  });
});
