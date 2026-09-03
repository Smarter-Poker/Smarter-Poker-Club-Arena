/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE SPIN BUY-IN SHEET SHOWS THE ODDS THE DRAW ACTUALLY USES (2026-08-29)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Enhancement from the round-9 sweep: the seat-first confirmation sheet for a
 * Spin now carries the multiplier ladder - prize at this stake, odds as
 * "1 In N", payout split - behind a toggle so the 375px sheet keeps Buy In
 * above the fold.
 *
 * The invariant that matters: every displayed number is DERIVED from
 * SPIN_TIERS through spinOddsTable. A hand-written odds table beside the real
 * ladder is how a wheel change quietly turns into false advertising, which on
 * a money product is worse than no table at all.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SPIN_TIERS, SPIN_FREQ_DENOMINATOR, spinOddsTable } from '../../src/config/spinSpec';
import { sliceEnclosingBlock } from '../helpers/sourceWindow';

const TABLE_PAGE = readFileSync(
  join(__dirname, '..', '..', 'src', 'pages', 'TablePage.tsx'),
  'utf8'
);

describe('spinOddsTable derives entirely from the ladder', () => {
  const rows = spinOddsTable();

  it('carries exactly one row per tier, ascending', () => {
    expect(rows.map((r) => r.multiplier)).toEqual(
      SPIN_TIERS.map((t) => t.multiplier).sort((a, b) => a - b)
    );
  });

  it('prices the odds from the real frequencies', () => {
    for (const tier of SPIN_TIERS) {
      const row = rows.find((r) => r.multiplier === tier.multiplier)!;
      expect(row.oneIn).toBe(Math.round(SPIN_FREQ_DENOMINATOR / tier.freq));
    }
    // Spot checks a human can read: the everyday 2x is roughly a coin flip
    // territory, the 100x is the roughly-1-in-10,000 event the retirement
    // note promises ("about 1 in 9,921").
    expect(rows.find((r) => r.multiplier === 2)!.oneIn).toBe(2);
    expect(rows.find((r) => r.multiplier === 100)!.oneIn).toBe(9921);
  });

  it('labels the split by place', () => {
    expect(rows.find((r) => r.multiplier === 2)!.payoutLabel).toBe('Winner Takes All');
    expect(rows.find((r) => r.multiplier === 10)!.payoutLabel).toBe('80% / 20%');
    expect(rows.find((r) => r.multiplier === 100)!.payoutLabel).toBe('80% / 12% / 8%');
  });
});

describe('the sheet renders the ladder from the spec, spins only', () => {
  const odds = sliceEnclosingBlock(TABLE_PAGE, 'seat-buyin-confirm__odds-table', 0, 4);

  it('is gated to Spins - a Heads-Up has no wheel', () => {
    const gate = sliceEnclosingBlock(TABLE_PAGE, "seatFirstBuyIn.label === 'Spin'", 0, 1);
    expect(gate).toContain('seat-buyin-confirm__odds');
  });

  it('maps spinOddsTable() - never a hand-written copy of the tiers', () => {
    expect(odds).toContain('spinOddsTable().map');
    // No literal frequency from the ladder may appear in the page.
    expect(TABLE_PAGE).not.toContain('4_772_073');
    expect(TABLE_PAGE).not.toContain('3_968_518');
  });

  it('prices the prize at this stake from the sheet cost', () => {
    expect(odds).toContain('seatFirstBuyIn.cost * row.multiplier');
  });

  it('collapses when the sheet closes', () => {
    const reset = sliceEnclosingBlock(TABLE_PAGE, 'setSpinOddsOpen(false)', 0, 2);
    expect(reset).toContain('seatFirstConfirm === null');
  });
});
