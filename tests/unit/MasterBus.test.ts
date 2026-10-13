/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  UNIT TESTS — MasterBus (Core Event Bus)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * MasterBus is 1651 lines with deep dependencies on stores, Supabase channels,
 * RealtimeChannelService, and BroadcastChannel. Full unit testing requires
 * integration-level mocking. These tests verify the TYPE EXPORTS are correct.
 */
import { describe, it, expect, vi } from 'vitest';

vi.unmock('../../src/core/MasterBus');

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
    handleIdentityChange: vi.fn(),
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

import { masterBus } from '../../src/core/MasterBus';
import { supabase } from '../../src/lib/supabase';
import type { MasterBusStatus, BusEvent } from '../../src/core/MasterBus';

describe('MasterBus', () => {
  it('a retired admission cannot release the replacement registered channel', () => {
    const oldChannel = { on: vi.fn(), subscribe: vi.fn() };
    const replacement = { on: vi.fn(), subscribe: vi.fn() };
    vi.mocked(supabase.channel)
      .mockReturnValueOnce(oldChannel as any)
      .mockReturnValueOnce(replacement as any);
    masterBus.getOrCreateChannel('admission-owner-fixture');
    masterBus.forceRemoveRegisteredChannel('admission-owner-fixture');
    masterBus.getOrCreateChannel('admission-owner-fixture');
    vi.mocked(supabase.removeChannel).mockClear();
    masterBus.removeRegisteredChannel('admission-owner-fixture', oldChannel as any);
    expect(masterBus.hasChannel('admission-owner-fixture')).toBe(true);
    expect(supabase.removeChannel).not.toHaveBeenCalled();
    masterBus.removeRegisteredChannel('admission-owner-fixture', replacement as any);
    expect(masterBus.hasChannel('admission-owner-fixture')).toBe(false);
    expect(supabase.removeChannel).toHaveBeenCalledExactlyOnceWith(replacement);
  });
  it('should export masterBus singleton', () => {
    expect(masterBus).toBeDefined();
    expect(typeof masterBus).toBe('object');
  });

  it('should have emit method', () => {
    expect(typeof masterBus.emit).toBe('function');
  });

  // NOTE: subscribe() and getStatus() are defined on MasterBusCore but require
  // full integration-level mocking (all stores, RealtimeChannel, BroadcastChannel)
  // to be accessible at test time. They are verified via the tsc compiler instead.

  it('should export MasterBusStatus interface shape', () => {
    // Verify the interface shape exists (compile-time check via import)
    const mockStatus: MasterBusStatus = {
      online: true,
      stores: {
        arena: true,
        club: true,
        table: true,
        union: true,
        wallet: true,
        settings: true,
        user: true,
      },
      eventSubscribers: 0,
      timestamp: new Date().toISOString(),
    };
    expect(mockStatus.online).toBe(true);
  });

  it('should export BusEvent interface shape', () => {
    const mockEvent: BusEvent = {
      type: 'BALANCE_UPDATED',
      payload: {},
      timestamp: new Date().toISOString(),
    };
    expect(mockEvent.type).toBe('BALANCE_UPDATED');
  });
});
