/**
 * BBJ table-widget label helper — per-variant qualifying text (2026-08-18).
 *
 * The on-table jackpot widget used to hardcode "Quad 8s or better" for every
 * game. These tests pin the normalizer (variant keys AND display names) and
 * the eligibility gate (PLO6 / Short Deck must render NO widget).
 */
import { describe, it, expect } from 'vitest';
import {
  normalizeVariantKey,
  getBBJQualifyingInfo,
  getBBJPayoutPercentForBB,
  BBJ_QUALIFYING_HANDS,
} from '../src/config/RakeConfig';

describe('normalizeVariantKey', () => {
  it('passes through known variant keys', () => {
    for (const key of [
      'nlh',
      'flh',
      'plo4',
      'plo',
      'plo8',
      'plo_hilo',
      'plo5',
      'plo6',
      'short_deck',
    ]) {
      expect(normalizeVariantKey(key)).toBe(key);
    }
  });

  it('maps hold-em display names', () => {
    expect(normalizeVariantKey("No Limit Hold'em")).toBe('nlh');
    expect(normalizeVariantKey("Fixed Limit Hold'em")).toBe('flh');
    expect(normalizeVariantKey('NLH')).toBe('nlh');
  });

  it('maps Omaha display names by card count', () => {
    expect(normalizeVariantKey('Pot Limit Omaha')).toBe('plo4');
    expect(normalizeVariantKey('PLO5')).toBe('plo5');
    expect(normalizeVariantKey('Pot Limit Omaha Hi-Lo')).toBe('plo8');
    expect(normalizeVariantKey('PLO6')).toBe('plo6');
  });

  it('maps short deck and defaults unknowns to nlh', () => {
    expect(normalizeVariantKey('Short Deck')).toBe('short_deck');
    expect(normalizeVariantKey(undefined)).toBe('nlh');
    expect(normalizeVariantKey('')).toBe('nlh');
    expect(normalizeVariantKey('mystery game')).toBe('nlh');
  });
});

describe('getBBJQualifyingInfo', () => {
  it('gives NLH the aces-full-of-jacks rule (never "Quad 8s")', () => {
    const info = getBBJQualifyingInfo("No Limit Hold'em");
    expect(info.eligible).toBe(true);
    expect(info.shortLabel).toContain('Aces full of Jacks');
    expect(info.shortLabel).not.toContain('Quad 8s');
    expect(info.subLabel).toContain('Both hole cards');
  });

  it('gives PLO4 the quad-kings rule with the two-card requirement', () => {
    const info = getBBJQualifyingInfo('plo4');
    expect(info.eligible).toBe(true);
    expect(info.shortLabel).toContain('Quad Kings');
    expect(info.subLabel).toContain('two hole cards');
  });

  it('gives PLO5 the 8-high straight flush rule', () => {
    const info = getBBJQualifyingInfo('plo5');
    expect(info.eligible).toBe(true);
    expect(info.shortLabel).toContain('Straight Flush');
  });

  it('marks PLO6 and Short Deck ineligible (matches the server detector)', () => {
    expect(getBBJQualifyingInfo('plo6').eligible).toBe(false);
    expect(getBBJQualifyingInfo('short_deck').eligible).toBe(false);
    expect(BBJ_QUALIFYING_HANDS.plo6.eligible).toBe(false);
    expect(BBJ_QUALIFYING_HANDS.short_deck.eligible).toBe(false);
  });
});

describe('getBBJPayoutPercentForBB', () => {
  it('mirrors the server tier boundaries exactly (server/src/config/RakeConfig.ts getTierForBB)', () => {
    // boundary, expected percent — from the server file, NOT the client tier table
    const cases: Array<[number, number]> = [
      [0.1, 15],
      [0.2, 15], // nano top edge
      [0.4, 25],
      [0.8, 25], // micro top edge
      [1, 40],
      [3, 40], // small top edge
      [4, 55],
      [8, 55], // mid top edge
      [10, 70],
      [40, 70], // high top edge
      [50, 85],
      [500, 85],
    ];
    for (const [bb, pct] of cases) {
      expect(getBBJPayoutPercentForBB(bb)).toBe(pct);
    }
  });

  it('handles string blinds and garbage input', () => {
    expect(getBBJPayoutPercentForBB('2')).toBe(40);
    expect(getBBJPayoutPercentForBB('not-a-number')).toBe(15);
  });
});

describe('BBJ rules panel data integrity (2026-08-18)', () => {
  it('every variant row the panel renders resolves to a real config entry', () => {
    // The panel iterates these keys; a typo would silently render a blank rule.
    for (const key of ['nlh', 'plo4', 'plo8', 'plo5', 'plo6', 'short_deck']) {
      expect(BBJ_QUALIFYING_HANDS[key], `missing config for ${key}`).toBeDefined();
    }
  });

  it('eligible variants always produce a non-empty player-facing rule', () => {
    for (const key of Object.keys(BBJ_QUALIFYING_HANDS)) {
      const info = getBBJQualifyingInfo(key);
      expect(info.shortLabel.length).toBeGreaterThan(0);
      if (info.eligible) {
        // Never ship a rule that says "Quad 2s"/"Quad 8s" again — those were
        // the two wrong hardcoded strings this work removed.
        expect(info.shortLabel).not.toMatch(/Quad [28]s/);
      }
    }
  });

  it('payout tiers are monotonic across the stakes ladder', () => {
    const ladder = [0.2, 0.8, 3, 8, 40, 50].map(getBBJPayoutPercentForBB);
    for (let i = 1; i < ladder.length; i++) {
      expect(ladder[i]).toBeGreaterThan(ladder[i - 1]);
    }
    expect(ladder[0]).toBe(15);
    expect(ladder[ladder.length - 1]).toBe(85);
  });
});

describe('BBJ modal highlighting — "your game" / "your stakes" (2026-08-18)', () => {
  // The modal marks the row for the table you are sitting at. Aliases must
  // collapse onto the row that actually renders, or nothing gets marked.
  const rowKeyFor = (variant: string) => {
    const k = normalizeVariantKey(variant);
    return k === 'flh' ? 'nlh' : k === 'plo' ? 'plo4' : k === 'plo_hilo' ? 'plo8' : k;
  };
  const RENDERED_ROWS = ['nlh', 'plo4', 'plo8', 'plo5', 'plo6', 'short_deck'];

  it('every variant a table can report maps onto a rendered row', () => {
    const tableVariants = [
      'nlh',
      'flh',
      'plo',
      'plo4',
      'plo5',
      'plo6',
      'plo8',
      'plo_hilo',
      'short_deck',
      "No Limit Hold'em",
      "Fixed Limit Hold'em",
      'Pot Limit Omaha',
      'Pot Limit Omaha Hi-Lo',
      'Short Deck',
    ];
    for (const v of tableVariants) {
      expect(RENDERED_ROWS, `${v} -> ${rowKeyFor(v)}`).toContain(rowKeyFor(v));
    }
  });

  it('a stakes highlight matches exactly one tier percentage', () => {
    const tierPcts = [0.2, 0.8, 3, 8, 40, 50].map(getBBJPayoutPercentForBB);
    // A real table BB must light up exactly one row of the ladder.
    for (const bb of [0.1, 0.2, 0.5, 1, 2, 5, 10, 25, 100]) {
      const pct = getBBJPayoutPercentForBB(bb);
      expect(tierPcts.filter((p) => p === pct)).toHaveLength(1);
    }
  });
});
