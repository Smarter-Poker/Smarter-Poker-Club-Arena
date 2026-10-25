/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  UNIT TESTS — MasterBus (Core Event Bus)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * MasterBus is 1651 lines with deep dependencies on stores, Supabase channels,
 * RealtimeChannelService, and BroadcastChannel. Full unit testing requires
 * integration-level mocking. These tests verify the TYPE EXPORTS are correct.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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

describe('MasterBus browser navigation isolation', () => {
  let channel: {
    onmessage: ((event: { data: unknown }) => void) | null;
    postMessage: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
  };
  beforeEach(() => {
    vi.useFakeTimers();
    masterBus.reset();
    channel = { onmessage: null, postMessage: vi.fn(), close: vi.fn() };
    vi.stubGlobal(
      'BroadcastChannel',
      class {
        constructor() {
          return channel;
        }
      }
    );
    masterBus.init();
  });
  afterEach(() => {
    masterBus.reset();
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  const commands = [
    ['OPEN_OBSERVE_TABLE', { tableId: 'observed-table', tableName: 'Cash table' }],
    ['OPEN_HUB_TAB', { path: '/hub/social' }],
    ['OPEN_LOBBY_TAB', { requestedBy: 'table-header' }],
    ['OPEN_MUST_MOVE_LOBBY', { tableId: 'observed-table' }],
  ] as const;

  it.each(commands)(
    'delivers %s locally without navigating another browser tab',
    (type, payload) => {
      const local = vi.fn();
      masterBus.subscribe(type, local);
      masterBus.emit(type, payload);
      expect(local).toHaveBeenCalledOnce();
      expect(local.mock.calls[0][0].payload).toEqual(payload);
      expect(channel.postMessage).not.toHaveBeenCalled();
    }
  );

  it.each(commands)(
    'ignores legacy-tab incoming %s before subscribers and deduplication',
    (type, payload) => {
      const local = vi.fn();
      masterBus.subscribe(type, local);
      channel.onmessage!({ data: { type, payload } });
      expect(local).not.toHaveBeenCalled();
      masterBus.emit(type, payload);
      expect(local).toHaveBeenCalledOnce();
    }
  );

  it('continues sharing player appearance data without rebroadcasting incoming updates', () => {
    const subscriber = vi.fn();
    masterBus.subscribe('PLAYER_APPEARANCE_CHANGED', subscriber);
    const outgoing = { userId: 'player-one' };
    masterBus.emit('PLAYER_APPEARANCE_CHANGED', outgoing);
    expect(channel.postMessage).toHaveBeenCalledExactlyOnceWith({
      type: 'PLAYER_APPEARANCE_CHANGED',
      payload: outgoing,
    });
    channel.onmessage!({
      data: { type: 'PLAYER_APPEARANCE_CHANGED', payload: { userId: 'player-two' } },
    });
    expect(subscriber).toHaveBeenCalledTimes(2);
    expect(channel.postMessage).toHaveBeenCalledTimes(1);
  });
});

describe('MasterBus critical channel health report (2026-10-24)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    masterBus.reset();
    vi.stubGlobal(
      'BroadcastChannel',
      class {
        onmessage = null;
        postMessage = vi.fn();
        close = vi.fn();
      }
    );
  });
  afterEach(() => {
    masterBus.reset();
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('reports a dead factory-less t-break channel once, not every 30s tick', async () => {
    const reporter = await import('../../src/utils/errorReporter');
    const spy = vi.spyOn(reporter, 'reportError').mockImplementation(() => undefined);
    const dead = { on: vi.fn(), subscribe: vi.fn(), state: 'closed' };
    vi.mocked(supabase.channel).mockReturnValueOnce(dead as any);
    const key = 't-break-827a1b52-2814-4998-9b47-8c4afea22418';
    masterBus.init();
    masterBus.getOrCreateChannel(key);
    vi.advanceTimersByTime(30_000 * 10);
    const reports = spy.mock.calls.filter(
      ([, src]) => src === 'MasterBus.Critical_channel_no_factory'
    );
    expect(reports).toHaveLength(1);
    // Still left in place for the SDK's own rejoin, as before.
    expect(masterBus.hasChannel(key)).toBe(true);
    spy.mockRestore();
  });
});
