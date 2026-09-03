/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  UNIT TESTS — NotificationService
 * ═══════════════════════════════════════════════════════════════════════════════
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/lib/supabase', () => {
  const buildChain = (): any => {
    const handler: ProxyHandler<any> = {
      get: (_target, prop) => {
        if (prop === 'maybeSingle' || prop === 'single')
          return () => Promise.resolve({ data: null, error: null });
        if (prop === 'then')
          return (resolve: (v: any) => void) => resolve({ data: [], error: null });
        return vi.fn().mockReturnValue(new Proxy({}, handler));
      },
    };
    return new Proxy({}, handler);
  };
  return {
    supabase: {
      from: () => buildChain(),
      channel: vi.fn().mockReturnValue({
        on: vi.fn().mockReturnThis(),
        subscribe: vi.fn().mockReturnValue('subscribed'),
        unsubscribe: vi.fn(),
      }),
      removeChannel: vi.fn(),
    },
  };
});

vi.mock('../../src/core/MasterBus', () => ({
  masterBus: { emit: vi.fn(), subscribe: vi.fn(() => vi.fn()) },
}));

import { notificationService } from '../../src/services/NotificationService';

describe('NotificationService', () => {
  it('should export a singleton instance', () => {
    expect(notificationService).toBeDefined();
  });

  it('should have subscribe method', () => {
    expect(typeof notificationService.subscribe).toBe('function');
  });

  it('should have unsubscribe method', () => {
    expect(typeof notificationService.unsubscribe).toBe('function');
  });

  it('should have getNotifications method', () => {
    expect(typeof notificationService.getNotifications).toBe('function');
  });

  it('should have getUnreadCount method', () => {
    expect(typeof notificationService.getUnreadCount).toBe('function');
  });

  it('should have markAsRead method', () => {
    expect(typeof notificationService.markAsRead).toBe('function');
  });

  it('should have markAllAsRead method', () => {
    expect(typeof notificationService.markAllAsRead).toBe('function');
  });

  it('should have create method', () => {
    expect(typeof notificationService.create).toBe('function');
  });

  describe('DND mode', () => {
    it('should have setDnd method', () => {
      expect(typeof notificationService.setDnd).toBe('function');
    });

    it('should have clearDnd method', () => {
      expect(typeof notificationService.clearDnd).toBe('function');
    });

    it('should have isDndActive method', () => {
      expect(typeof notificationService.isDndActive).toBe('function');
    });

    it('should not be in DND mode initially', () => {
      expect(notificationService.isDndActive()).toBe(false);
    });

    it('should enable DND mode', () => {
      notificationService.setDnd(30);
      expect(notificationService.isDndActive()).toBe(true);
      notificationService.clearDnd();
    });

    it('should clear DND mode', () => {
      notificationService.setDnd(30);
      notificationService.clearDnd();
      expect(notificationService.isDndActive()).toBe(false);
    });
  });

  describe('groupNotifications', () => {
    it('should have groupNotifications method', () => {
      expect(typeof notificationService.groupNotifications).toBe('function');
    });

    it('should group empty array', () => {
      const grouped = notificationService.groupNotifications([]);
      expect(grouped).toBeDefined();
    });
  });
});
