/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  UNIT TESTS — RoomService
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Tests message handler subscription/unsubscription, getPresence defaults,
 * isConnected, and broadcast safety when not connected.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mock dependencies ────────────────────────────────────────────────────

vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    channel: vi.fn().mockReturnValue({
      on: vi.fn().mockReturnThis(),
      subscribe: vi.fn().mockImplementation((cb) => {
        if (cb) cb('SUBSCRIBED');
        return Promise.resolve();
      }),
      track: vi.fn().mockResolvedValue(undefined),
      untrack: vi.fn().mockResolvedValue(undefined),
      send: vi.fn().mockResolvedValue(undefined),
      presenceState: vi.fn().mockReturnValue({}),
    }),
    removeChannel: vi.fn(),
  },
}));

// ─── Import AFTER mocks ──────────────────────────────────────────────────

import { roomService } from '../../src/services/RoomService';

describe('RoomService', () => {
  beforeEach(() => vi.clearAllMocks());

  describe('isConnected', () => {
    it('should return false for unknown table', () => {
      expect(roomService.isConnected('unknown-table')).toBe(false);
    });
  });

  describe('getPresence', () => {
    it('should return empty array for unknown table', () => {
      expect(roomService.getPresence('unknown-table')).toEqual([]);
    });
  });

  describe('onMessage', () => {
    it('should return unsubscribe function', () => {
      const handler = vi.fn();
      const unsub = roomService.onMessage('table-1', handler);
      expect(typeof unsub).toBe('function');
      unsub(); // Should not throw
    });
  });

  describe('broadcast', () => {
    it('should not crash when not connected to room', async () => {
      await roomService.broadcast('not-connected', {
        type: 'CHAT',
        payload: { message: 'test' },
        sender: 'user-1',
      });
      // No throw = pass (logs error but doesn't crash)
    });
  });

  describe('leaveRoom', () => {
    it('should not crash when leaving room not joined', async () => {
      await roomService.leaveRoom('never-joined');
      // No throw = pass
    });
  });
});
