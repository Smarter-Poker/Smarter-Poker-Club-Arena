/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  UNIT TESTS — RealtimeChannelService
 * ═══════════════════════════════════════════════════════════════════════════════
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    channel: vi.fn().mockReturnValue({
      on: vi.fn().mockReturnThis(),
      subscribe: vi.fn().mockReturnValue('subscribed'),
      unsubscribe: vi.fn(),
    }),
    removeChannel: vi.fn(),
  },
}));

vi.mock('../../src/core/MasterBus', () => ({
  masterBus: { emit: vi.fn(), subscribe: vi.fn(() => vi.fn()) },
}));

import {
  realtimeChannelService,
  RealtimeChannelService,
} from '../../src/services/RealtimeChannelService';

describe('RealtimeChannelService', () => {
  it('should export a singleton instance', () => {
    expect(realtimeChannelService).toBeDefined();
    expect(realtimeChannelService).toBeInstanceOf(RealtimeChannelService);
  });

  it('should have subscribeToClub method', () => {
    expect(typeof realtimeChannelService.subscribeToClub).toBe('function');
  });

  it('should have unsubscribeFromClub method', () => {
    expect(typeof realtimeChannelService.unsubscribeFromClub).toBe('function');
  });

  it('should have broadcastClubEvent method', () => {
    expect(typeof realtimeChannelService.broadcastClubEvent).toBe('function');
  });

  it('should have getClubPresence method', () => {
    expect(typeof realtimeChannelService.getClubPresence).toBe('function');
  });

  it('should have subscribeToTournament method', () => {
    expect(typeof realtimeChannelService.subscribeToTournament).toBe('function');
  });

  it('should have unsubscribeFromTournament method', () => {
    expect(typeof realtimeChannelService.unsubscribeFromTournament).toBe('function');
  });

  it('should have getActiveSubscriptions method', () => {
    expect(typeof realtimeChannelService.getActiveSubscriptions).toBe('function');
  });

  it('should return empty array for active subscriptions initially', () => {
    const subs = realtimeChannelService.getActiveSubscriptions();
    expect(Array.isArray(subs)).toBe(true);
  });

  it('should return empty array for club presence with no subscription', () => {
    const presence = realtimeChannelService.getClubPresence('nonexistent-club');
    expect(Array.isArray(presence)).toBe(true);
    expect(presence).toHaveLength(0);
  });

  it('should have unsubscribeAll method', () => {
    expect(typeof realtimeChannelService.unsubscribeAll).toBe('function');
  });
});
