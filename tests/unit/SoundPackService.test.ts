/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  UNIT TESTS — SoundPackService
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Tests 4 sound packs, getCurrentPack default, setPack, isSoundEnabled,
 * and pack-specific enabledSounds.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mock SoundService dependency ─────────────────────────────────────────

vi.mock('../../src/services/SoundService', () => ({
  soundService: {
    setMasterVolume: vi.fn(),
    setEffectsVolume: vi.fn(),
    setEnabled: vi.fn(),
  },
}));

// Mock localStorage
const mockStorage = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (key: string) => mockStorage.get(key) ?? null,
  setItem: (key: string, val: string) => mockStorage.set(key, val),
  removeItem: (key: string) => mockStorage.delete(key),
});

// ─── Import AFTER mocks ──────────────────────────────────────────────────

import { soundPackService } from '../../src/services/SoundPackService';
import { soundService } from '../../src/services/SoundService';

describe('SoundPackService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStorage.clear();
    soundPackService.setPack('casino'); // Reset to default
  });

  describe('getAvailablePacks', () => {
    it('should return 4 packs', () => {
      const packs = soundPackService.getAvailablePacks();
      expect(packs).toHaveLength(4);
    });

    it('should include casino, minimal, tournament, silent', () => {
      const ids = soundPackService.getAvailablePacks().map((p) => p.id);
      expect(ids).toContain('casino');
      expect(ids).toContain('minimal');
      expect(ids).toContain('tournament');
      expect(ids).toContain('silent');
    });

    it('each pack should have id, name, description, icon', () => {
      for (const pack of soundPackService.getAvailablePacks()) {
        expect(pack.id).toBeTruthy();
        expect(pack.name).toBeTruthy();
        expect(pack.description).toBeTruthy();
        expect(pack.icon).toBeTruthy();
      }
    });
  });

  describe('getCurrentPack', () => {
    it('should default to casino', () => {
      expect(soundPackService.getCurrentPack()).toBe('casino');
    });
  });

  describe('setPack', () => {
    it('should switch to minimal pack', () => {
      soundPackService.setPack('minimal');
      expect(soundPackService.getCurrentPack()).toBe('minimal');
    });

    it('should switch to silent and disable sounds', () => {
      soundPackService.setPack('silent');
      expect(soundService.setEnabled).toHaveBeenCalledWith(false);
    });

    it('should persist selection to localStorage', () => {
      soundPackService.setPack('tournament');
      expect(mockStorage.get('smarter_sound_pack')).toBe('tournament');
    });
  });

  describe('isSoundEnabled', () => {
    it('casino should have deal sound enabled', () => {
      expect(soundPackService.isSoundEnabled('deal')).toBe(true);
    });

    it('minimal should not have allIn sound enabled', () => {
      soundPackService.setPack('minimal');
      expect(soundPackService.isSoundEnabled('allIn')).toBe(false);
    });

    it('minimal should have buttonClick sound enabled', () => {
      soundPackService.setPack('minimal');
      expect(soundPackService.isSoundEnabled('buttonClick')).toBe(true);
    });

    it('silent should have no sounds enabled', () => {
      soundPackService.setPack('silent');
      expect(soundPackService.isSoundEnabled('deal')).toBe(false);
      expect(soundPackService.isSoundEnabled('check')).toBe(false);
    });
  });
});
