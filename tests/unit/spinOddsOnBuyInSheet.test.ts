/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE LADDER IS THE PLATFORM'S OWN CHECK, AND NO PLAYER EVER SEES IT
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * This file used to pin the OPPOSITE of what it pins now, and the flip is
 * Dan's, verbatim (2026-09-05, binding):
 *
 *   "HIDE THE MULTIPLIER ODDS, GET RIDE OF THAT ALL TOGETHER, NOBODY SHOULD
 *    EVER VISIBLY SEE THAT."
 *
 * From 2026-08-29 the seat-first buy-in sheet carried a "Show Multiplier Odds"
 * disclosure listing every tier, its prize at that stake, its 1-in frequency
 * and its payout split. It is deleted - markup, state and CSS - and this spec
 * is what stops it coming back, because a deleted surface with a passing test
 * still asserting it should exist is how the next agent decides it is missing
 * and rebuilds it.
 *
 * `spinOddsTable()` itself STAYS, and so does every derivation check below.
 * It is not a display helper; it is how the fairness guard and the ladder law
 * measure the draw against the spec. What changed is that it has no render
 * path, and that is now the assertion.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SPIN_TIERS, SPIN_FREQ_DENOMINATOR, spinOddsTable } from '../../src/config/spinSpec';

const SRC_DIR = join(__dirname, '..', '..', 'src');
const TABLE_PAGE = readFileSync(join(SRC_DIR, 'pages', 'TablePage.tsx'), 'utf8');
const TABLE_CSS = readFileSync(join(SRC_DIR, 'pages', 'TablePage.css'), 'utf8');

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

describe('no player-facing surface shows the odds (Dan 2026-09-05)', () => {
  it('the buy-in sheet does not call spinOddsTable', () => {
    expect(TABLE_PAGE).not.toContain('spinOddsTable()');
    // The import went with the call site. A live import is a render path
    // waiting to be re-used.
    expect(/import\s*\{[^}]*\bspinOddsTable\b[^}]*\}\s*from/.test(TABLE_PAGE)).toBe(false);
  });

  it('the odds toggle and its table are gone from the markup', () => {
    for (const gone of [
      'Show Multiplier Odds',
      'Hide Multiplier Odds',
      'seat-buyin-confirm__odds-table',
      'seat-buyin-confirm__odds-toggle',
      'seat-buyin-confirm__odds-row',
      'spinOddsOpen',
      'setSpinOddsOpen',
    ]) {
      expect(TABLE_PAGE).not.toContain(gone);
    }
  });

  it('the styling went with the markup, so nothing looks unfinished', () => {
    for (const gone of [
      '.seat-buyin-confirm__odds-table',
      '.seat-buyin-confirm__odds-toggle',
      '.seat-buyin-confirm__odds-row',
    ]) {
      expect(TABLE_CSS).not.toContain(gone);
    }
  });

  it('no frequency from the ladder is printed anywhere on the page', () => {
    /* DERIVED, NOT LISTED (2026-09-05). This named `4_772_073` and `3_968_518`
       verbatim. The 2026-09-05 rebalance retired both, so the guard went on
       asserting that two numbers which exist nowhere are absent - green, and
       blind to the frequencies that actually ship. Dan's rule is about the
       LADDER ("NOBODY SHOULD EVER VISIBLY SEE THAT"), so the ladder is what it
       reads. */
    for (const tier of SPIN_TIERS) {
      const plain = String(tier.freq);
      const underscored = plain.replace(/\B(?=(\d{3})+(?!\d))/g, '_');
      /* Only the two seven-figure rungs. The rest of the ladder is round -
         100000, 250000, 1000, 7500, 1008 - and both `1_000` and `100000` are
         ordinary timeouts, widths and z-indexes in this file. A guard that
         fails on a z-index gets deleted by the next agent, which is worse than
         a guard with a stated edge. The two big rungs cannot appear by
         accident, and they are the ones that change when the ladder is
         retuned, so they are what this watches; the odds SURFACE is pinned
         separately above by 'oneIn', '1 In ' and the deleted CSS. */
      if (tier.freq >= 1_000_000) {
        expect(TABLE_PAGE, `${tier.multiplier}x frequency is on the page`).not.toContain(plain);
        expect(TABLE_PAGE, `${tier.multiplier}x freq literal is on the page`).not.toContain(
          underscored
        );
      }
    }
    expect(TABLE_PAGE).not.toContain('1 In ');
    expect(TABLE_PAGE).not.toContain('oneIn');
  });
});
