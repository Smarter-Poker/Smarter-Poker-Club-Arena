/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  UNIT TESTS — ArenaLobbyEngine
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Tests calculateHeatLevel, getHeatConfig, calculateSoftness, and
 * fallback behavior for getArenaLobbyClubs / getClubTraffic.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mock dependencies ────────────────────────────────────────────────────

vi.mock('@/lib/supabase', () => {
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
      rpc: vi.fn().mockResolvedValue({ data: null, error: { message: 'Not available' } }),
      channel: vi.fn().mockReturnValue({
        on: vi.fn().mockReturnThis(),
        subscribe: vi.fn().mockReturnThis(),
      }),
      removeChannel: vi.fn(),
    },
  };
});

vi.mock('../../src/utils/retryAsync', () => ({
  retryAsync: vi.fn().mockResolvedValue({ data: null, error: { message: 'Not available' } }),
}));

vi.mock('../../src/utils/clubIdResolver', () => ({
  resolveClubUUID: vi.fn().mockResolvedValue('resolved-uuid'),
}));

vi.mock('@/types/club.types', () => ({}));

// ─── Import AFTER mocks ──────────────────────────────────────────────────

import {
  calculateHeatLevel,
  getHeatConfig,
  calculateSoftness,
  getArenaLobbyClubs,
  getClubTraffic,
  ArenaLobbyEngine,
} from '../../src/services/ArenaLobbyEngine';

describe('ArenaLobbyEngine', () => {
  beforeEach(() => vi.clearAllMocks());

  // ─────────────────────────────────────────────────────────────────────────
  // calculateHeatLevel
  // ─────────────────────────────────────────────────────────────────────────

  describe('calculateHeatLevel', () => {
    it('should return 0 (COLD) for 0 players, 0 waiting', () => {
      expect(calculateHeatLevel(0, 0)).toBe(0);
    });

    it('should return 1 (WARM) for 10 active players', () => {
      expect(calculateHeatLevel(10, 0)).toBe(1);
    });

    it('should return 2 (ACTIVE) for 25 active players', () => {
      expect(calculateHeatLevel(25, 0)).toBe(2);
    });

    it('should return 3 (HOT) for 50 active players', () => {
      expect(calculateHeatLevel(50, 0)).toBe(3);
    });

    it('should return 4 (VERY HOT) for 75 active players', () => {
      expect(calculateHeatLevel(75, 0)).toBe(4);
    });

    it('should return 5 (RED HOT) for 100 active players', () => {
      expect(calculateHeatLevel(100, 0)).toBe(5);
    });

    it('should consider waiting count too — 20 waiting → RED HOT', () => {
      expect(calculateHeatLevel(0, 20)).toBe(5);
    });

    it('should return highest matching level', () => {
      // 80 players + 12 waiting → VERY HOT (level 4, from 75 player threshold)
      expect(calculateHeatLevel(80, 12)).toBe(4);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // getHeatConfig
  // ─────────────────────────────────────────────────────────────────────────

  describe('getHeatConfig', () => {
    it('should return COLD config for level 0', () => {
      const config = getHeatConfig(0);
      expect(config.name).toBe('COLD');
      expect(config.color).toBe('#4A5568');
    });

    it('should return RED HOT config for level 5', () => {
      const config = getHeatConfig(5);
      expect(config.name).toBe('RED HOT');
      expect(config.color).toBe('#E53E3E');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // calculateSoftness
  // ─────────────────────────────────────────────────────────────────────────

  describe('calculateSoftness', () => {
    it('should return tight for < 25 PFP', () => {
      expect(calculateSoftness(20)).toBe('tight');
    });

    it('should return average for 25-35 PFP', () => {
      expect(calculateSoftness(30)).toBe('average');
    });

    it('should return soft for 35-50 PFP', () => {
      expect(calculateSoftness(45)).toBe('soft');
    });

    it('should return very_soft for ≥ 50 PFP', () => {
      expect(calculateSoftness(60)).toBe('very_soft');
    });

    it('boundary: exactly 25 is average', () => {
      expect(calculateSoftness(25)).toBe('average');
    });

    it('boundary: exactly 35 is soft', () => {
      expect(calculateSoftness(35)).toBe('soft');
    });

    it('boundary: exactly 50 is very_soft', () => {
      expect(calculateSoftness(50)).toBe('very_soft');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // RPC fallback behavior
  // ─────────────────────────────────────────────────────────────────────────

  describe('getArenaLobbyClubs', () => {
    it('should return empty array when RPC not available', async () => {
      const result = await getArenaLobbyClubs();
      expect(result).toEqual([]);
    });
  });

  describe('getClubTraffic', () => {
    it('should return null when RPC not available', async () => {
      const result = await getClubTraffic('some-club');
      expect(result).toBeNull();
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Service export shape
  // ─────────────────────────────────────────────────────────────────────────

  describe('ArenaLobbyEngine export', () => {
    it('should export all 8 methods', () => {
      expect(typeof ArenaLobbyEngine.getArenaLobbyClubs).toBe('function');
      expect(typeof ArenaLobbyEngine.getClubTraffic).toBe('function');
      expect(typeof ArenaLobbyEngine.getClubStakes).toBe('function');
      expect(typeof ArenaLobbyEngine.subscribeToClubTraffic).toBe('function');
      expect(typeof ArenaLobbyEngine.subscribeToLobbyTraffic).toBe('function');
      expect(typeof ArenaLobbyEngine.calculateHeatLevel).toBe('function');
      expect(typeof ArenaLobbyEngine.getHeatConfig).toBe('function');
      expect(typeof ArenaLobbyEngine.calculateSoftness).toBe('function');
    });
  });
});
