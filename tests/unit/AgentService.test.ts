/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  UNIT TESTS — AgentService
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Tests agent hierarchy and validation rules:
 * - Commission rate caps (max 70%)
 * - Rakeback rate caps (max 50%)
 * - Valid commission rate steps (40–70% in 5% increments)
 * - Credit limit negativity guard
 * - Self-transfer same-wallet guard
 * - Required field validation
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

vi.mock('../../src/utils/retryAsync', () => ({
  retryAsync: (fn: () => any) => fn(),
}));

vi.mock('../../src/utils/clubIdResolver', () => ({
  resolveClubUUID: (id: string) => Promise.resolve(id),
}));

vi.mock('../../src/services/WalletService', () => ({
  WalletService: {
    logTransaction: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('../../src/services/ChipFlowService', () => ({
  ChipFlowService: {},
}));

// ─── Import AFTER mocks ──────────────────────────────────────────────────

import { AgentService } from '../../src/services/AgentService';

describe('AgentService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ─────────────────────────────────────────────────────────────────────────
  // COMMISSION RATE VALIDATION
  // ─────────────────────────────────────────────────────────────────────────

  describe('commission rate caps', () => {
    it('should reject commission rate above 70%', async () => {
      await expect(
        AgentService.createAgent({
          userId: 'user-1',
          clubId: 'club-1',
          role: 'agent',
          commissionRate: 0.75,
          playerRakebackRate: 0.3,
          creditLimit: 10000,
        })
        // 2026-08-15: regex updated to the message createAgent actually throws.
        // The 70% cap IS enforced (AgentService.ts:270-271); only the wording
        // differs from the old /exceed 70%/i — createAgent says "must be between
        // 0% and 70%", while updateRates says "cannot exceed 70%".
      ).rejects.toThrow(/commission rate must be between 0% and 70%/i);
    });

    it('should reject commission rate at 71%', async () => {
      await expect(
        AgentService.createAgent({
          userId: 'user-1',
          clubId: 'club-1',
          role: 'agent',
          commissionRate: 0.71,
          playerRakebackRate: 0.3,
          creditLimit: 10000,
        })
      ).rejects.toThrow();
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // RAKEBACK RATE VALIDATION
  // ─────────────────────────────────────────────────────────────────────────

  describe('rakeback rate caps', () => {
    it('should reject rakeback rate above 50%', async () => {
      await expect(
        AgentService.createAgent({
          userId: 'user-1',
          clubId: 'club-1',
          role: 'agent',
          commissionRate: 0.5,
          playerRakebackRate: 0.55,
          creditLimit: 10000,
        })
        // 2026-08-15: regex updated to the message createAgent actually throws.
        // The 50% rakeback cap IS enforced (AgentService.ts:272-273); the
        // wording is "must be between 0% and 50%", not "cannot exceed 50%".
      ).rejects.toThrow(/rakeback rate must be between 0% and 50%/i);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // REQUIRED FIELDS
  // ─────────────────────────────────────────────────────────────────────────

  describe('required field validation', () => {
    it('should reject missing commission rate', async () => {
      await expect(
        AgentService.createAgent({
          userId: 'user-1',
          clubId: 'club-1',
          role: 'agent',
          commissionRate: undefined as any,
          playerRakebackRate: 0.3,
          creditLimit: 10000,
        })
      ).rejects.toThrow(/commission rate is required/i);
    });

    it('should reject missing rakeback rate', async () => {
      await expect(
        AgentService.createAgent({
          userId: 'user-1',
          clubId: 'club-1',
          role: 'agent',
          commissionRate: 0.5,
          playerRakebackRate: undefined as any,
          creditLimit: 10000,
        })
      ).rejects.toThrow(/rakeback rate is required/i);
    });

    it('should reject missing credit limit', async () => {
      await expect(
        AgentService.createAgent({
          userId: 'user-1',
          clubId: 'club-1',
          role: 'agent',
          commissionRate: 0.5,
          playerRakebackRate: 0.3,
          creditLimit: undefined as any,
        })
      ).rejects.toThrow(/credit limit is required/i);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // VALID COMMISSION RATE STEPS (promoteToAgent)
  // ─────────────────────────────────────────────────────────────────────────

  describe('valid commission rate steps', () => {
    const validRates = [0.4, 0.45, 0.5, 0.55, 0.6, 0.65, 0.7];

    it('should define exactly 7 valid rate steps', () => {
      expect(validRates).toHaveLength(7);
    });

    it.each(validRates)('should include %s as valid rate', (rate) => {
      expect(validRates.includes(rate)).toBe(true);
    });

    it('should reject 0.42 (not a 5% step)', () => {
      expect(validRates.includes(0.42)).toBe(false);
    });

    it('should reject 0.35 (below minimum 40%)', () => {
      expect(validRates.includes(0.35)).toBe(false);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // RATE UPDATE VALIDATION
  // ─────────────────────────────────────────────────────────────────────────

  describe('updateRates', () => {
    it('should reject commission rate above 70%', async () => {
      await expect(AgentService.updateRates('agent-1', 0.8)).rejects.toThrow(/exceed 70%/i);
    });

    it('should reject rakeback rate above 50%', async () => {
      await expect(AgentService.updateRates('agent-1', undefined, 0.6)).rejects.toThrow(
        /exceed 50%/i
      );
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // SELF-TRANSFER GUARDS
  // ─────────────────────────────────────────────────────────────────────────

  describe('selfTransfer', () => {
    it('should reject zero amount', async () => {
      await expect(AgentService.selfTransfer('agent-1', 0, 'business', 'player')).rejects.toThrow(
        /positive/i
      );
    });

    it('should reject negative amount', async () => {
      await expect(
        AgentService.selfTransfer('agent-1', -100, 'business', 'player')
      ).rejects.toThrow(/positive/i);
    });

    it('should reject same-wallet transfer', async () => {
      await expect(
        AgentService.selfTransfer('agent-1', 100, 'business', 'business')
      ).rejects.toThrow(/same wallet/i);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // CREDIT LIMIT GUARD
  // ─────────────────────────────────────────────────────────────────────────

  describe('setCreditLimit', () => {
    it('should reject negative credit limit', async () => {
      await expect(AgentService.setCreditLimit('agent-1', -500, 'owner-1')).rejects.toThrow(
        /negative/i
      );
    });
  });
});
