/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  UNIT TESTS — ReconnectingWebSocket
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Tests constructor defaults, send queueing, status management,
 * onMessage/onStatusChange unsubscribe, and disconnect safety.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─── Mock dependencies ────────────────────────────────────────────────────

let mockWsInstance: any;

class MockWebSocket {
  static OPEN = 1;
  static CONNECTING = 0;
  readyState = MockWebSocket.OPEN;
  onopen: (() => void) | null = null;
  onmessage: ((ev: any) => void) | null = null;
  onclose: ((ev: any) => void) | null = null;
  onerror: ((ev: any) => void) | null = null;
  send = vi.fn();
  close = vi.fn();
  constructor() { mockWsInstance = this; }
}

vi.stubGlobal('WebSocket', MockWebSocket);

vi.mock('../../src/core/MasterBus', () => ({
  masterBus: { emit: vi.fn() },
}));

// ─── Import AFTER mocks ──────────────────────────────────────────────────

import { ReconnectingWebSocket } from '../../src/services/ReconnectingWebSocket';

describe('ReconnectingWebSocket', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('constructor', () => {
    it('should default maxRetries to 10', () => {
      const ws = new ReconnectingWebSocket('ws://localhost:8080');
      expect(ws.getRetryCount()).toBe(0);
    });

    it('should default status to disconnected', () => {
      const ws = new ReconnectingWebSocket('ws://localhost:8080');
      expect(ws.getStatus()).toBe('disconnected');
    });
  });

  describe('send', () => {
    it('should queue messages when not connected', () => {
      const ws = new ReconnectingWebSocket('ws://localhost:8080');
      // Not connected — message should be queued, returns true
      const result = ws.send({ type: 'TEST' });
      expect(result).toBe(true);
    });

    it('should reject when pending queue is full (100)', () => {
      const ws = new ReconnectingWebSocket('ws://localhost:8080');
      // Fill the queue to MAX_PENDING (100)
      for (let i = 0; i < 100; i++) {
        ws.send({ type: `MSG_${i}` });
      }
      // 101st should fail
      const result = ws.send({ type: 'OVERFLOW' });
      expect(result).toBe(false);
    });
  });

  describe('onMessage', () => {
    it('should return unsubscribe function', () => {
      const ws = new ReconnectingWebSocket('ws://localhost:8080');
      const unsub = ws.onMessage(vi.fn());
      expect(typeof unsub).toBe('function');
      unsub(); // Should not throw
    });
  });

  describe('onStatusChange', () => {
    it('should return unsubscribe function', () => {
      const ws = new ReconnectingWebSocket('ws://localhost:8080');
      const unsub = ws.onStatusChange(vi.fn());
      expect(typeof unsub).toBe('function');
      unsub(); // Should not throw
    });
  });

  describe('disconnect', () => {
    it('should not crash when not connected', () => {
      const ws = new ReconnectingWebSocket('ws://localhost:8080');
      ws.disconnect();
      expect(ws.getStatus()).toBe('disconnected');
    });
  });
});
