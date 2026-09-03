/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  UNIT TESTS — HorseOrchestrator
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Tests export shape, getStats defaults, and config exports.
 */

import { describe, it, expect, vi } from 'vitest';

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
      rpc: vi.fn().mockResolvedValue({ data: null, error: null }),
    },
  };
});

vi.mock('../../src/core/MasterBus', () => ({
  masterBus: { emit: vi.fn(), subscribe: vi.fn(() => vi.fn()) },
}));

vi.mock('../../src/utils/clubIdResolver', () => ({
  resolveClubUUID: vi.fn().mockResolvedValue('resolved-uuid'),
}));

vi.mock('../../src/utils/retryAsync', () => ({
  retryAsync: <T>(fn: () => Promise<T>) => fn(),
}));

vi.mock('../../src/services/WalletService', () => ({
  WalletService: { logTransaction: vi.fn().mockResolvedValue(undefined) },
}));

vi.mock('../../src/services/HydraService', () => ({
  HydraService: {
    config: { maxHorsesPerTable: 3 },
    initialize: vi.fn(),
    getAvailableHorses: vi.fn().mockResolvedValue([]),
    seatHorse: vi.fn().mockResolvedValue(null),
  },
}));

vi.mock('../../src/services/TournamentService', () => ({
  tournamentService: {
    createTournament: vi.fn().mockResolvedValue({ id: 't-1' }),
    registerPlayer: vi.fn().mockResolvedValue({ id: 'p-1' }),
    getTournament: vi.fn().mockResolvedValue(null),
  },
  BLIND_STRUCTURES: { turbo: [], regular: [], deepStack: [] },
  PAYOUT_STRUCTURES: { sng6: [], sng9: [], mtt10: [] },
}));

// RakeService mock removed 2026-08-15 with the service itself. HorseOrchestrator
// no longer imports it (rake is server-authoritative), so the mock was inert and
// pointed at a module that no longer exists.

// ─── Import AFTER mocks ──────────────────────────────────────────────────

import {
  horseOrchestrator,
  DEFAULT_TABLES,
  TOURNAMENT_CONFIGS,
  SNG_CONFIGS,
  SPIN_CONFIGS,
} from '../../src/services/HorseOrchestrator';

describe('HorseOrchestrator', () => {
  describe('singleton export', () => {
    it('should export horseOrchestrator instance', () => {
      expect(horseOrchestrator).toBeDefined();
    });

    it('should have getStats method', () => {
      expect(typeof horseOrchestrator.getStats).toBe('function');
    });
  });

  describe('getStats', () => {
    it('should return default stats when not started', () => {
      const stats = horseOrchestrator.getStats();
      expect(stats.totalHorses).toBe(0);
      expect(stats.totalTables).toBe(0);
      expect(stats.totalHandsPlayed).toBe(0);
      expect(stats.totalRakeCollected).toBe(0);
    });
  });

  describe('config exports', () => {
    it('DEFAULT_TABLES should be a non-empty array', () => {
      expect(Array.isArray(DEFAULT_TABLES)).toBe(true);
      expect(DEFAULT_TABLES.length).toBeGreaterThan(0);
    });

    it('TOURNAMENT_CONFIGS should be a non-empty array', () => {
      expect(Array.isArray(TOURNAMENT_CONFIGS)).toBe(true);
      expect(TOURNAMENT_CONFIGS.length).toBeGreaterThan(0);
    });

    it('SNG_CONFIGS should be a non-empty array', () => {
      expect(Array.isArray(SNG_CONFIGS)).toBe(true);
      expect(SNG_CONFIGS.length).toBeGreaterThan(0);
    });

    it('SPIN_CONFIGS should be a non-empty array', () => {
      expect(Array.isArray(SPIN_CONFIGS)).toBe(true);
      expect(SPIN_CONFIGS.length).toBeGreaterThan(0);
    });
  });
});
