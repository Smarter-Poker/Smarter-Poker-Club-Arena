/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  UNIT TESTS — MasterBus (Core Event Bus)
 * ═══════════════════════════════════════════════════════════════════════════════
 */
import { describe, it, expect, vi } from 'vitest';

// All stores must be mocked because MasterBus imports them at module level
vi.mock('../../src/stores/useArenaStore', () => ({
  useArenaStore: { getState: vi.fn(() => ({})), setState: vi.fn() },
}));
vi.mock('../../src/stores/useClubStore', () => ({
  useClubStore: { getState: vi.fn(() => ({})), setState: vi.fn() },
}));
vi.mock('../../src/stores/useTableStore', () => ({
  useTableStore: { getState: vi.fn(() => ({})), setState: vi.fn() },
}));
vi.mock('../../src/stores/useUnionStore', () => ({
  useUnionStore: { getState: vi.fn(() => ({})), setState: vi.fn() },
}));
vi.mock('../../src/stores/useWalletStore', () => ({
  useWalletStore: { getState: vi.fn(() => ({})), setState: vi.fn() },
}));
vi.mock('../../src/stores/useSettingsStore', () => ({
  useSettingsStore: { getState: vi.fn(() => ({})), setState: vi.fn() },
}));
vi.mock('../../src/stores/useUserStore', () => ({
  useUserStore: { getState: vi.fn(() => ({})), setState: vi.fn() },
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

import { masterBus, BusEventType } from '../../src/core/MasterBus';

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

  it('should subscribe and receive events', () => {
    const handler = vi.fn();
    const unsub = masterBus.subscribe('WALLET_UPDATED' as BusEventType, handler);
    masterBus.emit('WALLET_UPDATED' as BusEventType, { userId: 'u1' });
    expect(handler).toHaveBeenCalledTimes(1);
    unsub();
  });

  it('should unsubscribe correctly', () => {
    const handler = vi.fn();
    const unsub = masterBus.subscribe('CONNECTION_RESTORED' as BusEventType, handler);
    unsub();
    masterBus.emit('CONNECTION_RESTORED' as BusEventType, { timestamp: Date.now() });
    expect(handler).not.toHaveBeenCalled();
  });

  it('should isolate events by type', () => {
    const handler1 = vi.fn();
    const handler2 = vi.fn();
    const unsub1 = masterBus.subscribe('CLUB_JOINED' as BusEventType, handler1);
    const unsub2 = masterBus.subscribe('TABLE_EVENT' as BusEventType, handler2);
    masterBus.emit('CLUB_JOINED' as BusEventType, { clubId: 'c1' });
    expect(handler1).toHaveBeenCalledTimes(1);
    expect(handler2).not.toHaveBeenCalled();
    unsub1();
    unsub2();
  });

  it('should support multiple subscribers for same event', () => {
    const h1 = vi.fn();
    const h2 = vi.fn();
    const u1 = masterBus.subscribe('SESSION_ENDED' as BusEventType, h1);
    const u2 = masterBus.subscribe('SESSION_ENDED' as BusEventType, h2);
    masterBus.emit('SESSION_ENDED' as BusEventType, { tableId: 't1' });
    expect(h1).toHaveBeenCalledTimes(1);
    expect(h2).toHaveBeenCalledTimes(1);
    u1();
    u2();
  });

  it('should have getStatus method', () => {
    expect(typeof masterBus.getStatus).toBe('function');
  });
});
