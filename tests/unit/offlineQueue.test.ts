/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  UNIT TESTS — offlineQueue
 * ═══════════════════════════════════════════════════════════════════════════════
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock localStorage
const store: Record<string, string> = {};
vi.stubGlobal('localStorage', {
  getItem: (k: string) => store[k] ?? null,
  setItem: (k: string, v: string) => {
    store[k] = v;
  },
  removeItem: (k: string) => {
    delete store[k];
  },
});

import {
  addToOfflineQueue,
  getOfflineQueue,
  clearOfflineQueue,
  getOfflineQueueSize,
  getMaxQueueSize,
} from '../../src/utils/offlineQueue';

describe('offlineQueue', () => {
  beforeEach(() => {
    clearOfflineQueue();
  });

  it('should start with empty queue', () => {
    expect(getOfflineQueue()).toEqual([]);
    expect(getOfflineQueueSize()).toBe(0);
  });

  it('should add a mutation to the queue', () => {
    addToOfflineQueue({
      id: '1',
      table: 'test',
      operation: 'INSERT',
      payload: { a: 1 },
      timestamp: Date.now(),
    });
    expect(getOfflineQueueSize()).toBe(1);
  });

  it('should persist across reads', () => {
    addToOfflineQueue({
      id: '2',
      table: 'test2',
      operation: 'UPDATE',
      payload: { b: 2 },
      timestamp: Date.now(),
    });
    const queue = getOfflineQueue();
    expect(queue.length).toBe(1);
    expect(queue[0].id).toBe('2');
  });

  it('should clear the queue', () => {
    addToOfflineQueue({
      id: '3',
      table: 'test3',
      operation: 'DELETE',
      payload: {},
      timestamp: Date.now(),
    });
    clearOfflineQueue();
    expect(getOfflineQueueSize()).toBe(0);
  });

  it('should report max queue size', () => {
    expect(getMaxQueueSize()).toBeGreaterThan(0);
  });

  it('should handle multiple items', () => {
    addToOfflineQueue({
      id: 'a',
      table: 't1',
      operation: 'INSERT',
      payload: {},
      timestamp: Date.now(),
    });
    addToOfflineQueue({
      id: 'b',
      table: 't2',
      operation: 'INSERT',
      payload: {},
      timestamp: Date.now(),
    });
    addToOfflineQueue({
      id: 'c',
      table: 't3',
      operation: 'INSERT',
      payload: {},
      timestamp: Date.now(),
    });
    expect(getOfflineQueueSize()).toBe(3);
  });
});
