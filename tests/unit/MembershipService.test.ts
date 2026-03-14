/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  UNIT TESTS — MembershipService
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Tests role hierarchy, permissions, and utility methods:
 * - 10-tier role hierarchy (platform_admin=100 → guest=10)
 * - hasHigherAuthority comparisons
 * - canPerformAction permission matrix (6 actions)
 * - isAgentRole / canHaveSubAgents utilities
 * - Role display names
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

vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    from: () => buildChain(),
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

import {
  MembershipService,
  ROLE_HIERARCHY,
  ROLE_DISPLAY_NAMES,
} from '../../src/services/MembershipService';
import type { MemberRole } from '../../src/services/MembershipService';

describe('MembershipService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ─────────────────────────────────────────────────────────────────────────
  // ROLE HIERARCHY
  // ─────────────────────────────────────────────────────────────────────────

  describe('ROLE_HIERARCHY', () => {
    it('should have exactly 10 roles', () => {
      expect(Object.keys(ROLE_HIERARCHY)).toHaveLength(10);
    });

    it('should rank platform_admin highest (100)', () => {
      expect(ROLE_HIERARCHY.platform_admin).toBe(100);
    });

    it('should rank guest lowest (10)', () => {
      expect(ROLE_HIERARCHY.guest).toBe(10);
    });

    it('should rank club_owner above club_admin', () => {
      expect(ROLE_HIERARCHY.club_owner).toBeGreaterThan(ROLE_HIERARCHY.club_admin);
    });

    it('should rank agent above sub_agent', () => {
      expect(ROLE_HIERARCHY.agent).toBeGreaterThan(ROLE_HIERARCHY.sub_agent);
    });

    it('should rank union_lead above club_owner', () => {
      expect(ROLE_HIERARCHY.union_lead).toBeGreaterThan(ROLE_HIERARCHY.club_owner);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // HAS HIGHER AUTHORITY
  // ─────────────────────────────────────────────────────────────────────────

  describe('hasHigherAuthority', () => {
    it('platform_admin > club_owner', () => {
      expect(MembershipService.hasHigherAuthority('platform_admin', 'club_owner')).toBe(true);
    });

    it('club_owner > member', () => {
      expect(MembershipService.hasHigherAuthority('club_owner', 'member')).toBe(true);
    });

    it('member < club_admin', () => {
      expect(MembershipService.hasHigherAuthority('member', 'club_admin')).toBe(false);
    });

    it('same role = not higher', () => {
      expect(MembershipService.hasHigherAuthority('agent', 'agent')).toBe(false);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // CAN PERFORM ACTION
  // ─────────────────────────────────────────────────────────────────────────

  describe('canPerformAction', () => {
    it('club_owner can manage_members', () => {
      expect(MembershipService.canPerformAction('club_owner', 'manage_members')).toBe(true);
    });

    it('member cannot manage_members', () => {
      expect(MembershipService.canPerformAction('member', 'manage_members')).toBe(false);
    });

    it('agent can create_tables', () => {
      expect(MembershipService.canPerformAction('agent', 'create_tables')).toBe(true);
    });

    it('guest cannot create_tables', () => {
      expect(MembershipService.canPerformAction('guest', 'create_tables')).toBe(false);
    });

    it('club_admin can view_financials', () => {
      expect(MembershipService.canPerformAction('club_admin', 'view_financials')).toBe(true);
    });

    it('sub_agent cannot manage_agents', () => {
      expect(MembershipService.canPerformAction('sub_agent', 'manage_agents')).toBe(false);
    });

    it('super_agent can manage_agents', () => {
      expect(MembershipService.canPerformAction('super_agent', 'manage_agents')).toBe(true);
    });

    it('agent can assign_credit', () => {
      expect(MembershipService.canPerformAction('agent', 'assign_credit')).toBe(true);
    });

    it('returns false for unknown action', () => {
      expect(MembershipService.canPerformAction('club_owner', 'unknown_action' as any)).toBe(false);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // AGENT ROLE UTILITIES
  // ─────────────────────────────────────────────────────────────────────────

  describe('isAgentRole', () => {
    it.each<MemberRole>(['super_agent', 'agent', 'sub_agent'])(
      'should return true for %s',
      (role) => {
        expect(MembershipService.isAgentRole(role)).toBe(true);
      }
    );

    it.each<MemberRole>(['club_owner', 'member', 'guest', 'club_admin'])(
      'should return false for %s',
      (role) => {
        expect(MembershipService.isAgentRole(role)).toBe(false);
      }
    );
  });

  describe('canHaveSubAgents', () => {
    it('super_agent can have sub-agents', () => {
      expect(MembershipService.canHaveSubAgents('super_agent')).toBe(true);
    });

    it('agent can have sub-agents', () => {
      expect(MembershipService.canHaveSubAgents('agent')).toBe(true);
    });

    it('sub_agent cannot have sub-agents', () => {
      expect(MembershipService.canHaveSubAgents('sub_agent')).toBe(false);
    });

    it('member cannot have sub-agents', () => {
      expect(MembershipService.canHaveSubAgents('member')).toBe(false);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // DISPLAY NAMES
  // ─────────────────────────────────────────────────────────────────────────

  describe('getRoleDisplayName', () => {
    it('should return human-readable name for each role', () => {
      expect(MembershipService.getRoleDisplayName('platform_admin')).toBe('Platform Admin');
      expect(MembershipService.getRoleDisplayName('club_owner')).toBe('Club Owner');
      expect(MembershipService.getRoleDisplayName('sub_agent')).toBe('Sub-Agent');
      expect(MembershipService.getRoleDisplayName('member')).toBe('Member');
    });

    it('should have 10 display names matching 10 roles', () => {
      expect(Object.keys(ROLE_DISPLAY_NAMES)).toHaveLength(10);
    });
  });
});
