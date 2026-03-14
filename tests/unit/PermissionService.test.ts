/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  UNIT TESTS — PermissionService
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Tests hierarchical permission system:
 * - isAtLeastLevel: admin hierarchy comparison
 * - getPermissionsForLevel: correct permission sets per level
 * - getLevelDisplayName: human-readable level names
 * - getLevelColor: UI color assignments
 * - Permission inheritance: each level inherits lower levels
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mock dependencies ────────────────────────────────────────────────────

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

vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    from: () => buildChain(),
    rpc: vi.fn().mockResolvedValue({ data: null, error: null }),
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
}));

// ─── Import AFTER mocks ──────────────────────────────────────────────────

import { PermissionService } from '../../src/services/PermissionService';
import type { AdminLevel } from '../../src/services/PermissionService';

describe('PermissionService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ─────────────────────────────────────────────────────────────────────────
  // IS AT LEAST LEVEL
  // ─────────────────────────────────────────────────────────────────────────

  describe('isAtLeastLevel', () => {
    it('PLATFORM_ADMIN should be at least every level', () => {
      expect(PermissionService.isAtLeastLevel('PLATFORM_ADMIN', 'PLATFORM_ADMIN')).toBe(true);
      expect(PermissionService.isAtLeastLevel('PLATFORM_ADMIN', 'UNION_ADMIN')).toBe(true);
      expect(PermissionService.isAtLeastLevel('PLATFORM_ADMIN', 'CLUB_OWNER')).toBe(true);
      expect(PermissionService.isAtLeastLevel('PLATFORM_ADMIN', 'AGENT')).toBe(true);
      expect(PermissionService.isAtLeastLevel('PLATFORM_ADMIN', 'PLAYER')).toBe(true);
    });

    it('PLAYER should only be at level PLAYER', () => {
      expect(PermissionService.isAtLeastLevel('PLAYER', 'PLATFORM_ADMIN')).toBe(false);
      expect(PermissionService.isAtLeastLevel('PLAYER', 'UNION_ADMIN')).toBe(false);
      expect(PermissionService.isAtLeastLevel('PLAYER', 'CLUB_OWNER')).toBe(false);
      expect(PermissionService.isAtLeastLevel('PLAYER', 'AGENT')).toBe(false);
      expect(PermissionService.isAtLeastLevel('PLAYER', 'PLAYER')).toBe(true);
    });

    it('AGENT should be at level AGENT and PLAYER only', () => {
      expect(PermissionService.isAtLeastLevel('AGENT', 'PLATFORM_ADMIN')).toBe(false);
      expect(PermissionService.isAtLeastLevel('AGENT', 'CLUB_OWNER')).toBe(false);
      expect(PermissionService.isAtLeastLevel('AGENT', 'AGENT')).toBe(true);
      expect(PermissionService.isAtLeastLevel('AGENT', 'PLAYER')).toBe(true);
    });

    it('CLUB_OWNER should be at level CLUB_OWNER, AGENT, PLAYER', () => {
      expect(PermissionService.isAtLeastLevel('CLUB_OWNER', 'PLATFORM_ADMIN')).toBe(false);
      expect(PermissionService.isAtLeastLevel('CLUB_OWNER', 'UNION_ADMIN')).toBe(false);
      expect(PermissionService.isAtLeastLevel('CLUB_OWNER', 'CLUB_OWNER')).toBe(true);
      expect(PermissionService.isAtLeastLevel('CLUB_OWNER', 'AGENT')).toBe(true);
      expect(PermissionService.isAtLeastLevel('CLUB_OWNER', 'PLAYER')).toBe(true);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // GET PERMISSIONS FOR LEVEL
  // ─────────────────────────────────────────────────────────────────────────

  describe('getPermissionsForLevel', () => {
    it('PLATFORM_ADMIN should have the most permissions', () => {
      const adminPerms = PermissionService.getPermissionsForLevel('PLATFORM_ADMIN');
      const playerPerms = PermissionService.getPermissionsForLevel('PLAYER');
      expect(adminPerms.length).toBeGreaterThan(playerPerms.length);
    });

    it('PLAYER should have exactly 6 permissions', () => {
      const perms = PermissionService.getPermissionsForLevel('PLAYER');
      expect(perms.length).toBe(6);
      expect(perms).toContain('JOIN_TABLES');
      expect(perms).toContain('JOIN_TOURNAMENTS');
      expect(perms).toContain('VIEW_OWN_HISTORY');
      expect(perms).toContain('MANAGE_OWN_PROFILE');
      expect(perms).toContain('TRANSFER_CHIPS');
      expect(perms).toContain('ADD_FRIENDS');
    });

    it('AGENT should inherit all PLAYER permissions', () => {
      const agentPerms = PermissionService.getPermissionsForLevel('AGENT');
      const playerPerms = PermissionService.getPermissionsForLevel('PLAYER');
      for (const perm of playerPerms) {
        expect(agentPerms).toContain(perm);
      }
    });

    it('CLUB_OWNER should inherit all AGENT permissions', () => {
      const ownerPerms = PermissionService.getPermissionsForLevel('CLUB_OWNER');
      const agentPerms = PermissionService.getPermissionsForLevel('AGENT');
      for (const perm of agentPerms) {
        expect(ownerPerms).toContain(perm);
      }
    });

    it('PLATFORM_ADMIN should include EMERGENCY_SHUTDOWN', () => {
      const perms = PermissionService.getPermissionsForLevel('PLATFORM_ADMIN');
      expect(perms).toContain('EMERGENCY_SHUTDOWN');
    });

    it('AGENT should NOT have EMERGENCY_SHUTDOWN', () => {
      const perms = PermissionService.getPermissionsForLevel('AGENT');
      expect(perms).not.toContain('EMERGENCY_SHUTDOWN');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // GET LEVEL DISPLAY NAME
  // ─────────────────────────────────────────────────────────────────────────

  describe('getLevelDisplayName', () => {
    it.each([
      ['PLATFORM_ADMIN', 'Platform Administrator'],
      ['UNION_ADMIN', 'Union Administrator'],
      ['CLUB_OWNER', 'Club Owner'],
      ['AGENT', 'Agent'],
      ['PLAYER', 'Player'],
    ] as [AdminLevel, string][])('should return "%s" for %s', (level, expected) => {
      expect(PermissionService.getLevelDisplayName(level)).toBe(expected);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // GET LEVEL COLOR
  // ─────────────────────────────────────────────────────────────────────────

  describe('getLevelColor', () => {
    it('should return a hex color for each level', () => {
      const levels: AdminLevel[] = [
        'PLATFORM_ADMIN',
        'UNION_ADMIN',
        'CLUB_OWNER',
        'AGENT',
        'PLAYER',
      ];
      for (const level of levels) {
        const color = PermissionService.getLevelColor(level);
        expect(color).toMatch(/^#[0-9A-Fa-f]{6}$/);
      }
    });

    it('should return unique colors for each level', () => {
      const levels: AdminLevel[] = [
        'PLATFORM_ADMIN',
        'UNION_ADMIN',
        'CLUB_OWNER',
        'AGENT',
        'PLAYER',
      ];
      const colors = levels.map((l) => PermissionService.getLevelColor(l));
      const unique = new Set(colors);
      expect(unique.size).toBe(5);
    });
  });
});
