/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  UNIT TESTS — OfflineQueueService
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Tests queue logic with db=null (IndexedDB not available):
 * - enqueue: returns false when db is null
 * - replayQueue: returns { replayed: 0, failed: 0 } when db is null
 * - dispose: safely handles null db and null handler
 * - concurrency guard: replayQueue blocks concurrent calls
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

import { OfflineQueueService } from '../../src/services/OfflineQueueService';

describe('OfflineQueueService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Ensure db is null for safe testing (no IndexedDB in Vitest)
    OfflineQueueService.db = null;
    OfflineQueueService._isReplaying = false;
    OfflineQueueService._onlineHandler = null;
  });

  // ─────────────────────────────────────────────────────────────────────────
  // ENQUEUE — db=null guard
  // ─────────────────────────────────────────────────────────────────────────

  describe('enqueue', () => {
    it('should return false when db is null', async () => {
      const result = await OfflineQueueService.enqueue({
        operationId: 'op-1',
        action: 'ADD_CHIPS',
        payload: { userId: 'u1', amount: 100, clubId: 'c1' },
      });
      expect(result).toBe(false);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // REPLAY — db=null guard
  // ─────────────────────────────────────────────────────────────────────────

  describe('replayQueue', () => {
    it('should return { replayed: 0, failed: 0 } when db is null', async () => {
      const result = await OfflineQueueService.replayQueue();
      expect(result).toEqual({ replayed: 0, failed: 0 });
    });

    it('should block concurrent replay calls', async () => {
      OfflineQueueService._isReplaying = true;
      const result = await OfflineQueueService.replayQueue();
      expect(result).toEqual({ replayed: 0, failed: 0 });
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // DISPOSE — safe cleanup
  // ─────────────────────────────────────────────────────────────────────────

  describe('dispose', () => {
    it('should not throw when db and handler are null', () => {
      expect(() => OfflineQueueService.dispose()).not.toThrow();
    });

    it('should set db and handler to null after dispose', () => {
      OfflineQueueService.dispose();
      expect(OfflineQueueService.db).toBeNull();
      expect(OfflineQueueService._onlineHandler).toBeNull();
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // GETALL / GETCOUNT — db=null fallbacks
  // ─────────────────────────────────────────────────────────────────────────

  describe('getAll', () => {
    it('should return empty array when db is null', async () => {
      const result = await OfflineQueueService.getAll();
      expect(result).toEqual([]);
    });
  });

  describe('getCount', () => {
    it('should return 0 when db is null', async () => {
      const result = await OfflineQueueService.getCount();
      expect(result).toBe(0);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // MONEY MUTATIONS ARE NEITHER QUEUED NOR REPLAYED
  //
  // These are the tests the five-minute TTL never had. The TTL compared
  // `Date.now()` against a `createdAt` written by the same device's clock, so
  // it could only reject what the DEVICE believed was old. Nothing below
  // depends on a clock at all, which is the point: the refusal is
  // unconditional, so no clock skew, stale bookmark or restored tab can talk
  // its way past it.
  // ─────────────────────────────────────────────────────────────────────────

  describe('money mutations are refused at the door', () => {
    const moneyActions = [
      'ADD_CHIPS',
      'WITHDRAW_CHIPS',
      'CREDIT_COMMISSION',
      'CREDIT_RAKEBACK',
      'TABLE_BUYIN',
      'TABLE_REBUY',
    ] as const;

    it.each(moneyActions)('enqueue refuses %s even when the db is open', async (action) => {
      // A live db, so the refusal is the reason for the false - not the guard
      // at the top that returns false when IndexedDB is unavailable.
      OfflineQueueService.db = {} as IDBDatabase;
      const result = await OfflineQueueService.enqueue({
        operationId: `op-${action}`,
        action,
        payload: { p_amount: 1000 },
      });
      expect(result).toBe(false);
    });
  });

  describe('executeMutation never replays money, at any age', () => {
    const cases: Array<[string, number]> = [
      ['created one second ago', Date.now() - 1_000],
      ['created four minutes ago (inside the old TTL)', Date.now() - 4 * 60_000],
      ['created six minutes ago (outside the old TTL)', Date.now() - 6 * 60_000],
      ['created six months ago (a restored tab)', Date.now() - 180 * 24 * 60 * 60_000],
      ['created in the future (a clock that ran ahead)', Date.now() + 60 * 60_000],
      ['created at epoch zero (a clock that was reset)', 0],
    ];

    it.each(cases)('drops a TABLE_BUYIN %s', async (_label, createdAt) => {
      const dropped = await OfflineQueueService.executeMutation({
        id: 'm1',
        operationId: 'op-1',
        action: 'TABLE_BUYIN',
        payload: { p_amount: 1000 },
        createdAt,
        retries: 0,
      });
      // true means "remove from the queue and do not retry" - the entry is
      // drained rather than left to accumulate.
      expect(dropped).toBe(true);
    });

    it('drops a TABLE_REBUY the same way', async () => {
      const dropped = await OfflineQueueService.executeMutation({
        id: 'm2',
        operationId: 'op-2',
        action: 'TABLE_REBUY',
        payload: { p_amount: 500 },
        createdAt: Date.now(),
        retries: 0,
      });
      expect(dropped).toBe(true);
    });
  });
});
