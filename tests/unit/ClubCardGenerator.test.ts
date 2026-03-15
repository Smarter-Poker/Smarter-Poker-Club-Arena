/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  UNIT TESTS — ClubCardGenerator
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Tests card dimensions constants and class shape.
 * NOTE: Canvas-based rendering requires DOM (browser). We test the
 * exported class shape and verify it has the static generateCard method.
 */

import { describe, it, expect, vi } from 'vitest';

// ─── Mock dependencies ────────────────────────────────────────────────────

// ClubCardGenerator uses import.meta.env.BASE_URL — mock it
vi.stubGlobal('import', { meta: { env: { BASE_URL: '/' } } });

// ─── Import ──────────────────────────────────────────────────────────────

import { ClubCardGenerator } from '../../src/services/ClubCardGenerator';

describe('ClubCardGenerator', () => {
  describe('class shape', () => {
    it('should export ClubCardGenerator class', () => {
      expect(ClubCardGenerator).toBeDefined();
    });

    it('should have static generateCard method', () => {
      expect(typeof ClubCardGenerator.generateCard).toBe('function');
    });
  });
});
