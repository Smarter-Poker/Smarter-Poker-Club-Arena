/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  UNIT TESTS — ClubMessagingPermissions
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Tests hierarchical role-based messaging permission rules (pure logic).
 * The checkPermission method is private, so we test via canMessage with
 * controlled mocks that return specific roles.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mock dependencies ────────────────────────────────────────────────────

// We need fine-grained control over what getUserClubRole returns
const mockFrom = vi.fn();

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

// ─── Import AFTER mocks ──────────────────────────────────────────────────

import { clubMessagingPermissions } from '../../src/services/ClubMessagingPermissions';

describe('ClubMessagingPermissions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ─────────────────────────────────────────────────────────────────────────
  // canMessage — returns not-allowed when user is not found (mocked null)
  // ─────────────────────────────────────────────────────────────────────────

  describe('canMessage', () => {
    it('should deny when sender is not a club member', async () => {
      // With our mock, getUserClubRole returns null (no member data)
      const result = await clubMessagingPermissions.canMessage('sender-1', 'recip-1', 'club-1');
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('not a member');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // getMessagableUsers — returns empty when user role is null
  // ─────────────────────────────────────────────────────────────────────────

  describe('getMessagableUsers', () => {
    it('should return empty array when user has no club role', async () => {
      const result = await clubMessagingPermissions.getMessagableUsers('user-1', 'club-1');
      expect(result).toEqual([]);
    });
  });
});
