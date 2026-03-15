/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  UNIT TESTS — MessagingService
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Tests DM operations, unread count, search guard, reactions, and mark as read.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mock dependencies ────────────────────────────────────────────────────

vi.mock('../../src/lib/supabase', () => {
  const buildChain = (): any => {
    const handler: ProxyHandler<any> = {
      get: (_target, prop) => {
        if (prop === 'maybeSingle' || prop === 'single')
          return () => Promise.resolve({ data: null, error: null });
        if (prop === 'then')
          return (resolve: (v: any) => void) => resolve({ data: null, error: null, count: null });
        return vi.fn().mockReturnValue(new Proxy({}, handler));
      },
    };
    return new Proxy({}, handler);
  };
  return {
    supabase: {
      from: () => buildChain(),
      rpc: vi.fn().mockResolvedValue({ data: null, error: null }),
      channel: vi.fn().mockReturnValue({
        on: vi.fn().mockReturnThis(),
        subscribe: vi.fn(),
      }),
      removeChannel: vi.fn().mockResolvedValue(undefined),
      auth: {
        getUser: vi.fn().mockResolvedValue({ data: { user: { id: 'test-user' } } }),
      },
    },
  };
});

vi.mock('../../src/core/MasterBus', () => ({
  masterBus: {
    emit: vi.fn(),
    subscribe: vi.fn(() => vi.fn()),
  },
}));

vi.mock('../../src/utils/clubIdResolver', () => ({
  resolveClubUUID: vi.fn().mockResolvedValue('resolved-uuid'),
}));

vi.mock('../../src/services/ClubMessagingPermissions', () => ({
  clubMessagingPermissions: {
    canMessage: vi.fn().mockResolvedValue({ allowed: true }),
  },
}));

// ─── Import AFTER mocks ──────────────────────────────────────────────────

import { messagingService } from '../../src/services/MessagingService';

describe('MessagingService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ─────────────────────────────────────────────────────────────────────────
  // CONVERSATIONS
  // ─────────────────────────────────────────────────────────────────────────

  describe('getConversations', () => {
    it('should return empty array when no conversations', async () => {
      const result = await messagingService.getConversations('user-1');
      expect(result).toEqual([]);
    });
  });

  describe('getMessages', () => {
    it('should return empty array when no messages', async () => {
      const result = await messagingService.getMessages('conv-1');
      expect(result).toEqual([]);
    });

    it('should accept custom limit parameter', async () => {
      const result = await messagingService.getMessages('conv-1', 10);
      expect(result).toEqual([]);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // UNREAD COUNT
  // ─────────────────────────────────────────────────────────────────────────

  describe('getUnreadCount', () => {
    it('should return 0 when no unread messages', async () => {
      const result = await messagingService.getUnreadCount('user-1');
      expect(result).toBe(0);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // MARK AS READ
  // ─────────────────────────────────────────────────────────────────────────

  describe('markAsRead', () => {
    it('should return true on success (mocked)', async () => {
      const result = await messagingService.markAsRead('conv-1', 'user-1');
      expect(result).toBe(true);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // SEARCH
  // ─────────────────────────────────────────────────────────────────────────

  describe('searchMessages', () => {
    it('should return empty array for blank query', async () => {
      const result = await messagingService.searchMessages('conv-1', '');
      expect(result).toEqual([]);
    });

    it('should return empty array for whitespace query', async () => {
      const result = await messagingService.searchMessages('conv-1', '   ');
      expect(result).toEqual([]);
    });

    it('should return empty array when no matches', async () => {
      const result = await messagingService.searchMessages('conv-1', 'hello');
      expect(result).toEqual([]);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // REACTIONS
  // ─────────────────────────────────────────────────────────────────────────

  describe('getReactions', () => {
    it('should return empty array for message with no reactions', async () => {
      const result = await messagingService.getReactions('msg-1');
      expect(result).toEqual([]);
    });
  });

  describe('removeReaction', () => {
    it('should return true on success (mocked)', async () => {
      const result = await messagingService.removeReaction('msg-1', 'user-1', '👍');
      expect(result).toBe(true);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // PINNING
  // ─────────────────────────────────────────────────────────────────────────

  describe('pinConversation', () => {
    it('should return true on success (mocked)', async () => {
      const result = await messagingService.pinConversation('conv-1', 'user-1');
      expect(result).toBe(true);
    });
  });

  describe('unpinConversation', () => {
    it('should return true on success (mocked)', async () => {
      const result = await messagingService.unpinConversation('conv-1', 'user-1');
      expect(result).toBe(true);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // SUBSCRIBE / UNSUBSCRIBE
  // ─────────────────────────────────────────────────────────────────────────

  describe('unsubscribe', () => {
    it('should safely handle unsubscribe when not subscribed', async () => {
      await messagingService.unsubscribe();
      // No throw = safe
    });
  });
});
