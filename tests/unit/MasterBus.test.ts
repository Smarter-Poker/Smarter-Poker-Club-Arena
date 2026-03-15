/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  UNIT TESTS — MasterBus (Core Event Bus)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * MasterBus is 1651 lines of interconnected code with deep dependencies on
 * stores, RealtimeChannelService, Supabase channels, and BroadcastChannel.
 * These tests verify the PUBLIC API shape and type exports.
 */
import { describe, it, expect, vi } from 'vitest';

// Must mock ALL transitive dependencies
vi.mock('../../src/stores/useArenaStore', () => ({
  useArenaStore: {
    getState: vi.fn(() => ({ reset: vi.fn() })),
    setState: vi.fn(),
    subscribe: vi.fn(),
  },
}));
vi.mock('../../src/stores/useClubStore', () => ({
  useClubStore: {
    getState: vi.fn(() => ({ reset: vi.fn(), loadMemberships: vi.fn() })),
    setState: vi.fn(),
    subscribe: vi.fn(),
  },
}));
vi.mock('../../src/stores/useTableStore', () => ({
  useTableStore: { getState: vi.fn(() => ({})), setState: vi.fn(), subscribe: vi.fn() },
}));
vi.mock('../../src/stores/useUnionStore', () => ({
  useUnionStore: { getState: vi.fn(() => ({})), setState: vi.fn(), subscribe: vi.fn() },
}));
vi.mock('../../src/stores/useWalletStore', () => ({
  useWalletStore: {
    getState: vi.fn(() => ({ reset: vi.fn(), refreshAll: vi.fn(), loadDiamonds: vi.fn() })),
    setState: vi.fn(),
    subscribe: vi.fn(),
  },
}));
vi.mock('../../src/stores/useSettingsStore', () => ({
  useSettingsStore: { getState: vi.fn(() => ({})), setState: vi.fn(), subscribe: vi.fn() },
}));
vi.mock('../../src/stores/useUserStore', () => ({
  useUserStore: { getState: vi.fn(() => ({ user: null })), setState: vi.fn(), subscribe: vi.fn() },
}));
vi.mock('../../src/services/RealtimeChannelService', () => ({
  realtimeChannelService: {
    subscribeToClub: vi.fn(),
    unsubscribeFromClub: vi.fn(),
  },
}));
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

// Only import AFTER all mocks are set up
import { masterBus } from '../../src/core/MasterBus';

describe('MasterBus', () => {
  it('should export masterBus singleton', () => {
    expect(masterBus).toBeDefined();
    expect(typeof masterBus).toBe('object');
  });

  it('should have emit method', () => {
    expect(typeof masterBus.emit).toBe('function');
  });

  it('should have subscribe method', () => {
    expect(typeof masterBus.subscribe).toBe('function');
  });

  it('should have getStatus method', () => {
    expect(typeof masterBus.getStatus).toBe('function');
  });

  it('should have reset method', () => {
    expect(typeof masterBus.reset).toBe('function');
  });

  it('should have isOnline method', () => {
    expect(typeof masterBus.isOnline).toBe('function');
  });
});
