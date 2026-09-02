/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  UNIT TESTS — PlayerStatusService
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Tests pure logic:
 * - generateProfileLink: URL construction
 * - generateProfileCard: card object creation with defaults
 * - getPlayerStatus: returns null when no data
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
  },
}));

// ─── Import AFTER mocks ──────────────────────────────────────────────────

import { playerStatusService } from '../../src/services/PlayerStatusService';
import { generateDefaultAvatar } from '../../src/utils/avatarGenerator';

// Mock window.location.origin for SSR-safe testing
Object.defineProperty(window, 'location', {
  value: { origin: 'https://smarter.poker', href: '' },
  writable: true,
});

describe('PlayerStatusService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ─────────────────────────────────────────────────────────────────────────
  // GENERATE PROFILE LINK
  // ─────────────────────────────────────────────────────────────────────────

  describe('generateProfileLink', () => {
    it('should construct correct URL', () => {
      const link = playerStatusService.generateProfileLink('user-123');
      expect(link).toBe('https://smarter.poker/hub/club-arena/profile/user-123');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // GENERATE PROFILE CARD
  // ─────────────────────────────────────────────────────────────────────────

  describe('generateProfileCard', () => {
    it('should create card with all provided fields', () => {
      const card = playerStatusService.generateProfileCard({
        userId: 'u1',
        username: 'Alice',
        avatarUrl: 'https://img.com/a.png',
        level: 5,
      });
      expect(card.type).toBe('profile_card');
      expect(card.userId).toBe('u1');
      expect(card.username).toBe('Alice');
      expect(card.avatarUrl).toBe('https://img.com/a.png');
      expect(card.level).toBe(5);
      expect(card.link).toBe('https://smarter.poker/hub/club-arena/profile/u1');
    });

    it('should use default avatar when not provided', () => {
      const card = playerStatusService.generateProfileCard({
        userId: 'u1',
        username: 'Bob',
      });
      // UPDATED: the default avatar is no longer the static '/default-avatar.png'
      // asset — PlayerStatusService now calls generateDefaultAvatar() from
      // src/utils/avatarGenerator.ts, which returns an inline SVG data URI.
      // Assert the contract (a real, non-empty SVG data URL produced by the
      // shared generator) instead of pinning the percent-encoded payload.
      expect(card.avatarUrl).toEqual(generateDefaultAvatar());
      expect(card.avatarUrl.startsWith('data:image/svg+xml,')).toBe(true);
      const svg = decodeURIComponent(card.avatarUrl.slice('data:image/svg+xml,'.length));
      expect(svg).toContain('<svg');
      expect(svg).toContain('</svg>');
    });

    it('should default level to 1 when not provided', () => {
      const card = playerStatusService.generateProfileCard({
        userId: 'u1',
        username: 'Charlie',
      });
      expect(card.level).toBe(1);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // GET PLAYER STATUS — NULL FALLBACK
  // ─────────────────────────────────────────────────────────────────────────

  describe('getPlayerStatus', () => {
    it('should return null when no profile data exists', async () => {
      const status = await playerStatusService.getPlayerStatus('unknown-user');
      expect(status).toBeNull();
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // CLEAR PLAYING AT
  // ─────────────────────────────────────────────────────────────────────────

  describe('clearPlayingAt', () => {
    it('should call setPlayingAt with null values', async () => {
      // Just verify it doesn't crash — the underlying Supabase calls are mocked
      await playerStatusService.clearPlayingAt('user-1');
      // No throw = success
    });
  });
});
