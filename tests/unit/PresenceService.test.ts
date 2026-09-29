/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  UNIT TESTS — PresenceService
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Tests channel lifecycle, getOnlineCount/getOnlineUsers, convenience wrappers,
 * and presence updates without periodic rebroadcasts.
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
      track: vi.fn().mockResolvedValue('ok'),
      untrack: vi.fn().mockResolvedValue(undefined),
      presenceState: vi.fn().mockReturnValue({}),
    }),
    removeChannel: vi.fn().mockResolvedValue(undefined),
  },
}));

// ─── Import AFTER mocks ──────────────────────────────────────────────────

import { presenceService } from '../../src/services/PresenceService';
import { supabase } from '../../src/lib/supabase';

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

  it('does not republish unchanged presence while the connection stays open', async () => {
    const channel = await presenceService.joinClub('quiet-club', 'user-1');
    expect(channel!.track).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000);
    expect(channel!.track).toHaveBeenCalledOnce();
  });

  it('keeps the scope and chosen status until an actual status change', async () => {
    const channel = await presenceService.joinClub('club-1', 'user-1');
    await presenceService.updateStatus('club:club-1', 'away');
    expect(channel!.track).toHaveBeenLastCalledWith({
      userId: 'user-1',
      clubId: 'club-1',
      status: 'away',
      lastSeen: expect.any(String),
    });
    await vi.advanceTimersByTimeAsync(2 * 60 * 1000);
    expect(channel!.track).toHaveBeenCalledTimes(2);
    expect(channel!.track).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'away' }));
  });

  it('retracks the latest presence when the SDK reconnects', async () => {
    const channel = await presenceService.joinClub('club-1', 'user-1');
    await presenceService.updateStatus('club:club-1', 'away');
    const onStatus = vi.mocked(channel!.subscribe).mock.calls[0][0]!;
    await onStatus('SUBSCRIBED');
    expect(channel!.track).toHaveBeenLastCalledWith(
      expect.objectContaining({
        userId: 'user-1',
        clubId: 'club-1',
        status: 'away',
      })
    );
    expect(channel!.track).toHaveBeenCalledTimes(3);
  });

  it('keeps each channel identity rather than using the last user who joined another channel', async () => {
    const channel = await presenceService.joinClub('club-1', 'user-1');
    await presenceService.joinUnion('union-1', 'user-2');
    await presenceService.updateStatus('club:club-1', 'playing');
    expect(channel!.track).toHaveBeenLastCalledWith(
      expect.objectContaining({
        userId: 'user-1',
        clubId: 'club-1',
        status: 'playing',
      })
    );
  });

  it('does not track again if a delayed subscription callback arrives after leaving', async () => {
    const channel = await presenceService.joinClub('club-1', 'user-1');
    const onStatus = vi.mocked(channel!.subscribe).mock.calls[0][0]!;
    await presenceService.leave('club:club-1');
    await onStatus('SUBSCRIBED');
    expect(channel!.track).toHaveBeenCalledOnce();
    expect(channel!.untrack).toHaveBeenCalledOnce();
    expect(supabase.removeChannel).toHaveBeenCalledWith(channel);
  });
});
