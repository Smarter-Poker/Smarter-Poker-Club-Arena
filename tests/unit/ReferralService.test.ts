/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  UNIT TESTS — ReferralService
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Tests:
 * - Milestone definitions (5→2500, 10→5000, 25→15000, 50→50000)
 * - getMilestones unlock logic
 * - Code generation character set (excludes I/O/0/1)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mock dependencies ────────────────────────────────────────────────────

vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    from: () => ({
      select: () => ({
        eq: () => ({
          limit: () => ({
            maybeSingle: () => Promise.resolve({ data: null, error: null }),
          }),
        }),
      }),
      insert: () => ({
        select: () => ({
          single: () => Promise.resolve({ data: null, error: null }),
        }),
      }),
    }),
    rpc: vi.fn().mockResolvedValue({ data: { success: true }, error: null }),
  },
}));

vi.mock('../../src/core/MasterBus', () => ({
  masterBus: {
    emit: vi.fn(),
    subscribe: vi.fn(() => vi.fn()),
  },
}));

// ─── Import AFTER mocks ──────────────────────────────────────────────────

import { referralService } from '../../src/services/ReferralService';

describe('ReferralService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ─────────────────────────────────────────────────────────────────────────
  // MILESTONE DEFINITIONS
  // ─────────────────────────────────────────────────────────────────────────

  describe('getMilestones', () => {
    it('should return 4 milestones', () => {
      const milestones = referralService.getMilestones(0);
      expect(milestones).toHaveLength(4);
    });

    it('should have correct rewards: 2500, 5000, 15000, 50000', () => {
      const milestones = referralService.getMilestones(0);
      expect(milestones.map((m) => m.reward)).toEqual([2500, 5000, 15000, 50000]);
    });

    it('should have correct thresholds: 5, 10, 25, 50', () => {
      const milestones = referralService.getMilestones(0);
      expect(milestones.map((m) => m.count)).toEqual([5, 10, 25, 50]);
    });

    it('should unlock milestones up to current referral count', () => {
      const milestones = referralService.getMilestones(12);
      expect(milestones[0].unlocked).toBe(true); // 5 referrals
      expect(milestones[1].unlocked).toBe(true); // 10 referrals
      expect(milestones[2].unlocked).toBe(false); // 25 referrals
      expect(milestones[3].unlocked).toBe(false); // 50 referrals
    });

    it('should unlock all milestones at 50+', () => {
      const milestones = referralService.getMilestones(100);
      expect(milestones.every((m) => m.unlocked)).toBe(true);
    });

    it('should unlock none at 0', () => {
      const milestones = referralService.getMilestones(0);
      expect(milestones.every((m) => !m.unlocked)).toBe(true);
    });

    it('should unlock first milestone at exactly 5', () => {
      const milestones = referralService.getMilestones(5);
      expect(milestones[0].unlocked).toBe(true);
      expect(milestones[1].unlocked).toBe(false);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // CODE GENERATION
  // ─────────────────────────────────────────────────────────────────────────

  describe('generateCode', () => {
    it('should generate 8-character codes', () => {
      // Access private method
      const code = (referralService as any).generateCode();
      expect(code).toHaveLength(8);
    });

    it('should only contain allowed characters (no I, O, 0, 1)', () => {
      const forbidden = ['I', 'O', '0', '1'];
      // Generate several codes to test randomness
      for (let i = 0; i < 20; i++) {
        const code = (referralService as any).generateCode();
        for (const char of forbidden) {
          expect(code).not.toContain(char);
        }
      }
    });

    it('should only contain uppercase letters and digits', () => {
      for (let i = 0; i < 10; i++) {
        const code = (referralService as any).generateCode();
        expect(code).toMatch(/^[A-Z2-9]+$/);
      }
    });
  });
});
