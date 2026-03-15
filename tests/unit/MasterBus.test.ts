/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  UNIT TESTS — MasterBus (Core Event Bus)
 * ═══════════════════════════════════════════════════════════════════════════════
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    channel: vi.fn().mockReturnValue({
      on: vi.fn().mockReturnThis(),
      subscribe: vi.fn().mockReturnThis(),
      unsubscribe: vi.fn(),
    }),
    removeChannel: vi.fn(),
    auth: {
      getUser: vi.fn().mockResolvedValue({ data: { user: null } }),
      onAuthStateChange: vi.fn(() => ({ data: { subscription: { unsubscribe: vi.fn() } } })),
    },
  },
}));

import { masterBus } from '../../src/core/MasterBus';

describe('MasterBus', () => {
  it('should export masterBus singleton', () => {
    expect(masterBus).toBeDefined();
  });

  describe('subscribe / emit', () => {
    it('should subscribe and receive events', () => {
      const handler = vi.fn();
      const unsub = masterBus.subscribe('WALLET_UPDATED' as any, handler);
      masterBus.emit('WALLET_UPDATED' as any, { userId: 'u1' });
      expect(handler).toHaveBeenCalledTimes(1);
      unsub();
    });

    it('should unsubscribe correctly', () => {
      const handler = vi.fn();
      const unsub = masterBus.subscribe('WALLET_UPDATED' as any, handler);
      unsub();
      masterBus.emit('WALLET_UPDATED' as any, { userId: 'u1' });
      expect(handler).not.toHaveBeenCalled();
    });

    it('should isolate events by type', () => {
      const handler1 = vi.fn();
      const handler2 = vi.fn();
      const unsub1 = masterBus.subscribe('WALLET_UPDATED' as any, handler1);
      const unsub2 = masterBus.subscribe('TABLE_EVENT' as any, handler2);
      masterBus.emit('WALLET_UPDATED' as any, { userId: 'u1' });
      expect(handler1).toHaveBeenCalledTimes(1);
      expect(handler2).not.toHaveBeenCalled();
      unsub1();
      unsub2();
    });

    it('should support multiple subscribers for same event', () => {
      const h1 = vi.fn();
      const h2 = vi.fn();
      const u1 = masterBus.subscribe('WALLET_UPDATED' as any, h1);
      const u2 = masterBus.subscribe('WALLET_UPDATED' as any, h2);
      masterBus.emit('WALLET_UPDATED' as any, { userId: 'u1' });
      expect(h1).toHaveBeenCalledTimes(1);
      expect(h2).toHaveBeenCalledTimes(1);
      u1();
      u2();
    });
  });

  describe('getStatus', () => {
    it('should return a status object', () => {
      const status = masterBus.getStatus();
      expect(status).toBeDefined();
      expect(typeof status.online).toBe('boolean');
    });
  });

  describe('onEvent', () => {
    it('should be a function', () => {
      expect(typeof masterBus.onEvent).toBe('function');
    });

    it('should listen to all events', () => {
      const handler = vi.fn();
      const unsub = masterBus.onEvent(handler);
      masterBus.emit('WALLET_UPDATED' as any, { userId: 'u1' });
      expect(handler).toHaveBeenCalledTimes(1);
      unsub();
    });
  });
});
