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

  describe('findByOperationId', () => {
    it('should return undefined when db is null', async () => {
      const result = await OfflineQueueService.findByOperationId('op-1');
      expect(result).toBeUndefined();
    });
  });
});
