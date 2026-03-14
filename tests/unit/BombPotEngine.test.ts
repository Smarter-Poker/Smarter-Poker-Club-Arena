/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  UNIT TESTS — BombPotEngine
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Tests bomb pot scheduling, ante calculation, and double-board pot distribution:
 * - initialize: creates default state
 * - shouldTrigger: hand/time frequency, minimum hand guard, ante = BB × multiplier
 * - complete: resets isActive flag
 * - generateDoubleBoard: non-mutating deck slice
 * - distributePot: same winner vs split, rounding safety
 * - getState/updateConfig/dispose: lifecycle
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mock dependencies ────────────────────────────────────────────────────

vi.mock('../../src/core/MasterBus', () => ({
  masterBus: {
    emit: vi.fn(),
    subscribe: vi.fn(() => vi.fn()),
  },
}));

// ─── Import AFTER mocks ──────────────────────────────────────────────────

import { bombPotEngine } from '../../src/services/BombPotEngine';

describe('BombPotEngine', () => {
  const defaultConfig = {
    enabled: true,
    frequency: 5,
    frequencyMinutes: 0,
    anteBBMultiplier: 3,
    doubleBoard: false,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    bombPotEngine.dispose('table-1'); // Clean slate
  });

  // ─────────────────────────────────────────────────────────────────────────
  // INITIALIZE
  // ─────────────────────────────────────────────────────────────────────────

  describe('initialize', () => {
    it('should create default state on initialize', () => {
      bombPotEngine.initialize('table-1', defaultConfig);
      const state = bombPotEngine.getState('table-1');
      expect(state).not.toBeNull();
      expect(state!.isActive).toBe(false);
      expect(state!.handsSinceLastBombPot).toBe(0);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // SHOULD TRIGGER
  // ─────────────────────────────────────────────────────────────────────────

  describe('shouldTrigger', () => {
    it('should NOT trigger when disabled', () => {
      bombPotEngine.initialize('table-1', { ...defaultConfig, enabled: false });
      const result = bombPotEngine.shouldTrigger('table-1', 10, 100);
      expect(result.triggered).toBe(false);
    });

    it('should NOT trigger before frequency threshold', () => {
      bombPotEngine.initialize('table-1', { ...defaultConfig, frequency: 5 });
      // Hands 1-4 should not trigger
      for (let i = 1; i <= 4; i++) {
        const result = bombPotEngine.shouldTrigger('table-1', 10, i);
        expect(result.triggered).toBe(false);
      }
    });

    it('should trigger at frequency threshold (every 5th hand)', () => {
      bombPotEngine.initialize('table-1', { ...defaultConfig, frequency: 5 });
      // Advance 5 hands
      for (let i = 1; i < 5; i++) {
        bombPotEngine.shouldTrigger('table-1', 10, i);
      }
      const result = bombPotEngine.shouldTrigger('table-1', 10, 5);
      expect(result.triggered).toBe(true);
    });

    it('should calculate ante as BB × multiplier', () => {
      bombPotEngine.initialize('table-1', { ...defaultConfig, frequency: 1 });
      const result = bombPotEngine.shouldTrigger('table-1', 20, 1);
      expect(result.triggered).toBe(true);
      expect(result.anteAmount).toBe(60); // 20 × 3
    });

    it('should NOT trigger before startAfterHand', () => {
      bombPotEngine.initialize('table-1', {
        ...defaultConfig,
        frequency: 1,
        startAfterHand: 10,
      });
      const result = bombPotEngine.shouldTrigger('table-1', 10, 5);
      expect(result.triggered).toBe(false);
    });

    it('should return null state for unknown table', () => {
      const result = bombPotEngine.shouldTrigger('unknown-table', 10, 1);
      expect(result.triggered).toBe(false);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // COMPLETE
  // ─────────────────────────────────────────────────────────────────────────

  describe('complete', () => {
    it('should set isActive to false', () => {
      bombPotEngine.initialize('table-1', { ...defaultConfig, frequency: 1 });
      bombPotEngine.shouldTrigger('table-1', 10, 1); // Triggers, sets isActive
      bombPotEngine.complete('table-1');
      const state = bombPotEngine.getState('table-1');
      expect(state!.isActive).toBe(false);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // GENERATE DOUBLE BOARD
  // ─────────────────────────────────────────────────────────────────────────

  describe('generateDoubleBoard', () => {
    it('should return two boards of 5 cards each', () => {
      const deck = ['As', 'Kh', 'Qd', 'Jc', 'Ts', '9h', '8d', '7c', '6s', '5h', '4d', '3c'];
      const [board1, board2] = bombPotEngine.generateDoubleBoard(deck);
      expect(board1.length).toBe(5);
      expect(board2.length).toBe(5);
    });

    it('should NOT mutate the original deck', () => {
      const deck = ['As', 'Kh', 'Qd', 'Jc', 'Ts', '9h', '8d', '7c', '6s', '5h'];
      const originalLength = deck.length;
      bombPotEngine.generateDoubleBoard(deck);
      expect(deck.length).toBe(originalLength);
    });

    it('should use non-overlapping cards for each board', () => {
      const deck = ['As', 'Kh', 'Qd', 'Jc', 'Ts', '9h', '8d', '7c', '6s', '5h'];
      const [board1, board2] = bombPotEngine.generateDoubleBoard(deck);
      const overlap = board1.filter((card) => board2.includes(card));
      expect(overlap.length).toBe(0);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // DISTRIBUTE POT
  // ─────────────────────────────────────────────────────────────────────────

  describe('distributePot', () => {
    it('should give entire pot to single winner of both boards', () => {
      const dist = bombPotEngine.distributePot(1000, 'player-1', 'player-1');
      expect(dist.get('player-1')).toBe(1000);
      expect(dist.size).toBe(1);
    });

    it('should split pot between two different winners', () => {
      const dist = bombPotEngine.distributePot(1000, 'p1', 'p2');
      expect(dist.get('p1')! + dist.get('p2')!).toBe(1000); // No rounding loss
    });

    it('should handle odd pot (rounding) without losing chips', () => {
      const dist = bombPotEngine.distributePot(1001, 'p1', 'p2');
      const total = dist.get('p1')! + dist.get('p2')!;
      expect(total).toBe(1001); // Remainder goes to board2 winner
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // LIFECYCLE
  // ─────────────────────────────────────────────────────────────────────────

  describe('lifecycle', () => {
    it('should return null for disposed table', () => {
      bombPotEngine.initialize('table-1', defaultConfig);
      bombPotEngine.dispose('table-1');
      expect(bombPotEngine.getState('table-1')).toBeNull();
    });

    it('should update config without resetting state', () => {
      bombPotEngine.initialize('table-1', defaultConfig);
      bombPotEngine.updateConfig('table-1', { anteBBMultiplier: 5 });
      // State should still exist
      expect(bombPotEngine.getState('table-1')).not.toBeNull();
    });
  });
});
