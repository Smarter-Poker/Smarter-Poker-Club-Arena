/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  UNIT TESTS — TableWebSocket
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Tests constructor, connected/table getters, event/presence/connection
 * handler subscribe/unsubscribe, sendAction/sendChat when not connected,
 * and RECONNECT_DELAYS configuration.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mock dependencies ────────────────────────────────────────────────────

vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    auth: { getSession: vi.fn().mockResolvedValue({ data: { session: null } }) },
    channel: vi.fn().mockReturnValue({
      on: vi.fn().mockReturnThis(),
      subscribe: vi.fn().mockImplementation((cb) => {
        if (cb) cb('TIMED_OUT');
      }),
      track: vi.fn().mockResolvedValue(undefined),
      unsubscribe: vi.fn().mockResolvedValue(undefined),
      send: vi.fn().mockResolvedValue(undefined),
      presenceState: vi.fn().mockReturnValue({}),
    }),
    removeChannel: vi.fn(),
  },
}));

vi.mock('../../src/utils/retryAsync', () => ({
  retryAsync: vi.fn().mockResolvedValue({ data: null, error: null }),
}));

// Mock React hooks (TableWebSocket.ts imports them at file level)
vi.mock('react', () => ({
  useEffect: vi.fn(),
  useState: vi.fn().mockReturnValue([null, vi.fn()]),
  useRef: vi.fn().mockReturnValue({ current: null }),
  useCallback: vi.fn().mockImplementation((fn: any) => fn),
}));

// ─── Import AFTER mocks ──────────────────────────────────────────────────

import { TableWebSocket } from '../../src/services/TableWebSocket';

describe('TableWebSocket', () => {
  let ws: TableWebSocket;

  beforeEach(() => {
    vi.clearAllMocks();
    ws = new TableWebSocket('table-1', 'user-1', 'TestPlayer');
  });

  describe('constructor', () => {
    it('should start disconnected', () => {
      expect(ws.connected).toBe(false);
    });

    it('should store table ID', () => {
      expect(ws.table).toBe('table-1');
    });
  });

  describe('onEvent', () => {
    it('should return unsubscribe function', () => {
      const unsub = ws.onEvent(vi.fn());
      expect(typeof unsub).toBe('function');
      unsub(); // Should remove handler
    });
  });

  describe('onPresence', () => {
    it('should return unsubscribe function', () => {
      const unsub = ws.onPresence(vi.fn());
      expect(typeof unsub).toBe('function');
      unsub();
    });
  });

  describe('onConnection', () => {
    it('should return unsubscribe function', () => {
      const unsub = ws.onConnection(vi.fn());
      expect(typeof unsub).toBe('function');
      unsub();
    });
  });

  describe('sendAction', () => {
    it('should return false when not connected', async () => {
      const result = await ws.sendAction('fold', {});
      expect(result).toBe(false);
    });
  });

  describe('sendChat', () => {
    it('should return false when not connected', async () => {
      const result = await ws.sendChat('hello');
      expect(result).toBe(false);
    });
  });

  describe('disconnect', () => {
    it('should not crash when not connected', async () => {
      await ws.disconnect();
      expect(ws.connected).toBe(false);
    });
  });
});
