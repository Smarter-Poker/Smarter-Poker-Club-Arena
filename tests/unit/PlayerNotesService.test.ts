/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  UNIT TESTS — PlayerNotesService
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Tests player notes constants, cache behavior, and default fallbacks:
 * - NOTE_COLORS: 7 colors with unique IDs, valid hex values
 * - PLAYER_TAGS: 15 player tags
 * - getNote: cache hit, cache miss → default, saveNote → cache update
 * - clearCache: empties the internal map
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

vi.mock('../../src/utils/retryAsync', () => ({
  retryAsync: <T>(fn: () => Promise<T>) => fn(),
}));

// ─── Import AFTER mocks ──────────────────────────────────────────────────

import {
  playerNotesService,
  NOTE_COLORS,
  PLAYER_TAGS,
} from '../../src/services/PlayerNotesService';

describe('PlayerNotesService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    playerNotesService.clearCache();
  });

  // ─────────────────────────────────────────────────────────────────────────
  // NOTE_COLORS CATALOG
  // ─────────────────────────────────────────────────────────────────────────

  describe('NOTE_COLORS', () => {
    it('should contain exactly 7 colors', () => {
      // Was 8; NOTE_COLORS is now pinned to the DB color_label CHECK
      // (none, green, yellow, orange, red, blue, purple) = 7 entries.
      expect(NOTE_COLORS.length).toBe(7);
    });

    it('should have unique IDs', () => {
      const ids = NOTE_COLORS.map((c) => c.id);
      expect(new Set(ids).size).toBe(ids.length);
    });

    it('should have valid hex values', () => {
      for (const color of NOTE_COLORS) {
        expect(color.hex).toMatch(/^#[0-9a-fA-F]{6}$/);
      }
    });

    it('should include "none" as first color with hex #6b7280', () => {
      // First colour was blue/#3b82f6; the list now leads with the DB default
      // label 'none' (grey) so the palette order matches the CHECK constraint.
      expect(NOTE_COLORS[0].id).toBe('none');
      expect(NOTE_COLORS[0].value).toBe('none');
      expect(NOTE_COLORS[0].hex).toBe('#6b7280');
    });

    it('should have id and value matching for every color', () => {
      for (const color of NOTE_COLORS) {
        expect(color.value).toBe(color.id);
      }
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // PLAYER_TAGS CATALOG
  // ─────────────────────────────────────────────────────────────────────────

  describe('PLAYER_TAGS', () => {
    it('should contain exactly 15 tags', () => {
      expect(PLAYER_TAGS.length).toBe(15);
    });

    it('should include "Fish" tag', () => {
      expect(PLAYER_TAGS.some((t) => t.includes('Fish'))).toBe(true);
    });

    it('should include the "Station" tag', () => {
      // Tag was renamed from 'Calling Station' to 'Station' (shorter chip label).
      expect(PLAYER_TAGS).toContain('Station');
      expect(PLAYER_TAGS.some((t) => t.includes('Calling Station'))).toBe(false);
    });

    it('should have unique tags', () => {
      expect(new Set(PLAYER_TAGS).size).toBe(PLAYER_TAGS.length);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // GET NOTE — DEFAULT FALLBACK
  // ─────────────────────────────────────────────────────────────────────────

  describe('getNote', () => {
    it('should return default note when no data exists', async () => {
      const note = await playerNotesService.getNote('user-1', 'target-1');
      expect(note.note).toBe('');
      expect(note.color).toBe('#3b82f6');
      expect(note.tags).toEqual([]);
      expect(note.handsPlayed).toBe(0);
      expect(note.lastSeen).toBeNull();
    });

    it('should return cached note on second call', async () => {
      const note1 = await playerNotesService.getNote('user-1', 'target-1');
      const note2 = await playerNotesService.getNote('user-1', 'target-1');
      // Both should be the same reference (cached)
      expect(note1).toBe(note2);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // CACHE OPERATIONS
  // ─────────────────────────────────────────────────────────────────────────

  describe('clearCache', () => {
    it('should clear cached notes', async () => {
      // Prime the cache
      await playerNotesService.getNote('user-1', 'target-1');
      playerNotesService.clearCache();
      // After clear, a new lookup should hit RPC again, returning default
      const note = await playerNotesService.getNote('user-1', 'target-1');
      expect(note.note).toBe('');
    });
  });
});
