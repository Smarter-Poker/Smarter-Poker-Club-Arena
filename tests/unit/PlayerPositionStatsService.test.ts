/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  UNIT TESTS — PlayerPositionStatsService
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Tests the processHand position stat parsing logic:
 * - VPIP: call/bet/raise/all-in detection preflop
 * - PFR: raise/all-in detection preflop
 * - 3-Bet / Fold-to-3-Bet: raise level tracking
 * - Bot filtering: bot_ prefix exclusion
 * - VIP points: 1 per hand played
 * - Empty/null guards
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mock dependencies ────────────────────────────────────────────────────

const mockRpc = vi.fn().mockResolvedValue({ data: null, error: null });
const mockEmit = vi.fn();

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
      rpc: (...args: any[]) => mockRpc(...args),
    },
  };
});

vi.mock('../../src/core/MasterBus', () => ({
  masterBus: {
    emit: (...args: any[]) => mockEmit(...args),
    subscribe: vi.fn(() => vi.fn()),
  },
}));

vi.mock('../../src/utils/retryAsync', () => ({
  retryAsync: <T>(fn: () => Promise<T>) => fn(),
}));

// ─── Import AFTER mocks ──────────────────────────────────────────────────

import { playerPositionStatsService } from '../../src/services/PlayerPositionStatsService';

describe('PlayerPositionStatsService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRpc.mockResolvedValue({ data: null, error: null });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // PROCESS HAND — BASIC
  // ─────────────────────────────────────────────────────────────────────────

  describe('processHand', () => {
    it('should call bulk_update_position_stats RPC with parsed data', async () => {
      await playerPositionStatsService.processHand({
        players: [{ id: 'p1', name: 'Alice', seat: 0, stack: 1000, position: 'BTN' }],
        actions: [{ seat: 0, action: 'raise', amount: 30, street: 'PREFLOP' }],
      });

      expect(mockRpc).toHaveBeenCalledWith('bulk_update_position_stats', {
        payload: expect.arrayContaining([
          expect.objectContaining({
            user_id: 'p1',
            position: 'BTN',
            hands_played: 1,
            vpip_count: 1,
            pfr_count: 1,
          }),
        ]),
      });
    });

    it('should filter out bot players (id starts with bot_)', async () => {
      await playerPositionStatsService.processHand({
        players: [
          { id: 'p1', name: 'Alice', seat: 0, stack: 1000, position: 'BTN' },
          { id: 'bot_1', name: 'Bot', seat: 1, stack: 1000, position: 'SB' },
        ],
        actions: [],
      });

      // Only p1 should be in the payload, not bot_1
      expect(mockRpc).toHaveBeenCalledWith(
        'bulk_update_position_stats',
        expect.objectContaining({
          payload: expect.arrayContaining([expect.objectContaining({ user_id: 'p1' })]),
        })
      );

      // Verify bot was NOT included
      const payload = mockRpc.mock.calls[0][1].payload;
      expect(payload.length).toBe(1);
      expect(payload[0].user_id).toBe('p1');
    });

    it('should skip players without position', async () => {
      await playerPositionStatsService.processHand({
        players: [{ id: 'p1', name: 'Alice', seat: 0, stack: 1000, position: '' }],
        actions: [],
      });

      // No RPC call since no valid players
      expect(mockRpc).not.toHaveBeenCalledWith('bulk_update_position_stats', expect.anything());
    });

    it('should not crash on empty players array', async () => {
      await expect(
        playerPositionStatsService.processHand({
          players: [],
          actions: [],
        })
      ).resolves.not.toThrow();
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // VPIP / PFR DETECTION
  // ─────────────────────────────────────────────────────────────────────────

  describe('VPIP / PFR detection', () => {
    it('should detect VPIP from call action', async () => {
      await playerPositionStatsService.processHand({
        players: [{ id: 'p1', name: 'Alice', seat: 0, stack: 1000, position: 'BTN' }],
        actions: [{ seat: 0, action: 'call', amount: 10, street: 'PREFLOP' }],
      });

      const payload = mockRpc.mock.calls[0][1].payload;
      expect(payload[0].vpip_count).toBe(1);
      expect(payload[0].pfr_count).toBe(0); // Call is not PFR
    });

    it('should detect PFR from raise action', async () => {
      await playerPositionStatsService.processHand({
        players: [{ id: 'p1', name: 'Alice', seat: 0, stack: 1000, position: 'BTN' }],
        actions: [{ seat: 0, action: 'raise', amount: 30, street: 'preflop' }],
      });

      const payload = mockRpc.mock.calls[0][1].payload;
      expect(payload[0].vpip_count).toBe(1); // Raise is also VPIP
      expect(payload[0].pfr_count).toBe(1);
    });

    it('should NOT detect VPIP from fold', async () => {
      await playerPositionStatsService.processHand({
        players: [{ id: 'p1', name: 'Alice', seat: 0, stack: 1000, position: 'BTN' }],
        actions: [{ seat: 0, action: 'fold', amount: 0, street: 'PREFLOP' }],
      });

      const payload = mockRpc.mock.calls[0][1].payload;
      expect(payload[0].vpip_count).toBe(0);
      expect(payload[0].pfr_count).toBe(0);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 3-BET DETECTION
  // ─────────────────────────────────────────────────────────────────────────

  describe('3-Bet detection', () => {
    it('should detect 3-bet when player re-raises at raiseLevel 3', async () => {
      await playerPositionStatsService.processHand({
        players: [
          { id: 'p1', name: 'Alice', seat: 0, stack: 1000, position: 'BTN' },
          { id: 'p2', name: 'Bob', seat: 1, stack: 1000, position: 'SB' },
        ],
        actions: [
          { seat: 0, action: 'raise', amount: 30, street: 'PREFLOP' }, // raise level 2
          { seat: 1, action: 'raise', amount: 90, street: 'PREFLOP' }, // raise level 3 = 3-bet
        ],
      });

      const payload = mockRpc.mock.calls[0][1].payload;
      const p2Stats = payload.find((p: any) => p.user_id === 'p2');
      expect(p2Stats.three_bet_count).toBe(1);
    });

    it('should detect fold-to-3-bet', async () => {
      await playerPositionStatsService.processHand({
        players: [
          { id: 'p1', name: 'Alice', seat: 0, stack: 1000, position: 'BTN' },
          { id: 'p2', name: 'Bob', seat: 1, stack: 1000, position: 'SB' },
        ],
        actions: [
          { seat: 0, action: 'raise', amount: 30, street: 'PREFLOP' }, // raise level 2
          { seat: 1, action: 'raise', amount: 90, street: 'PREFLOP' }, // raise level 3
          { seat: 0, action: 'fold', amount: 0, street: 'PREFLOP' }, // fold to 3-bet
        ],
      });

      const payload = mockRpc.mock.calls[0][1].payload;
      const p1Stats = payload.find((p: any) => p.user_id === 'p1');
      expect(p1Stats.fold_to_three_bet_count).toBe(1);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // VIP POINTS
  // ─────────────────────────────────────────────────────────────────────────

  describe('VIP points', () => {
    it('should emit VIP_POINTS_UPDATED for each player', async () => {
      await playerPositionStatsService.processHand({
        players: [
          { id: 'p1', name: 'Alice', seat: 0, stack: 1000, position: 'BTN' },
          { id: 'p2', name: 'Bob', seat: 1, stack: 500, position: 'SB' },
        ],
        actions: [],
      });

      expect(mockEmit).toHaveBeenCalledWith(
        'VIP_POINTS_UPDATED',
        expect.objectContaining({
          userId: 'p1',
          added: 1,
          source: 'hand_played',
        })
      );
      expect(mockEmit).toHaveBeenCalledWith(
        'VIP_POINTS_UPDATED',
        expect.objectContaining({
          userId: 'p2',
          added: 1,
          source: 'hand_played',
        })
      );
    });
  });
});
