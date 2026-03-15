/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  UNIT TESTS — ClubMessagingPermissions (Strengthened)
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
    },
  };
});

vi.mock('../../src/utils/clubIdResolver', () => ({
  resolveClubUUID: vi.fn().mockResolvedValue('resolved-uuid'),
}));

import { clubMessagingPermissions } from '../../src/services/ClubMessagingPermissions';

describe('ClubMessagingPermissions', () => {
  beforeEach(() => vi.clearAllMocks());

  describe('canMessage', () => {
    it('should deny when sender is not a club member', async () => {
      const result = await clubMessagingPermissions.canMessage('sender-1', 'recip-1', 'club-1');
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('not a member');
    });

    it('should return an object with allowed and reason', async () => {
      const result = await clubMessagingPermissions.canMessage('a', 'b', 'c');
      expect(typeof result.allowed).toBe('boolean');
      expect(typeof result.reason).toBe('string');
    });

    it('should deny for empty user IDs', async () => {
      const result = await clubMessagingPermissions.canMessage('', '', 'club-1');
      expect(result.allowed).toBe(false);
    });
  });

  describe('getMessagableUsers', () => {
    it('should return empty array when user has no club role', async () => {
      const result = await clubMessagingPermissions.getMessagableUsers('user-1', 'club-1');
      expect(result).toEqual([]);
    });

    it('should return an array type', async () => {
      const result = await clubMessagingPermissions.getMessagableUsers('user-2', 'club-2');
      expect(Array.isArray(result)).toBe(true);
    });
  });

  describe('export shape', () => {
    it('should export singleton with canMessage and getMessagableUsers', () => {
      expect(typeof clubMessagingPermissions.canMessage).toBe('function');
      expect(typeof clubMessagingPermissions.getMessagableUsers).toBe('function');
    });
  });
});
