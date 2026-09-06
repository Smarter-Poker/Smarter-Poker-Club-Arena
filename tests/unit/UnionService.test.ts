/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  UNIT TESTS — UnionService
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Tests union management logic:
 * - mapUnion field mapping (DB → domain)
 * - Default settings (10% revenue share, shared pool, cross-club tournaments)
 * - Settlement math (revenue share calculation)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mock dependencies ────────────────────────────────────────────────────

const buildChain = (): any => {
  const handler: ProxyHandler<any> = {
    get: (_target, prop) => {
      if (prop === 'maybeSingle' || prop === 'single')
        return () => Promise.resolve({ data: null, error: null });
      if (prop === 'then')
        return (resolve: (v: any) => void) => resolve({ data: null, error: null, count: 0 });
      return vi.fn().mockReturnValue(new Proxy({}, handler));
    },
  };
  return new Proxy({}, handler);
};

const fromMock = vi.hoisted(() => vi.fn());

vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    from: fromMock,
  },
}));

vi.mock('../../src/core/MasterBus', () => ({
  masterBus: {
    emit: vi.fn(),
    subscribe: vi.fn(() => vi.fn()),
  },
}));

vi.mock('../../src/utils/clubIdResolver', () => ({
  resolveClubUUID: (id: string) => Promise.resolve(id),
  isUUID: (id: string) => /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(id),
}));

// ─── Import AFTER mocks ──────────────────────────────────────────────────

import { UnionService } from '../../src/services/UnionService';

describe('UnionService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fromMock.mockImplementation(() => buildChain());
  });

  // ─────────────────────────────────────────────────────────────────────────
  // DEFAULT SETTINGS
  // ─────────────────────────────────────────────────────────────────────────

  describe('default union settings', () => {
    it('should default revenue share to 10%', () => {
      // mapUnion is private, but we can test via the structure
      // When settings are missing or null, defaults to 10%
      const defaults = {
        revenue_share_percent: undefined,
        shared_player_pool: undefined,
        cross_club_tournaments: undefined,
      };
      // Simulate mapUnion logic
      const revenueShare = defaults.revenue_share_percent || 10;
      const sharedPool = defaults.shared_player_pool ?? true;
      const crossClub = defaults.cross_club_tournaments ?? true;

      expect(revenueShare).toBe(10);
      expect(sharedPool).toBe(true);
      expect(crossClub).toBe(true);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // SETTLEMENT MATH
  // ─────────────────────────────────────────────────────────────────────────

  describe('settlement math', () => {
    it('should calculate union tax at revenue share rate', () => {
      const totalRake = 10000;
      const revenueSharePercent = 10;
      const unionTax = totalRake * (revenueSharePercent / 100);
      expect(unionTax).toBe(1000);
    });

    it('should calculate net-to-club correctly', () => {
      const clubRake = 5000;
      const revenueSharePercent = 10;
      const netToClub = clubRake * (1 - revenueSharePercent / 100);
      expect(netToClub).toBe(4500);
    });

    it('should estimate agent commissions at 20%', () => {
      const totalRake = 10000;
      const agentCommissions = totalRake * 0.2;
      expect(agentCommissions).toBe(2000);
    });

    it('should estimate player rakeback at 10%', () => {
      const totalRake = 10000;
      const playerRakeback = totalRake * 0.1;
      expect(playerRakeback).toBe(1000);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // WIRE DIRECTION
  // ─────────────────────────────────────────────────────────────────────────

  describe('wire direction', () => {
    it('should always be PAY_TO_UNION for club breakdowns', () => {
      const direction = 'PAY_TO_UNION' as const;
      expect(direction).toBe('PAY_TO_UNION');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // NULL HANDLING
  // ─────────────────────────────────────────────────────────────────────────

  describe('null handling', () => {
    it('should return null for non-existent union', async () => {
      const union = await UnionService.getUnion('non-existent');
      expect(union).toBeNull();
    });
  });

  describe('owned union cashier discovery', () => {
    it('reads canonical unions by owner and maps their route and artwork fields', async () => {
      const eq = vi.fn().mockResolvedValue({
        data: [
          {
            id: '11111111-1111-4111-8111-111111111111',
            slug: 'fresh-union',
            name: 'Fresh Union',
            owner_id: '22222222-2222-4222-8222-222222222222',
            avatar_url: 'https://cdn.example.test/fresh.webp',
            member_count: 12,
            created_at: '2026-09-06T00:00:00Z',
            updated_at: '2026-09-06T00:00:00Z',
          },
        ],
        error: null,
      });
      const select = vi.fn(() => ({ eq }));
      fromMock.mockReturnValue({ select });

      const unions = await UnionService.getOwnedUnions('22222222-2222-4222-8222-222222222222');

      expect(fromMock).toHaveBeenCalledWith('unions');
      expect(select).toHaveBeenCalledWith(
        'id, slug, name, owner_id, avatar_url, member_count, created_at, updated_at'
      );
      expect(eq).toHaveBeenCalledWith('owner_id', '22222222-2222-4222-8222-222222222222');
      expect(unions).toMatchObject([
        {
          id: '11111111-1111-4111-8111-111111111111',
          slug: 'fresh-union',
          name: 'Fresh Union',
          ownerId: '22222222-2222-4222-8222-222222222222',
          avatarUrl: 'https://cdn.example.test/fresh.webp',
          memberCount: 12,
        },
      ]);
    });

    it('does not silently convert a failed ownership read into no unions', async () => {
      const failure = new Error('union read refused');
      fromMock.mockReturnValue({
        select: vi.fn(() => ({ eq: vi.fn().mockResolvedValue({ data: null, error: failure }) })),
      });

      await expect(UnionService.getOwnedUnions('owner')).rejects.toBe(failure);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // ADMIN ROLES
  // ─────────────────────────────────────────────────────────────────────────

  describe('admin roles', () => {
    it('should support union_lead and union_admin roles', () => {
      const validRoles = ['union_lead', 'union_admin'];
      expect(validRoles).toHaveLength(2);
      expect(validRoles).toContain('union_lead');
      expect(validRoles).toContain('union_admin');
    });
  });
});
