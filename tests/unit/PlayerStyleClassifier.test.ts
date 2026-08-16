/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  UNIT TESTS — PlayerStyleClassifier
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Tests the PURE decision-tree classifier:
 * - MIN_SAMPLE guard → 'unknown' for < 15 hands
 * - 8 archetype classifications based on VPIP/PFR/AF
 * - Confidence scaling (15 → 0.15, 100 → 1.0)
 * - getStyleLabel convenience method
 * - getStyleDefinitions returns all 9 styles
 */

import { describe, it, expect } from 'vitest';
import { playerStyleClassifier } from '../../src/services/PlayerStyleClassifier';

describe('PlayerStyleClassifier', () => {
  // ─────────────────────────────────────────────────────────────────────────
  // MIN SAMPLE GUARD
  // ─────────────────────────────────────────────────────────────────────────

  describe('insufficient sample', () => {
    it('should return "unknown" for < 15 hands', () => {
      const result = playerStyleClassifier.classify({
        handsPlayed: 10,
        vpipCount: 3,
        pfrCount: 2,
      });
      expect(result.style).toBe('unknown');
      expect(result.confidence).toBe(0);
      // Icons moved from emoji to letters 2026-08 (was '❓'); classification itself unchanged.
      expect(result.icon).toBe('?');
    });

    it('should return "unknown" for 0 hands', () => {
      const result = playerStyleClassifier.classify({
        handsPlayed: 0,
        vpipCount: 0,
        pfrCount: 0,
      });
      expect(result.style).toBe('unknown');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // ARCHETYPE CLASSIFICATION
  // ─────────────────────────────────────────────────────────────────────────

  describe('archetype classification', () => {
    it('should classify Nit (VPIP < 12, PFR < 8)', () => {
      // VPIP = 10%, PFR = 5%
      const result = playerStyleClassifier.classify({
        handsPlayed: 100,
        vpipCount: 10,
        pfrCount: 5,
        aggressiveActions: 5,
        passiveActions: 10,
      });
      expect(result.style).toBe('nit');
      // Icons moved from emoji to letters 2026-08 (was '🧊'); classification itself unchanged.
      expect(result.icon).toBe('N');
    });

    it('should classify Rock (VPIP < 18, PFR < 10, AF < 2.0)', () => {
      // VPIP = 15%, PFR = 8%
      const result = playerStyleClassifier.classify({
        handsPlayed: 100,
        vpipCount: 15,
        pfrCount: 8,
        aggressiveActions: 10,
        passiveActions: 10, // AF = 1.0
      });
      expect(result.style).toBe('rock');
      // Icons moved from emoji to letters 2026-08 (was '🪨'); classification itself unchanged.
      expect(result.icon).toBe('R');
    });

    it('should classify Maniac (VPIP > 40, PFR > 25, AF > 2.5)', () => {
      // VPIP = 55%, PFR = 35%
      const result = playerStyleClassifier.classify({
        handsPlayed: 100,
        vpipCount: 55,
        pfrCount: 35,
        aggressiveActions: 30,
        passiveActions: 10, // AF = 3.0
      });
      expect(result.style).toBe('maniac');
      // Icons moved from emoji to letters 2026-08 (was '🔥'); classification itself unchanged.
      expect(result.icon).toBe('M');
    });

    it('should classify Calling Station (VPIP > 40, PFR < 12, AF < 1.5)', () => {
      // VPIP = 50%, PFR = 5%
      const result = playerStyleClassifier.classify({
        handsPlayed: 100,
        vpipCount: 50,
        pfrCount: 5,
        aggressiveActions: 5,
        passiveActions: 20, // AF = 0.25
      });
      expect(result.style).toBe('calling_station');
      // Icons moved from emoji to letters 2026-08 (was '📞'); 'CS' is the only 2-letter icon.
      expect(result.icon).toBe('CS');
    });

    it('should classify Fish (VPIP > 35, PFR < 15, AF < 2.0)', () => {
      // VPIP = 40%, PFR = 10%
      const result = playerStyleClassifier.classify({
        handsPlayed: 100,
        vpipCount: 40,
        pfrCount: 10,
        aggressiveActions: 10,
        passiveActions: 10, // AF = 1.0
      });
      expect(result.style).toBe('fish');
      // 2026-08-16: Fish and Shark were the last two emoji icons; the letter
      // migration had skipped them. Every badge is a letter now.
      expect(result.icon).toBe('F');
    });

    it('should classify Shark (VPIP 18-28, PFR 15-25, AF >= 2.5)', () => {
      // VPIP = 22%, PFR = 18%
      const result = playerStyleClassifier.classify({
        handsPlayed: 100,
        vpipCount: 22,
        pfrCount: 18,
        aggressiveActions: 30,
        passiveActions: 10, // AF = 3.0
      });
      expect(result.style).toBe('shark');
      expect(result.icon).toBe('S');
    });

    it('should classify LAG (VPIP > 28, PFR > 18, AF >= 2.0)', () => {
      // VPIP = 35%, PFR = 22%
      const result = playerStyleClassifier.classify({
        handsPlayed: 100,
        vpipCount: 35,
        pfrCount: 22,
        aggressiveActions: 20,
        passiveActions: 10, // AF = 2.0
      });
      expect(result.style).toBe('lag');
      // Icons moved from emoji to letters 2026-08 (was '💥'); classification itself unchanged.
      expect(result.icon).toBe('L');
    });

    it('should classify TAG (VPIP 15-28, PFR >= 10, AF >= 1.5)', () => {
      // VPIP = 22%, PFR = 15%
      const result = playerStyleClassifier.classify({
        handsPlayed: 100,
        vpipCount: 22,
        pfrCount: 15,
        aggressiveActions: 15,
        passiveActions: 10, // AF = 1.5
      });
      expect(result.style).toBe('tag');
      // Icons moved from emoji to letters 2026-08 (was '🎯'); classification itself unchanged.
      expect(result.icon).toBe('T');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // CONFIDENCE SCALING
  // ─────────────────────────────────────────────────────────────────────────

  describe('confidence', () => {
    it('should have 0.15 confidence at 15 hands', () => {
      const result = playerStyleClassifier.classify({
        handsPlayed: 15,
        vpipCount: 1,
        pfrCount: 0,
        aggressiveActions: 0,
        passiveActions: 5,
      });
      expect(result.confidence).toBe(0.15);
    });

    it('should have 0.5 confidence at 50 hands', () => {
      const result = playerStyleClassifier.classify({
        handsPlayed: 50,
        vpipCount: 5,
        pfrCount: 3,
        aggressiveActions: 5,
        passiveActions: 5,
      });
      expect(result.confidence).toBe(0.5);
    });

    it('should cap at 1.0 confidence at 100+ hands', () => {
      const result = playerStyleClassifier.classify({
        handsPlayed: 200,
        vpipCount: 20,
        pfrCount: 10,
        aggressiveActions: 10,
        passiveActions: 10,
      });
      expect(result.confidence).toBe(1.0);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // EDGE CASES: AF CALCULATION
  // ─────────────────────────────────────────────────────────────────────────

  describe('AF edge cases', () => {
    it('should handle zero passiveActions (AF defaults to 5 when aggressiveActions > 0)', () => {
      // VPIP = 50%, PFR = 30%, AF = 5 (aggressive but no passive)
      const result = playerStyleClassifier.classify({
        handsPlayed: 100,
        vpipCount: 50,
        pfrCount: 30,
        aggressiveActions: 20,
        passiveActions: 0, // AF = 5
      });
      expect(result.style).toBe('maniac');
    });

    it('should handle zero aggressiveActions AND zero passiveActions (AF = 1)', () => {
      const result = playerStyleClassifier.classify({
        handsPlayed: 100,
        vpipCount: 10,
        pfrCount: 5,
        aggressiveActions: 0,
        passiveActions: 0, // AF = 1
      });
      // VPIP = 10%, PFR = 5% → nit (VPIP < 12, PFR < 8)
      expect(result.style).toBe('nit');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // CONVENIENCE METHODS
  // ─────────────────────────────────────────────────────────────────────────

  describe('getStyleLabel', () => {
    it('should return "icon label" format', () => {
      const label = playerStyleClassifier.getStyleLabel({
        handsPlayed: 100,
        vpipCount: 22,
        pfrCount: 18,
        aggressiveActions: 30,
        passiveActions: 10,
      });
      expect(label).toBe('S Shark');
    });

    it('should return "? ?" for insufficient data', () => {
      const label = playerStyleClassifier.getStyleLabel({
        handsPlayed: 5,
        vpipCount: 1,
        pfrCount: 0,
      });
      // Unknown icon moved from '❓' to '?' 2026-08, so the label is now '? ?'.
      expect(label).toBe('? ?');
    });
  });

  describe('getStyleDefinitions', () => {
    it('should return all 9 style definitions', () => {
      const defs = playerStyleClassifier.getStyleDefinitions();
      expect(Object.keys(defs).length).toBe(9);
      // 2026-08-16: every icon is now a letter. Shark and Fish were the last
      // two emoji left over from the 2026-08 migration; unknown had already
      // moved from the emoji question mark to a plain '?'.
      expect(defs.shark.icon).toBe('S');
      expect(defs.fish.icon).toBe('F');
      expect(defs.unknown.icon).toBe('?');
      expect(defs.rock.icon).toBe('R');
      expect(defs.maniac.icon).toBe('M');
      expect(defs.tag.icon).toBe('T');
      expect(defs.lag.icon).toBe('L');
      expect(defs.nit.icon).toBe('N');
      expect(defs.calling_station.icon).toBe('CS');
    });

    it('should return a copy (not mutate original)', () => {
      const defs1 = playerStyleClassifier.getStyleDefinitions();
      const defs2 = playerStyleClassifier.getStyleDefinitions();
      expect(defs1).not.toBe(defs2);
      expect(defs1).toEqual(defs2);
    });
  });
});
