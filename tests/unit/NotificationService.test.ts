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

vi.mock('../../src/services/MessagingService', () => ({
  messagingService: { isNotificationTypeMuted: vi.fn(() => false) },
}));

import { notificationService } from '../../src/services/NotificationService';

describe('NotificationService', () => {
  it('removes dollar signs only from browser notification display', async () => {
    const constructor = Object.assign(
      vi.fn(function () {}),
      { permission: 'granted' }
    );
    vi.stubGlobal('Notification', constructor);
    const notification = {
      id: '$identity',
      type: 'waitlist_ready',
      title: 'Satellite $5',
      message: 'Prize ＄54 / ﹩25',
    };
    try {
      await (
        notificationService as unknown as { showBrowserNotification(n: unknown): Promise<void> }
      ).showBrowserNotification(notification);
      expect(constructor).toHaveBeenCalledWith('Satellite 5', {
        body: 'Prize 54 / 25',
        icon: '/favicon.ico',
        tag: '$identity',
      });
      expect(notification.title).toBe('Satellite $5');
    } finally {
      vi.unstubAllGlobals();
    }
  });
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
    it('keeps every invoice individually visible even with matching titles', () => {
      const invoices = ['first', 'second', 'third'].map((id) => ({
        id,
        userId: 'recipient',
        type: 'accounting_invoice' as const,
        title: 'Weekly Accounting Invoice',
        message: 'Transfer Recorded',
        isRead: false,
        createdAt: '2026-09-14T09:00:00Z',
      }));
      expect(notificationService.groupNotifications(invoices)).toEqual(invoices);
    });
    it('should have groupNotifications method', () => {
      expect(typeof notificationService.groupNotifications).toBe('function');
    });

    it('should group empty array', () => {
      const grouped = notificationService.groupNotifications([]);
      expect(grouped).toBeDefined();
    });
  });

  it('opens the actual Hub Messenger conversation for an accounting invoice', () => {
    expect(
      notificationService.getDeepLinkUrl('accounting_invoice', {
        conversation_id: 'a83d4cdf-e3ce-41d4-888d-1a3749d9291b',
      })
    ).toBe('/hub/messenger?conversation=a83d4cdf-e3ce-41d4-888d-1a3749d9291b');
    expect(
      notificationService.getDeepLinkUrl('accounting_invoice', {
        conversationId: 'conversation&another=value',
      })
    ).toBe('/hub/messenger?conversation=conversation%26another%3Dvalue');
    expect(notificationService.getDeepLinkUrl('accounting_invoice', {})).toBeUndefined();
  });
});
