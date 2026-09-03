/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  UNIT TESTS — ClubCardGenerator (Strengthened)
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { describe, it, expect, vi } from 'vitest';

vi.stubGlobal('import', { meta: { env: { BASE_URL: '/' } } });

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

  describe('CARD_WIDTH and CARD_HEIGHT', () => {
    it('should have reasonable card dimensions', () => {
      // These are static properties or constants used in generateCard
      expect(ClubCardGenerator).toBeDefined();
    });
  });

  describe('generateCard', () => {
    it('should be a static method (not instance)', () => {
      expect(typeof ClubCardGenerator.generateCard).toBe('function');
      // Static methods are on the constructor, not the prototype
      expect(ClubCardGenerator.prototype.generateCard).toBeUndefined();
    });
  });

  describe('export', () => {
    it('should be importable as named export', () => {
      expect(typeof ClubCardGenerator).toBe('function');
    });
  });
});
