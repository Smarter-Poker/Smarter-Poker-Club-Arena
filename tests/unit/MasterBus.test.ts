/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  UNIT TESTS — MasterBus (Core Event Bus)
 * ═══════════════════════════════════════════════════════════════════════════════
 */
import { describe, it, expect, vi } from 'vitest';

// Need a full channel mock because MasterBus subscribes to Supabase channels at init
vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    channel: vi.fn().mockReturnValue({
      on: vi.fn().mockReturnThis(),
      subscribe: vi.fn().mockReturnValue('subscribed'),
      unsubscribe: vi.fn(),
    }),
    removeChannel: vi.fn(),
    auth: {
      getUser: vi.fn().mockResolvedValue({ data: { user: null } }),
      onAuthStateChange: vi.fn(() => ({
        data: { subscription: { unsubscribe: vi.fn() } },
      })),
    },
    from: vi.fn().mockReturnValue({
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
    }),
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
    const unsub = masterBus.subscribe('WALLET_UPDATED' as BusEventType, handler);
    unsub();
    masterBus.emit('WALLET_UPDATED' as BusEventType, { userId: 'u1' });
    expect(handler).not.toHaveBeenCalled();
  });

  it('should isolate events by type', () => {
    const handler1 = vi.fn();
    const handler2 = vi.fn();
    const unsub1 = masterBus.subscribe('WALLET_UPDATED' as BusEventType, handler1);
    const unsub2 = masterBus.subscribe('TABLE_EVENT' as BusEventType, handler2);
    masterBus.emit('WALLET_UPDATED' as BusEventType, { userId: 'u1' });
    expect(handler1).toHaveBeenCalledTimes(1);
    expect(handler2).not.toHaveBeenCalled();
    unsub1();
    unsub2();
  });

  it('should support multiple subscribers for same event', () => {
    const h1 = vi.fn();
    const h2 = vi.fn();
    const u1 = masterBus.subscribe('WALLET_UPDATED' as BusEventType, h1);
    const u2 = masterBus.subscribe('WALLET_UPDATED' as BusEventType, h2);
    masterBus.emit('WALLET_UPDATED' as BusEventType, { userId: 'u1' });
    expect(h1).toHaveBeenCalledTimes(1);
    expect(h2).toHaveBeenCalledTimes(1);
    u1();
    u2();
  });

  it('should have getStatus method', () => {
    expect(typeof masterBus.getStatus).toBe('function');
    const status = masterBus.getStatus();
    expect(status).toBeDefined();
  });
});
