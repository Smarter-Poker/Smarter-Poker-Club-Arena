/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  UNIT TESTS — TournamentService
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Tests BLIND_STRUCTURES, PAYOUT_STRUCTURES, SPIN_MULTIPLIERS, BOUNTY_PRESETS,
 * getTournament null return, and getTournaments empty return.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockRpc, mockEmit } = vi.hoisted(() => ({
  mockRpc: vi.fn(),
  mockEmit: vi.fn(),
}));

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
      rpc: mockRpc,
    },
  };
});

vi.mock('../../src/core/MasterBus', () => ({
  masterBus: { emit: mockEmit, subscribe: vi.fn(() => vi.fn()) },
}));

vi.mock('../../src/utils/retryAsync', () => ({
  retryAsync: <T>(fn: () => Promise<T>) => fn(),
}));

vi.mock('../../src/utils/clubIdResolver', () => ({
  resolveClubUUID: vi.fn().mockResolvedValue('resolved-uuid'),
}));

vi.mock('../../src/services/WalletService', () => ({
  WalletService: { logTransaction: vi.fn().mockResolvedValue(undefined) },
}));

// ─── Import AFTER mocks ──────────────────────────────────────────────────

import {
  BLIND_STRUCTURES,
  PAYOUT_STRUCTURES,
  SPIN_MULTIPLIERS,
  BOUNTY_PRESETS,
  SPIN_BLIND_STRUCTURE,
  tournamentService,
} from '../../src/services/TournamentService';

describe('TournamentService', () => {
  beforeEach(() => vi.clearAllMocks());

  // ─────────────────────────────────────────────────────────────────────────
  // BLIND STRUCTURES
  // ─────────────────────────────────────────────────────────────────────────

  describe('BLIND_STRUCTURES', () => {
    it('should have turbo, regular, and deepStack', () => {
      expect(BLIND_STRUCTURES.turbo).toBeDefined();
      expect(BLIND_STRUCTURES.regular).toBeDefined();
      expect(BLIND_STRUCTURES.deepStack).toBeDefined();
    });

    it('turbo should have 30 levels', () => {
      expect(BLIND_STRUCTURES.turbo).toHaveLength(30);
      // Check durations (3m or 5m break periods)
      const turboLevels = BLIND_STRUCTURES.turbo;
      for (const lvl of turboLevels) {
        expect([3, 5]).toContain(lvl.durationMinutes);
      }
    });

    it('regular should have 30 levels', () => {
      expect(BLIND_STRUCTURES.regular).toHaveLength(30);
      const regularLevels = BLIND_STRUCTURES.regular;
      for (const lvl of regularLevels) {
        expect([5, 8]).toContain(lvl.durationMinutes);
      }
    });

    it('deepStack should have 30 levels', () => {
      expect(BLIND_STRUCTURES.deepStack).toHaveLength(30);
      const deepStackLevels = BLIND_STRUCTURES.deepStack;
      for (const lvl of deepStackLevels) {
        expect([5, 15]).toContain(lvl.durationMinutes);
      }
    });

    it('blinds should increase monotonically per structure (excluding break levels)', () => {
      for (const struct of Object.values(BLIND_STRUCTURES)) {
        for (let i = 1; i < struct.length; i++) {
          // Breaks have 0 blinds, so skip comparisons involving breaks
          if (!struct[i].isBreak && !struct[i - 1].isBreak) {
            expect(struct[i].bigBlind).toBeGreaterThanOrEqual(struct[i - 1].bigBlind);
          }
        }
      }
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // PAYOUT STRUCTURES
  // ─────────────────────────────────────────────────────────────────────────

  describe('PAYOUT_STRUCTURES', () => {
    it('should have sng6, sng9, mtt10, mtt20, mtt50', () => {
      expect(PAYOUT_STRUCTURES.sng6).toBeDefined();
      expect(PAYOUT_STRUCTURES.sng9).toBeDefined();
      expect(PAYOUT_STRUCTURES.mtt10).toBeDefined();
      expect(PAYOUT_STRUCTURES.mtt20).toBeDefined();
      expect(PAYOUT_STRUCTURES.mtt50).toBeDefined();
    });

    it('each structure should sum to 100%', () => {
      for (const [name, struct] of Object.entries(PAYOUT_STRUCTURES)) {
        const total = struct.reduce((sum, p) => sum + p.percentage, 0);
        expect(total).toBeCloseTo(100, 1);
      }
    });

    it('sng6 should pay 2 places', () => {
      expect(PAYOUT_STRUCTURES.sng6).toHaveLength(2);
    });

    it('sng9 should pay 3 places', () => {
      expect(PAYOUT_STRUCTURES.sng9).toHaveLength(3);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // SPIN MULTIPLIERS
  // ─────────────────────────────────────────────────────────────────────────

  describe('SPIN_MULTIPLIERS', () => {
    it('should have standard and hyper profiles', () => {
      expect(SPIN_MULTIPLIERS.standard).toBeDefined();
      expect(SPIN_MULTIPLIERS.hyper).toBeDefined();
    });

    it('standard probabilities should sum to ≈100%', () => {
      const total = SPIN_MULTIPLIERS.standard.reduce((sum, s) => sum + s.probability, 0);
      expect(total).toBeCloseTo(100, 0);
    });

    it('standard EV should be < 3.0 (profitable for house)', () => {
      const ev = SPIN_MULTIPLIERS.standard.reduce(
        (sum, s) => sum + s.multiplier * (s.probability / 100),
        0
      );
      expect(ev).toBeLessThan(3.0);
    });

    it('hyper EV should be < 3.0 (profitable for house)', () => {
      const ev = SPIN_MULTIPLIERS.hyper.reduce(
        (sum, s) => sum + s.multiplier * (s.probability / 100),
        0
      );
      expect(ev).toBeLessThan(3.0);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // BOUNTY PRESETS
  // ─────────────────────────────────────────────────────────────────────────

  describe('BOUNTY_PRESETS', () => {
    it('should have fixed, progressive, mystery', () => {
      expect(BOUNTY_PRESETS.fixed).toBeDefined();
      expect(BOUNTY_PRESETS.progressive).toBeDefined();
      expect(BOUNTY_PRESETS.mystery).toBeDefined();
    });

    it('fixed should have bountyType = fixed', () => {
      expect(BOUNTY_PRESETS.fixed.bountyType).toBe('fixed');
    });

    it('mystery should have mysteryTiers array', () => {
      expect(BOUNTY_PRESETS.mystery.mysteryTiers).toBeDefined();
      expect(BOUNTY_PRESETS.mystery.mysteryTiers!.length).toBeGreaterThan(0);
    });

    it('mystery tier probabilities should sum to ≈100%', () => {
      const total = BOUNTY_PRESETS.mystery.mysteryTiers!.reduce((s, t) => s + t.probability, 0);
      expect(total).toBe(100);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // SPIN BLIND STRUCTURE
  // ─────────────────────────────────────────────────────────────────────────

  describe('SPIN_BLIND_STRUCTURE', () => {
    it('should have 15 levels at 2m each', () => {
      expect(SPIN_BLIND_STRUCTURE).toHaveLength(15);
      for (const lvl of SPIN_BLIND_STRUCTURE) {
        expect(lvl.durationMinutes).toBe(2);
      }
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // QUERIES
  // ─────────────────────────────────────────────────────────────────────────

  describe('getTournament', () => {
    it('should return null when tournament not found', async () => {
      const result = await tournamentService.getTournament('nonexistent');
      expect(result).toBeNull();
    });
  });

  describe('getTournaments', () => {
    it('should return empty array when no tournaments', async () => {
      const result = await tournamentService.getTournaments('club-1');
      expect(result).toEqual([]);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // AUDIT M19 — tournament money is server-owned
  // ───────────────────────────────────────────────────────────────────────────

  describe('unregisterPlayer (AUDIT M19)', () => {
    beforeEach(() => {
      mockRpc.mockReset();
      mockEmit.mockReset();
    });

    it('sends only the tournament id — no user, no amount', async () => {
      // No user parameter is the authorization model: a player may only
      // unregister themselves, and the way to guarantee that is to never accept
      // a target. No amount is the anti-mint rule: the refund is read from the
      // tournaments row server-side.
      mockRpc.mockResolvedValue({ data: { ok: true, refunded: 110 }, error: null });

      await tournamentService.unregisterPlayer('t-1', 'u-1');

      expect(mockRpc).toHaveBeenCalledTimes(1);
      const [name, args] = mockRpc.mock.calls[0];
      expect(name).toBe('fn_unregister_from_tournament');
      expect(args).toEqual({ p_tournament_id: 't-1' });
      expect(Object.keys(args)).toHaveLength(1);
    });

    it('emits a balance update only when something was actually refunded', async () => {
      mockRpc.mockResolvedValue({ data: { ok: true, refunded: 0 }, error: null });
      await tournamentService.unregisterPlayer('t-1', 'u-1');
      expect(mockEmit).not.toHaveBeenCalled();

      mockRpc.mockResolvedValue({ data: { ok: true, refunded: 110 }, error: null });
      await tournamentService.unregisterPlayer('t-1', 'u-1');
      expect(mockEmit).toHaveBeenCalledWith('BALANCE_UPDATED', {
        source: 'tournament_unregister_refund',
        userId: 'u-1',
      });
    });

    it('surfaces the server refusal reason rather than a generic failure', async () => {
      mockRpc.mockResolvedValue({
        data: { ok: false, reason: 'too_close_to_start' },
        error: null,
      });

      await expect(tournamentService.unregisterPlayer('t-1', 'u-1')).rejects.toThrow(
        /within a minute of the start time/i
      );
    });

    it('reports an unrecognised reason as itself', async () => {
      mockRpc.mockResolvedValue({ data: { ok: false, reason: 'brand_new_rule' }, error: null });
      await expect(tournamentService.unregisterPlayer('t-1', 'u-1')).rejects.toThrow(
        /brand_new_rule/
      );
    });

    it('throws when the RPC itself errors', async () => {
      mockRpc.mockResolvedValue({ data: null, error: { message: 'boom' } });
      await expect(tournamentService.unregisterPlayer('t-1', 'u-1')).rejects.toThrow(
        /could not unregister/i
      );
    });
  });

  describe('no client-side tournament payouts (AUDIT M19 regression guard)', () => {
    it('never calls a wallet-credit RPC while unregistering', async () => {
      // credit_player_wallet's third parameter is an idempotency key that
      // defaults to NULL. The old client passed two arguments, so every call
      // was un-deduplicated — a double-payout on top of the engine's own
      // credit, had the grant ever been widened.
      const forbidden = [
        'credit_player_wallet',
        'atomic_credit_wallet_and_log',
        'fn_idempotent_credit_wallet',
        'atomic_tournament_unregister',
      ];

      mockRpc.mockResolvedValue({ data: { ok: true, refunded: 110 }, error: null });
      await tournamentService.unregisterPlayer('t-1', 'u-1');

      for (const [name] of mockRpc.mock.calls) {
        expect(forbidden).not.toContain(name);
      }
    });

    it('no longer exposes eliminatePlayer, eliminatePlayerAuto or collectBounty', () => {
      // All three were client duplicates of TournamentManagerEliminations, which
      // computes prizes and bounties server-side and credits them idempotently.
      // Deleting them removed duplicate money paths, not features.
      const svc = tournamentService as unknown as Record<string, unknown>;
      expect(svc.eliminatePlayer).toBeUndefined();
      expect(svc.eliminatePlayerAuto).toBeUndefined();
      expect(svc.collectBounty).toBeUndefined();
    });

    it('keeps calculatePayout, which is display-only', () => {
      // Pure function used to show projected payouts in the lobby. Legitimate
      // client concern; must never be wired back into a credit.
      expect(typeof tournamentService.calculatePayout).toBe('function');
    });
  });
});
