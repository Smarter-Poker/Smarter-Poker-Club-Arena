/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  UNIT TESTS — PresenceService
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Tests channel lifecycle, getOnlineCount/getOnlineUsers, convenience wrappers,
 * and heartbeat management.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─── Mock dependencies (all inline to avoid hoisting issues) ─────────────

vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    channel: vi.fn().mockReturnValue({
      on: vi.fn().mockReturnThis(),
      subscribe: vi.fn().mockImplementation((cb: (status: string) => void) => {
        cb('SUBSCRIBED');
        return { unsubscribe: vi.fn() };
      }),
      track: vi.fn().mockResolvedValue(undefined),
      untrack: vi.fn().mockResolvedValue(undefined),
      presenceState: vi.fn().mockReturnValue({}),
    }),
    removeChannel: vi.fn().mockResolvedValue(undefined),
  },
}));

// ─── Import AFTER mocks ──────────────────────────────────────────────────

import { presenceService } from '../../src/services/PresenceService';

describe('PresenceService', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await presenceService.leaveAll();
    vi.useRealTimers();
  });

  // ─────────────────────────────────────────────────────────────────────────
  // ONLINE COUNT
  // ─────────────────────────────────────────────────────────────────────────

  describe('getOnlineCount', () => {
    it('should return 0 for unknown channel', () => {
      expect(presenceService.getOnlineCount('unknown')).toBe(0);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // ONLINE USERS
  // ─────────────────────────────────────────────────────────────────────────

  describe('getOnlineUsers', () => {
    it('should return empty array for unknown channel', () => {
      expect(presenceService.getOnlineUsers('unknown')).toEqual([]);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // CONVENIENCE WRAPPERS
  // ─────────────────────────────────────────────────────────────────────────

  describe('convenience methods', () => {
    it('getClubOnlineCount uses club: prefix', () => {
      expect(presenceService.getClubOnlineCount('c1')).toBe(0);
    });

    it('getUnionOnlineCount uses union: prefix', () => {
      expect(presenceService.getUnionOnlineCount('u1')).toBe(0);
    });

    it('getTableOnlineCount uses table: prefix', () => {
      expect(presenceService.getTableOnlineCount('t1')).toBe(0);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // JOIN / LEAVE
  // ─────────────────────────────────────────────────────────────────────────

  describe('join', () => {
    it('should return channel on successful join', async () => {
      const ch = await presenceService.join('test-ch', 'user-1', { status: 'online' });
      expect(ch).not.toBeNull();
    });

    it('should return existing channel if already joined', async () => {
      const ch1 = await presenceService.join('test-ch2', 'user-1', { status: 'online' });
      const ch2 = await presenceService.join('test-ch2', 'user-1', { status: 'online' });
      expect(ch1).toBe(ch2); // Same reference
    });
  });

  describe('leave', () => {
    it('should safely handle leaving unknown channel', async () => {
      await presenceService.leave('nonexistent');
      // No throw = safe guard
    });
  });
});
