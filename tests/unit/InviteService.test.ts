/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  UNIT TESTS — InviteService (Strengthened)
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

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
      rpc: vi.fn().mockResolvedValue({ data: null, error: null }),
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user: null } }) },
    },
  };
});

vi.mock('../../src/core/MasterBus', () => ({
  masterBus: { emit: vi.fn(), subscribe: vi.fn(() => vi.fn()) },
}));

vi.mock('../../src/utils/retryAsync', () => ({
  retryAsync: <T>(fn: () => Promise<T>) => fn(),
}));

import { InviteService } from '../../src/services/InviteService';

describe('InviteService', () => {
  beforeEach(() => vi.clearAllMocks());

  describe('generateCode', () => {
    it('should return an 8-character code', () => {
      const code = InviteService.generateCode();
      expect(code).toHaveLength(8);
    });

    it('should generate unique codes', () => {
      const codes = new Set(Array.from({ length: 20 }, () => InviteService.generateCode()));
      expect(codes.size).toBe(20);
    });

    it('should only contain alphanumeric characters', () => {
      const code = InviteService.generateCode();
      expect(code).toMatch(/^[A-Z0-9]+$/);
    });
  });

  describe('getInviteUrl', () => {
    it('should return URL containing the code', () => {
      const url = InviteService.getInviteUrl('ABC12345');
      expect(url).toContain('ABC12345');
    });
  });

  describe('validateCode', () => {
    it('should return null for invalid code', async () => {
      const result = await InviteService.validateCode('INVALID');
      expect(result).toBeNull();
    });
  });

  describe('getClubInvites', () => {
    it('should return empty array when no invites', async () => {
      const result = await InviteService.getClubInvites('club-1');
      expect(result).toEqual([]);
    });
  });

  describe('export shape', () => {
    it('should export all methods', () => {
      expect(typeof InviteService.generateCode).toBe('function');
      expect(typeof InviteService.createInvite).toBe('function');
      expect(typeof InviteService.getInviteUrl).toBe('function');
      expect(typeof InviteService.validateCode).toBe('function');
      expect(typeof InviteService.acceptInvite).toBe('function');
      expect(typeof InviteService.cancelInvite).toBe('function');
      expect(typeof InviteService.getClubInvites).toBe('function');
      expect(typeof InviteService.copyInviteLink).toBe('function');
    });
  });
});
