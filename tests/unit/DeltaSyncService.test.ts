/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  UNIT TESTS — DeltaSyncService
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Tests incremental state synchronization:
 * - Snapshot full-state replacement
 * - Delta incremental merge
 * - Version gap detection → snapshot request
 * - Stale delta rejection
 * - Null sentinel key deletion
 * - Deep merge for nested objects
 * - createDelta static utility
 * - Change listener management
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DeltaSyncService } from '../../src/services/DeltaSyncService';

describe('DeltaSyncService', () => {
  let sync: DeltaSyncService<{ count: number; name: string; nested?: Record<string, unknown> }>;

  beforeEach(() => {
    sync = new DeltaSyncService({ count: 0, name: 'initial' });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // INITIAL STATE
  // ─────────────────────────────────────────────────────────────────────────

  describe('initial state', () => {
    it('should start at version 0', () => {
      expect(sync.getVersion()).toBe(0);
    });

    it('should return initial data', () => {
      expect(sync.getState()).toEqual({ count: 0, name: 'initial' });
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // SNAPSHOT
  // ─────────────────────────────────────────────────────────────────────────

  describe('SNAPSHOT messages', () => {
    it('should replace entire state', () => {
      const result = sync.processMessage({
        type: 'SNAPSHOT',
        version: 5,
        data: { count: 100, name: 'snapshot' },
      });
      expect(result.applied).toBe(true);
      expect(sync.getState()).toEqual({ count: 100, name: 'snapshot' });
      expect(sync.getVersion()).toBe(5);
    });

    it('should report all keys as changed', () => {
      const result = sync.processMessage({
        type: 'SNAPSHOT',
        version: 1,
        data: { count: 1, name: 'a', extra: true },
      });
      expect(result.changedKeys).toEqual(expect.arrayContaining(['count', 'name', 'extra']));
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // DELTA
  // ─────────────────────────────────────────────────────────────────────────

  describe('DELTA messages', () => {
    it('should merge changed fields only', () => {
      sync.processMessage({ type: 'DELTA', version: 1, data: { count: 42 } });
      expect(sync.getState().count).toBe(42);
      expect(sync.getState().name).toBe('initial'); // unchanged
    });

    it('should advance version', () => {
      sync.processMessage({ type: 'DELTA', version: 1, data: { count: 1 } });
      expect(sync.getVersion()).toBe(1);
    });

    it('should report only changed keys', () => {
      const result = sync.processMessage({ type: 'DELTA', version: 1, data: { name: 'updated' } });
      expect(result.changedKeys).toEqual(['name']);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // VERSION GAP
  // ─────────────────────────────────────────────────────────────────────────

  describe('version gap detection', () => {
    it('should reject delta with version gap and request snapshot', () => {
      const snapshotCb = vi.fn();
      sync.onSnapshotRequest(snapshotCb);

      // Skip version 1 — jump to version 3
      const result = sync.processMessage({ type: 'DELTA', version: 3, data: { count: 99 } });
      expect(result.applied).toBe(false);
      expect(snapshotCb).toHaveBeenCalled();
      expect(sync.getState().count).toBe(0); // state unchanged
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // STALE DELTA
  // ─────────────────────────────────────────────────────────────────────────

  describe('stale delta rejection', () => {
    it('should reject delta with version <= current', () => {
      sync.processMessage({ type: 'DELTA', version: 1, data: { count: 1 } });
      const result = sync.processMessage({ type: 'DELTA', version: 1, data: { count: 999 } });
      expect(result.applied).toBe(false);
      expect(sync.getState().count).toBe(1); // kept v1 value
    });

    it('should reject delta with version < current', () => {
      sync.processMessage({ type: 'SNAPSHOT', version: 5, data: { count: 5, name: 'v5' } });
      const result = sync.processMessage({ type: 'DELTA', version: 3, data: { count: 3 } });
      expect(result.applied).toBe(false);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // NULL SENTINEL (KEY DELETION)
  // ─────────────────────────────────────────────────────────────────────────

  describe('null sentinel deletion', () => {
    it('should delete key when delta sends null', () => {
      sync.processMessage({
        type: 'SNAPSHOT',
        version: 1,
        data: { count: 1, name: 'keep', nested: { a: 1 } },
      });
      sync.processMessage({ type: 'DELTA', version: 2, data: { nested: null } });
      expect(sync.getState().nested).toBeUndefined();
      expect(sync.getState().name).toBe('keep');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // DEEP MERGE
  // ─────────────────────────────────────────────────────────────────────────

  describe('deep merge for nested objects', () => {
    it('should merge nested object fields without clobbering', () => {
      sync.processMessage({
        type: 'SNAPSHOT',
        version: 1,
        data: { count: 0, name: 'x', nested: { a: 1, b: 2 } },
      });
      sync.processMessage({ type: 'DELTA', version: 2, data: { nested: { b: 99 } } });
      expect((sync.getState().nested as any).a).toBe(1); // preserved
      expect((sync.getState().nested as any).b).toBe(99); // updated
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // createDelta (static)
  // ─────────────────────────────────────────────────────────────────────────

  describe('createDelta', () => {
    it('should detect changed fields', () => {
      const delta = DeltaSyncService.createDelta({ a: 1, b: 'old' }, { a: 1, b: 'new' }, 2);
      expect(delta).not.toBeNull();
      expect(delta!.data.b).toBe('new');
      expect(delta!.data.a).toBeUndefined(); // unchanged
    });

    it('should return null when no changes', () => {
      const delta = DeltaSyncService.createDelta({ a: 1 }, { a: 1 }, 2);
      expect(delta).toBeNull();
    });

    it('should detect removed keys with null sentinel', () => {
      const delta = DeltaSyncService.createDelta({ a: 1, b: 2 }, { a: 1 }, 2);
      expect(delta!.data.b).toBeNull();
    });

    it('should include correct version and type', () => {
      const delta = DeltaSyncService.createDelta({ x: 1 }, { x: 2 }, 7);
      expect(delta!.type).toBe('DELTA');
      expect(delta!.version).toBe(7);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // CHANGE LISTENERS
  // ─────────────────────────────────────────────────────────────────────────

  describe('change listeners', () => {
    it('should notify listener on state change', () => {
      const listener = vi.fn();
      sync.onChange(listener);
      sync.processMessage({ type: 'DELTA', version: 1, data: { count: 5 } });
      expect(listener).toHaveBeenCalledWith({ count: 5, name: 'initial' }, ['count']);
    });

    it('should support unsubscribe', () => {
      const listener = vi.fn();
      const unsub = sync.onChange(listener);
      unsub();
      sync.processMessage({ type: 'DELTA', version: 1, data: { count: 5 } });
      expect(listener).not.toHaveBeenCalled();
    });

    it('should handle listener errors gracefully', () => {
      const badListener = vi.fn(() => {
        throw new Error('boom');
      });
      const goodListener = vi.fn();
      sync.onChange(badListener);
      sync.onChange(goodListener);
      // Should not throw
      sync.processMessage({ type: 'DELTA', version: 1, data: { count: 1 } });
      expect(goodListener).toHaveBeenCalled();
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // UNKNOWN MESSAGE TYPE
  // ─────────────────────────────────────────────────────────────────────────

  describe('unknown message type', () => {
    it('should return applied=false for unknown type', () => {
      const result = sync.processMessage({ type: 'UNKNOWN' as any, version: 1, data: {} });
      expect(result.applied).toBe(false);
    });
  });
});
