/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  UNIT TESTS — SnapshotService
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Tests the in-memory hand snapshot lifecycle:
 * - startHand / startStreet / recordAction / completeHand
 * - Buffer cap (maxPerTable = 50)
 * - getSnapshots / getSnapshot by handId
 * - exportAsText: full hand notation export
 * - getReplaySteps: step-by-step action replay
 * - dispose: memory cleanup
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

import { snapshotService } from '../../src/services/SnapshotService';

describe('SnapshotService', () => {
  const defaultPlayers = [
    {
      userId: 'p1',
      displayName: 'Alice',
      seatIndex: 0,
      chips: 1000,
      isActive: true,
      isFolded: false,
      isAllIn: false,
      currentBet: 0,
    },
    {
      userId: 'p2',
      displayName: 'Bob',
      seatIndex: 1,
      chips: 500,
      isActive: true,
      isFolded: false,
      isAllIn: false,
      currentBet: 0,
    },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    snapshotService.dispose('table-1');
    snapshotService.dispose('table-2');
  });

  // ─────────────────────────────────────────────────────────────────────────
  // HAND LIFECYCLE
  // ─────────────────────────────────────────────────────────────────────────

  describe('hand lifecycle', () => {
    it('should create and complete a hand snapshot', () => {
      snapshotService.startHand('table-1', 'hand-1', 1, {
        gameType: 'NLH',
        smallBlind: 5,
        bigBlind: 10,
        ante: 0,
        dealerSeat: 0,
        players: defaultPlayers,
      });

      const result = snapshotService.completeHand('table-1', [{ userId: 'p1', amount: 100 }], 100);

      expect(result).not.toBeNull();
      expect(result!.handId).toBe('hand-1');
      expect(result!.gameType).toBe('NLH');
      expect(result!.smallBlind).toBe(5);
      expect(result!.bigBlind).toBe(10);
      expect(result!.winners.length).toBe(1);
      expect(result!.totalPot).toBe(100);
    });

    it('should return null for completeHand on unknown table', () => {
      expect(snapshotService.completeHand('unknown', [], 0)).toBeNull();
    });

    it('should record streets and actions', () => {
      snapshotService.startHand('table-1', 'hand-1', 1, {
        gameType: 'NLH',
        smallBlind: 5,
        bigBlind: 10,
        ante: 0,
        dealerSeat: 0,
        players: defaultPlayers,
      });

      snapshotService.startStreet('table-1', 'preflop', [], 15, [
        { userId: 'p1', chips: 995, currentBet: 5 },
        { userId: 'p2', chips: 490, currentBet: 10 },
      ]);

      snapshotService.recordAction('table-1', {
        playerUserId: 'p1',
        action: 'raise',
        amount: 30,
        timestamp: Date.now(),
      });

      snapshotService.recordAction('table-1', {
        playerUserId: 'p2',
        action: 'call',
        amount: 30,
        timestamp: Date.now(),
      });

      snapshotService.startStreet('table-1', 'flop', ['As', 'Kh', 'Qd'], 60, [
        { userId: 'p1', chips: 965, currentBet: 0 },
        { userId: 'p2', chips: 460, currentBet: 0 },
      ]);

      const result = snapshotService.completeHand(
        'table-1',
        [{ userId: 'p1', amount: 100, handRank: 'Pair' }],
        100
      );

      expect(result!.streets.length).toBe(2);
      expect(result!.streets[0].street).toBe('preflop');
      expect(result!.streets[0].actions.length).toBe(2);
      expect(result!.streets[1].street).toBe('flop');
      expect(result!.streets[1].board).toEqual(['As', 'Kh', 'Qd']);
    });

    it('should not record action when no hand is active', () => {
      snapshotService.recordAction('table-1', {
        playerUserId: 'p1',
        action: 'fold',
        amount: 0,
        timestamp: Date.now(),
      });
      // No crash = safe guard
      expect(snapshotService.getSnapshots('table-1').length).toBe(0);
    });

    it('should not record action when no street started', () => {
      snapshotService.startHand('table-1', 'hand-1', 1, {
        gameType: 'NLH',
        smallBlind: 5,
        bigBlind: 10,
        ante: 0,
        dealerSeat: 0,
        players: defaultPlayers,
      });

      // Record action without starting a street
      snapshotService.recordAction('table-1', {
        playerUserId: 'p1',
        action: 'bet',
        amount: 50,
        timestamp: Date.now(),
      });

      const result = snapshotService.completeHand('table-1', [], 0);
      expect(result!.streets.length).toBe(0);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // BUFFER CAP
  // ─────────────────────────────────────────────────────────────────────────

  describe('buffer cap', () => {
    it('should limit snapshots to 50 per table', () => {
      for (let i = 0; i < 55; i++) {
        snapshotService.startHand('table-1', `hand-${i}`, i, {
          gameType: 'NLH',
          smallBlind: 5,
          bigBlind: 10,
          ante: 0,
          dealerSeat: 0,
          players: defaultPlayers,
        });
        snapshotService.completeHand('table-1', [{ userId: 'p1', amount: 10 }], 10);
      }

      const snapshots = snapshotService.getSnapshots('table-1');
      expect(snapshots.length).toBe(50);
      // Oldest (hand-0 through hand-4) should be evicted
      expect(snapshots[0].handId).toBe('hand-5');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // GET SNAPSHOT
  // ─────────────────────────────────────────────────────────────────────────

  describe('getSnapshot', () => {
    it('should find snapshot by handId', () => {
      snapshotService.startHand('table-1', 'hand-42', 42, {
        gameType: 'PLO',
        smallBlind: 10,
        bigBlind: 20,
        ante: 5,
        dealerSeat: 1,
        players: defaultPlayers,
      });
      snapshotService.completeHand('table-1', [], 0);

      const found = snapshotService.getSnapshot('table-1', 'hand-42');
      expect(found).not.toBeNull();
      expect(found!.handNumber).toBe(42);
      expect(found!.gameType).toBe('PLO');
    });

    it('should return null for unknown handId', () => {
      expect(snapshotService.getSnapshot('table-1', 'nonexistent')).toBeNull();
    });

    it('should return null for unknown tableId', () => {
      expect(snapshotService.getSnapshot('unknown', 'hand-1')).toBeNull();
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // EXPORT AS TEXT
  // ─────────────────────────────────────────────────────────────────────────

  describe('exportAsText', () => {
    it('should produce valid hand notation', () => {
      snapshotService.startHand('table-1', 'hand-1', 7, {
        gameType: 'NLH',
        smallBlind: 5,
        bigBlind: 10,
        ante: 0,
        dealerSeat: 0,
        players: defaultPlayers,
      });

      snapshotService.startStreet('table-1', 'preflop', [], 15, [
        { userId: 'p1', chips: 995, currentBet: 5 },
        { userId: 'p2', chips: 490, currentBet: 10 },
      ]);

      snapshotService.recordAction('table-1', {
        playerUserId: 'p1',
        action: 'raise',
        amount: 30,
        timestamp: Date.now(),
      });

      const snapshot = snapshotService.completeHand(
        'table-1',
        [{ userId: 'p1', amount: 45, handRank: 'Pair of Aces' }],
        45
      )!;

      const text = snapshotService.exportAsText(snapshot);
      expect(text).toContain('=== Hand #7 ===');
      expect(text).toContain('NLH');
      expect(text).toContain('Blinds 5/10');
      expect(text).toContain('Alice');
      expect(text).toContain('PREFLOP');
      expect(text).toContain('raise');
      expect(text).toContain('Pair of Aces');
      expect(text).toContain('Total pot:');
    });

    it('should include ante line when ante > 0', () => {
      snapshotService.startHand('table-1', 'hand-1', 1, {
        gameType: 'NLH',
        smallBlind: 5,
        bigBlind: 10,
        ante: 2,
        dealerSeat: 0,
        players: defaultPlayers,
      });
      const snapshot = snapshotService.completeHand('table-1', [], 0)!;
      const text = snapshotService.exportAsText(snapshot);
      expect(text).toContain('Ante: 2');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // GET REPLAY STEPS
  // ─────────────────────────────────────────────────────────────────────────

  describe('getReplaySteps', () => {
    it('should start with "Hand dealt" step', () => {
      snapshotService.startHand('table-1', 'hand-1', 1, {
        gameType: 'NLH',
        smallBlind: 5,
        bigBlind: 10,
        ante: 0,
        dealerSeat: 0,
        players: defaultPlayers,
      });
      const snapshot = snapshotService.completeHand('table-1', [], 0)!;
      const steps = snapshotService.getReplaySteps(snapshot);
      expect(steps[0].description).toBe('Hand dealt');
      expect(steps[0].step).toBe(0);
    });

    it('should include initial pot from blinds in first step', () => {
      snapshotService.startHand('table-1', 'hand-1', 1, {
        gameType: 'NLH',
        smallBlind: 5,
        bigBlind: 10,
        ante: 1,
        dealerSeat: 0,
        players: defaultPlayers,
      });
      const snapshot = snapshotService.completeHand('table-1', [], 0)!;
      const steps = snapshotService.getReplaySteps(snapshot);
      // pot = SB + BB + ante * players = 5 + 10 + 1*2 = 17
      expect(steps[0].pot).toBe(17);
    });

    it('should include street and action steps', () => {
      snapshotService.startHand('table-1', 'hand-1', 1, {
        gameType: 'NLH',
        smallBlind: 5,
        bigBlind: 10,
        ante: 0,
        dealerSeat: 0,
        players: defaultPlayers,
      });

      snapshotService.startStreet('table-1', 'preflop', [], 15, [
        { userId: 'p1', chips: 995, currentBet: 5 },
      ]);
      snapshotService.recordAction('table-1', {
        playerUserId: 'p1',
        action: 'raise',
        amount: 30,
        timestamp: Date.now(),
      });

      snapshotService.startStreet('table-1', 'flop', ['As', 'Kh', 'Qd'], 60, [
        { userId: 'p1', chips: 965, currentBet: 0 },
      ]);

      const snapshot = snapshotService.completeHand('table-1', [{ userId: 'p1', amount: 60 }], 60)!;

      const steps = snapshotService.getReplaySteps(snapshot);
      // Step 0: Hand dealt
      // Step 1: Alice raise (preflop action — no preflop street step)
      // Step 2: Flop board
      // Step 3: Result
      expect(steps.length).toBe(4);
      expect(steps[1].description).toContain('Alice');
      expect(steps[1].description).toContain('raise');
      expect(steps[2].description).toContain('Flop');
      expect(steps[3].description).toContain('Result');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // DISPOSE
  // ─────────────────────────────────────────────────────────────────────────

  describe('dispose', () => {
    it('should clear all data for a table', () => {
      snapshotService.startHand('table-1', 'hand-1', 1, {
        gameType: 'NLH',
        smallBlind: 5,
        bigBlind: 10,
        ante: 0,
        dealerSeat: 0,
        players: defaultPlayers,
      });
      snapshotService.completeHand('table-1', [], 0);
      snapshotService.dispose('table-1');
      expect(snapshotService.getSnapshots('table-1').length).toBe(0);
    });

    it('should not affect other tables', () => {
      snapshotService.startHand('table-1', 'hand-1', 1, {
        gameType: 'NLH',
        smallBlind: 5,
        bigBlind: 10,
        ante: 0,
        dealerSeat: 0,
        players: defaultPlayers,
      });
      snapshotService.completeHand('table-1', [], 0);

      snapshotService.startHand('table-2', 'hand-2', 1, {
        gameType: 'NLH',
        smallBlind: 5,
        bigBlind: 10,
        ante: 0,
        dealerSeat: 0,
        players: defaultPlayers,
      });
      snapshotService.completeHand('table-2', [], 0);

      snapshotService.dispose('table-1');
      expect(snapshotService.getSnapshots('table-1').length).toBe(0);
      expect(snapshotService.getSnapshots('table-2').length).toBe(1);
    });
  });
});
