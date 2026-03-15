/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  UNIT TESTS — SocialEnhancementsService
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Tests pure logic:
 * - renderRichText: XSS-safe markdown parsing (bold, italic, code, del, links)
 * - getOnlineFriendsFromPresence: presence state matching
 * - Connection strength scoring formula
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mock dependencies ────────────────────────────────────────────────────

const mockPresenceState = vi.fn().mockReturnValue({});

vi.mock('../../src/lib/supabase', () => {
  const buildChain = (): any => {
    const handler: ProxyHandler<any> = {
      get: (_target, prop) => {
        if (prop === 'maybeSingle' || prop === 'single')
          return () => Promise.resolve({ data: null, error: null });
        if (prop === 'then')
          return (resolve: (v: any) => void) => resolve({ data: null, error: null });
        return vi.fn().mockReturnValue(new Proxy({}, handler));
      },
    };
    return new Proxy({}, handler);
  };
  return {
    supabase: {
      from: () => buildChain(),
      rpc: vi.fn().mockResolvedValue({ data: null, error: null }),
    },
  };
});

vi.mock('../../src/core/MasterBus', () => ({
  masterBus: {
    emit: vi.fn(),
    subscribe: vi.fn(() => vi.fn()),
    getOrCreateChannel: vi.fn().mockReturnValue({
      presenceState: () => mockPresenceState(),
      on: vi.fn().mockReturnThis(),
      subscribe: vi.fn(),
      track: vi.fn(),
    }),
    removeRegisteredChannel: vi.fn(),
  },
}));

// ─── Import AFTER mocks ──────────────────────────────────────────────────

import { socialEnhancementsService } from '../../src/services/SocialEnhancementsService';

describe('SocialEnhancementsService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPresenceState.mockReturnValue({});
  });

  // ─────────────────────────────────────────────────────────────────────────
  // RENDER RICH TEXT — XSS-SAFE MARKDOWN
  // ─────────────────────────────────────────────────────────────────────────

  describe('renderRichText', () => {
    it('should escape HTML entities to prevent XSS', () => {
      const result = socialEnhancementsService.renderRichText('<script>alert("xss")</script>');
      expect(result).not.toContain('<script>');
      expect(result).toContain('&lt;script&gt;');
      expect(result).toContain('&quot;');
    });

    it('should render bold text (**text**)', () => {
      const result = socialEnhancementsService.renderRichText('This is **bold** text');
      expect(result).toContain('<strong>bold</strong>');
    });

    it('should render italic text (_text_)', () => {
      const result = socialEnhancementsService.renderRichText('This is _italic_ text');
      expect(result).toContain('<em>italic</em>');
    });

    it('should render inline code (`text`)', () => {
      const result = socialEnhancementsService.renderRichText('Use `code` here');
      expect(result).toContain('<code');
      expect(result).toContain('code</code>');
    });

    it('should render strikethrough (~~text~~)', () => {
      const result = socialEnhancementsService.renderRichText('This is ~~deleted~~ text');
      expect(result).toContain('<del>deleted</del>');
    });

    it('should auto-link URLs', () => {
      const result = socialEnhancementsService.renderRichText('Visit https://example.com today');
      expect(result).toContain('href="https://example.com"');
      expect(result).toContain('target="_blank"');
      expect(result).toContain('rel="noopener noreferrer"');
    });

    it('should handle multiple formatting in one string', () => {
      const result = socialEnhancementsService.renderRichText('**Bold** and _italic_ and `code`');
      expect(result).toContain('<strong>Bold</strong>');
      expect(result).toContain('<em>italic</em>');
      expect(result).toContain('code</code>');
    });

    it('should return plain text unmodified (no formatting)', () => {
      const result = socialEnhancementsService.renderRichText('Just plain text');
      expect(result).toBe('Just plain text');
    });

    it('should handle ampersands in text', () => {
      const result = socialEnhancementsService.renderRichText('A & B');
      expect(result).toContain('&amp;');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // GET ONLINE FRIENDS FROM PRESENCE
  // ─────────────────────────────────────────────────────────────────────────

  describe('getOnlineFriendsFromPresence', () => {
    it('should return 0 when no one is online', () => {
      mockPresenceState.mockReturnValue({});
      expect(socialEnhancementsService.getOnlineFriendsFromPresence(['u1', 'u2'])).toBe(0);
    });

    it('should count matching friend IDs in presence state', () => {
      mockPresenceState.mockReturnValue({
        key1: [{ user_id: 'u1' }],
        key2: [{ user_id: 'u3' }],
      });
      // u1 is a friend, u3 is not in the friend list
      expect(socialEnhancementsService.getOnlineFriendsFromPresence(['u1', 'u2'])).toBe(1);
    });

    it('should count multiple online friends', () => {
      mockPresenceState.mockReturnValue({
        key1: [{ user_id: 'u1' }, { user_id: 'u2' }],
        key2: [{ user_id: 'u4' }],
      });
      expect(socialEnhancementsService.getOnlineFriendsFromPresence(['u1', 'u2', 'u3'])).toBe(2);
    });
  });
});
