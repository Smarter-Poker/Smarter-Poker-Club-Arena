/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  UNIT TESTS — LogoGeneratorService
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Tests LOGO_STYLE_PRESETS integrity, generateClubLogo API key check,
 * and prompt builder logic.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// ─── Import AFTER mocks ──────────────────────────────────────────────────

import {
  LOGO_STYLE_PRESETS,
  generateClubLogo,
} from '../../src/services/LogoGeneratorService';

describe('LogoGeneratorService', () => {
  beforeEach(() => vi.clearAllMocks());

  describe('LOGO_STYLE_PRESETS', () => {
    it('should have 12 presets', () => {
      expect(LOGO_STYLE_PRESETS).toHaveLength(12);
    });

    it('each preset should have id, name, theme, style, icon', () => {
      for (const preset of LOGO_STYLE_PRESETS) {
        expect(preset.id).toBeTruthy();
        expect(preset.name).toBeTruthy();
        expect(preset.theme).toBeTruthy();
        expect(preset.style).toBeTruthy();
        expect(preset.icon).toBeTruthy();
      }
    });

    it('all preset IDs should be unique', () => {
      const ids = LOGO_STYLE_PRESETS.map((p) => p.id);
      expect(new Set(ids).size).toBe(ids.length);
    });

    it('should include shark, dragon, eagle, lion presets', () => {
      const names = LOGO_STYLE_PRESETS.map((p) => p.name);
      expect(names).toContain('Shark');
      expect(names).toContain('Dragon');
      expect(names).toContain('Eagle');
      expect(names).toContain('Lion');
    });

    it('style should be one of modern/classic/aggressive/elegant/playful', () => {
      const validStyles = ['modern', 'classic', 'aggressive', 'elegant', 'playful'];
      for (const preset of LOGO_STYLE_PRESETS) {
        expect(validStyles).toContain(preset.style);
      }
    });
  });

  describe('generateClubLogo', () => {
    it('should return error when XAI_API_KEY not configured', async () => {
      const result = await generateClubLogo({ clubName: 'Test Club' });
      expect(result.success).toBe(false);
      expect(result.error).toContain('not configured');
    });
  });
});
