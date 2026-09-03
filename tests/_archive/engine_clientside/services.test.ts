/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  UNIT TESTS — New Engine Services & Utilities
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Covers: DeltaSyncService, RateLimiter, HandValidationService,
 *         AntiCollusionService (score calculations)
 *
 * NOTE: Services that depend on Supabase, IndexedDB or real WebSocket
 *       have their pure-logic functions tested here. Integration tests
 *       that need real I/O are deferred to E2E.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ═══════════════════════════════════════════════════════════════════════════════
// 1. DELTA SYNC SERVICE
// ═══════════════════════════════════════════════════════════════════════════════

import { DeltaSyncService } from '../../src/services/DeltaSyncService';

describe('DeltaSyncService', () => {
  let sync: DeltaSyncService<{ pot: number; players: string[]; meta: { level: number } }>;

  beforeEach(() => {
    sync = new DeltaSyncService({ pot: 0, players: [] as string[], meta: { level: 1 } });
  });

  describe('processMessage — SNAPSHOT', () => {
    it('replaces entire state and updates version', () => {
      const result = sync.processMessage({
        type: 'SNAPSHOT',
        version: 5,
        data: { pot: 100, players: ['A', 'B'], meta: { level: 3 } },
      });
      expect(result.applied).toBe(true);
      expect(result.changedKeys).toEqual(['pot', 'players', 'meta']);
      expect(sync.getState().pot).toBe(100);
      expect(sync.getVersion()).toBe(5);
    });
  });

  describe('processMessage — DELTA', () => {
    it('applies delta update to existing state', () => {
      sync.processMessage({
        type: 'SNAPSHOT',
        version: 1,
        data: { pot: 50, players: ['A'], meta: { level: 1 } },
      });
      const result = sync.processMessage({ type: 'DELTA', version: 2, data: { pot: 100 } });
      expect(result.applied).toBe(true);
      expect(result.changedKeys).toEqual(['pot']);
      expect(sync.getState().pot).toBe(100);
      expect(sync.getState().players).toEqual(['A']); // unchanged
      expect(sync.getVersion()).toBe(2);
    });

    it('deep merges nested objects', () => {
      sync.processMessage({
        type: 'SNAPSHOT',
        version: 1,
        data: { pot: 50, players: [], meta: { level: 1 } },
      });
      const result = sync.processMessage({
        type: 'DELTA',
        version: 2,
        data: { meta: { level: 5 } },
      });
      expect(result.applied).toBe(true);
      expect(sync.getState().meta).toEqual({ level: 5 });
    });

    it('rejects stale/duplicate deltas', () => {
      sync.processMessage({
        type: 'SNAPSHOT',
        version: 3,
        data: { pot: 50, players: [], meta: { level: 1 } },
      });
      const result = sync.processMessage({ type: 'DELTA', version: 2, data: { pot: 999 } });
      expect(result.applied).toBe(false);
      expect(sync.getState().pot).toBe(50); // unchanged
    });

    it('requests snapshot on version gap', () => {
      const snapshotFn = vi.fn();
      sync.onSnapshotRequest(snapshotFn);
      sync.processMessage({
        type: 'SNAPSHOT',
        version: 1,
        data: { pot: 10, players: [], meta: { level: 1 } },
      });
      const result = sync.processMessage({ type: 'DELTA', version: 5, data: { pot: 999 } }); // gap: 1 -> 5
      expect(result.applied).toBe(false);
      expect(snapshotFn).toHaveBeenCalledTimes(1);
    });

    it('processes consecutive version correctly', () => {
      sync.processMessage({
        type: 'SNAPSHOT',
        version: 1,
        data: { pot: 10, players: [], meta: { level: 1 } },
      });
      const result = sync.processMessage({ type: 'DELTA', version: 2, data: { pot: 20 } });
      expect(result.applied).toBe(true);
      expect(sync.getVersion()).toBe(2);
    });
  });

  describe('onChange', () => {
    it('notifies listeners on state change', () => {
      const listener = vi.fn();
      sync.onChange(listener);
      sync.processMessage({
        type: 'SNAPSHOT',
        version: 1,
        data: { pot: 100, players: [], meta: { level: 1 } },
      });
      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener).toHaveBeenCalledWith(expect.objectContaining({ pot: 100 }), [
        'pot',
        'players',
        'meta',
      ]);
    });

    it('returns unsubscribe function', () => {
      const listener = vi.fn();
      const unsub = sync.onChange(listener);
      unsub();
      sync.processMessage({
        type: 'SNAPSHOT',
        version: 1,
        data: { pot: 100, players: [], meta: { level: 1 } },
      });
      expect(listener).not.toHaveBeenCalled();
    });
  });

  describe('createDelta (static)', () => {
    it('detects changed keys', () => {
      const oldState = { pot: 50, players: ['A'] };
      const newState = { pot: 100, players: ['A'] };
      const delta = DeltaSyncService.createDelta(oldState, newState, 3);
      expect(delta).not.toBeNull();
      expect(delta!.type).toBe('DELTA');
      expect(delta!.version).toBe(3);
      expect(delta!.data).toEqual({ pot: 100 });
    });

    it('returns null if no changes', () => {
      const state = { pot: 50, players: ['A'] };
      const delta = DeltaSyncService.createDelta(state, state, 3);
      expect(delta).toBeNull();
    });
  });

  describe('getTimeSinceSync', () => {
    it('returns time since last sync', () => {
      sync.processMessage({
        type: 'SNAPSHOT',
        version: 1,
        data: { pot: 0, players: [], meta: { level: 1 } },
      });
      const elapsed = sync.getTimeSinceSync();
      expect(elapsed).toBeGreaterThanOrEqual(0);
      expect(elapsed).toBeLessThan(100); // should be nearly instant
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 2. RATE LIMITER
// ═══════════════════════════════════════════════════════════════════════════════

import { RateLimiter, RATE_LIMITS } from '../../src/utils/RateLimiter';

describe('RateLimiter', () => {
  let limiter: RateLimiter;

  beforeEach(() => {
    limiter = new RateLimiter();
  });

  afterEach(() => {
    limiter.dispose();
  });

  describe('check', () => {
    it('allows requests within limit', () => {
      const result = limiter.check('test', 'user1', 3, 60000);
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(2);
      expect(result.total).toBe(3);
    });

    it('blocks requests exceeding limit', () => {
      limiter.check('test', 'user1', 2, 60000);
      limiter.check('test', 'user1', 2, 60000);
      const result = limiter.check('test', 'user1', 2, 60000);
      expect(result.allowed).toBe(false);
      expect(result.remaining).toBe(0);
      expect(result.retryAfterMs).toBeGreaterThan(0);
    });

    it('deduplicates by action + userId', () => {
      limiter.check('action_a', 'user1', 2, 60000);
      limiter.check('action_b', 'user1', 2, 60000);
      // Different actions — both should still have remaining
      const result = limiter.check('action_a', 'user1', 2, 60000);
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(0);
    });
  });

  describe('checkPreset', () => {
    it('uses preset limits for BUY_IN', () => {
      const result = limiter.checkPreset('BUY_IN', 'user1');
      expect(result.allowed).toBe(true);
      expect(result.total).toBe(RATE_LIMITS.BUY_IN.maxPerWindow);
    });
  });

  describe('reset', () => {
    it('clears rate limit for specific action/user', () => {
      limiter.check('test', 'user1', 1, 60000); // use up the limit
      const blocked = limiter.check('test', 'user1', 1, 60000);
      expect(blocked.allowed).toBe(false);

      limiter.reset('test', 'user1');
      const afterReset = limiter.check('test', 'user1', 1, 60000);
      expect(afterReset.allowed).toBe(true);
    });
  });

  describe('resetUser', () => {
    it('clears all rate limits for a user', () => {
      limiter.check('a', 'user1', 1, 60000);
      limiter.check('b', 'user1', 1, 60000);
      limiter.resetUser('user1');
      expect(limiter.check('a', 'user1', 1, 60000).allowed).toBe(true);
      expect(limiter.check('b', 'user1', 1, 60000).allowed).toBe(true);
    });
  });

  describe('getUsage', () => {
    it('returns current usage count', () => {
      limiter.check('test', 'user1', 10, 60000);
      limiter.check('test', 'user1', 10, 60000);
      expect(limiter.getUsage('test', 'user1', 60000)).toBe(2);
    });

    it('returns 0 for non-existent key', () => {
      expect(limiter.getUsage('test', 'nobody', 60000)).toBe(0);
    });
  });

  describe('dispose', () => {
    it('clears all entries and timer', () => {
      limiter.check('test', 'user1', 5, 60000);
      limiter.dispose();
      expect(limiter.getUsage('test', 'user1', 60000)).toBe(0);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 3. HAND VALIDATION SERVICE (pure logic)
// ═══════════════════════════════════════════════════════════════════════════════

import {
  HandValidationService,
  type HandValidationInput,
} from '../../src/services/HandValidationService';

describe('HandValidationService', () => {
  const validInput: HandValidationInput = {
    handId: 'hand-1',
    tableId: 'table-1',
    communityCards: ['As', 'Kd', 'Qh', 'Jc', 'Ts'],
    players: [
      { id: 'p1', holeCards: ['Ah', 'Ad'], betTotal: 100, isAllIn: false, isFolded: false },
      { id: 'p2', holeCards: ['Kh', 'Kc'], betTotal: 100, isAllIn: false, isFolded: true },
    ],
    pots: [{ amount: 200, eligiblePlayerIds: ['p1', 'p2'], winnerId: 'p1' }],
    reportedWinners: [{ playerId: 'p1', amount: 200 }],
  };

  describe('validate — valid hand', () => {
    it('returns valid=true with no discrepancies', () => {
      const result = HandValidationService.validate(validInput);
      expect(result.valid).toBe(true);
      expect(result.discrepancies).toHaveLength(0);
    });
  });

  describe('validate — pot mismatch', () => {
    it('detects total bets ≠ total pots', () => {
      const input: HandValidationInput = {
        ...validInput,
        pots: [{ amount: 150, eligiblePlayerIds: ['p1', 'p2'], winnerId: 'p1' }],
        reportedWinners: [{ playerId: 'p1', amount: 150 }],
      };
      const result = HandValidationService.validate(input);
      expect(result.valid).toBe(false);
      expect(result.discrepancies[0].type).toBe('POT_MISMATCH');
    });
  });

  describe('validate — winnings mismatch', () => {
    it('detects total winnings ≠ total pots', () => {
      const input: HandValidationInput = {
        ...validInput,
        reportedWinners: [{ playerId: 'p1', amount: 250 }], // mismatch: pot is 200
      };
      const result = HandValidationService.validate(input);
      expect(result.valid).toBe(false);
      const types = result.discrepancies.map((d) => d.type);
      expect(types).toContain('AMOUNT_MISMATCH');
    });
  });

  describe('validate — folded winner', () => {
    it('detects winner who is marked as folded', () => {
      const input: HandValidationInput = {
        ...validInput,
        pots: [{ amount: 200, eligiblePlayerIds: ['p1', 'p2'], winnerId: 'p2' }],
        reportedWinners: [{ playerId: 'p2', amount: 200 }],
      };
      const result = HandValidationService.validate(input);
      expect(result.valid).toBe(false);
      const types = result.discrepancies.map((d) => d.type);
      expect(types).toContain('WINNER_MISMATCH');
    });
  });

  describe('validate — ineligible winner', () => {
    it('detects winner not in eligible list', () => {
      const input: HandValidationInput = {
        ...validInput,
        players: [
          { id: 'p1', holeCards: ['Ah', 'Ad'], betTotal: 100, isAllIn: false, isFolded: false },
          { id: 'p2', holeCards: ['Kh', 'Kc'], betTotal: 100, isAllIn: false, isFolded: false },
        ],
        pots: [{ amount: 200, eligiblePlayerIds: ['p1'], winnerId: 'p2' }],
        reportedWinners: [{ playerId: 'p2', amount: 200 }],
      };
      const result = HandValidationService.validate(input);
      expect(result.valid).toBe(false);
      const types = result.discrepancies.map((d) => d.type);
      expect(types).toContain('SIDE_POT_ERROR');
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 4. ANTI-COLLUSION SERVICE (score calculation — pure logic)
// ═══════════════════════════════════════════════════════════════════════════════

import { AntiCollusionService, type CollusionEvent } from '../../src/services/AntiCollusionService';

describe('AntiCollusionService — calculateScore', () => {
  it('calculates base score for FOLD_TO_PLAYER', () => {
    const event: CollusionEvent = {
      playerA: 'a',
      playerB: 'b',
      patternType: 'FOLD_TO_PLAYER',
      evidence: {},
      timestamp: Date.now(),
    };
    const score = AntiCollusionService.calculateScore(event);
    expect(score).toBe(25); // base score, no multiplier
  });

  it('calculates higher score for CHIP_DUMP', () => {
    const event: CollusionEvent = {
      playerA: 'a',
      playerB: 'b',
      patternType: 'CHIP_DUMP',
      evidence: {},
      timestamp: Date.now(),
    };
    const score = AntiCollusionService.calculateScore(event);
    expect(score).toBe(40); // base CHIP_DUMP score
  });

  it('amplifies score based on fold rate + pot size evidence', () => {
    const event: CollusionEvent = {
      playerA: 'a',
      playerB: 'b',
      patternType: 'FOLD_TO_PLAYER',
      evidence: { foldRate: 90, potSize: 200 },
      timestamp: Date.now(),
    };
    const score = AntiCollusionService.calculateScore(event);
    // foldRate 90/100=0.9, potSize 200/100=2.0 capped→2.0, multiplier=0.9*2.0=1.8
    // 25 * 1.8 = 45
    expect(score).toBe(45);
  });

  it('amplifies score based on pot size evidence', () => {
    const event: CollusionEvent = {
      playerA: 'a',
      playerB: 'b',
      patternType: 'CHIP_DUMP',
      evidence: { potSize: 200 },
      timestamp: Date.now(),
    };
    const score = AntiCollusionService.calculateScore(event);
    expect(score).toBe(80); // 40 base * 2.0 cap for potSize
  });

  it('caps score at 100', () => {
    const event: CollusionEvent = {
      playerA: 'a',
      playerB: 'b',
      patternType: 'CHIP_DUMP',
      evidence: { potSize: 1000, foldRate: 100 },
      timestamp: Date.now(),
    };
    const score = AntiCollusionService.calculateScore(event);
    expect(score).toBeLessThanOrEqual(100);
  });

  it('handles COORDINATED_SEATING with lower base', () => {
    const event: CollusionEvent = {
      playerA: 'a',
      playerB: 'b',
      patternType: 'COORDINATED_SEATING',
      evidence: {},
      timestamp: Date.now(),
    };
    expect(AntiCollusionService.calculateScore(event)).toBe(15);
  });
});
