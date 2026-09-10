/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  CHIPS ON THE FELT ARE NEVER ABBREVIATED (Dan 2026-08-28, binding)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Dan, verbatim: "CHIPS SHOULD ALWAYS BE DISPLAYED IN [WHOLE] NUMBERS, NEVER
 * ROUNDED OR SHORTENED, IT SHOULD DISPLAY 68,750 AND 117,000."
 *
 * Reported against a live PKO final table, where the hero's 117,000 stack
 * rendered as "117K". That is not a stack, it is a range 500 chips wide
 * standing in for a number the player is about to act on.
 *
 * Five separate copies of the same K/M ladder had accumulated across the table
 * components, each drifting its own thresholds - SeatSlot switched to "K" at
 * 100,000 with no decimal, ActionPanel at 10,000 with one, and ChipAnimation
 * had no ceiling at all until 2026-08-25, so a 5M pot flew to its winner
 * labelled "5000.0K". They are one function now.
 *
 * BOTH DIRECTIONS ARE PINNED HERE. The first pass at the fix floored
 * everything >= 1 and turned a typed 13.37 raise into "13" - the same lie with
 * the sign flipped, and it broke the bet-granularity spec. Abbreviating and
 * truncating are both "rounded or shortened".
 *
 * `fmtChips` (the lobby's "1.5K") was left alone when this was written and
 * retired on 2026-09-10 under Dan's 2026-09-04 "ABSOLUTELY ZERO ROUNDING
 * ANYWHERE EVER": every surface now formats through the same family, and
 * tests/money-is-displayed-one-way.law.test.ts keeps it that way.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

import { formatStackChips, formatTableChips } from '../../src/utils/format';
import * as format from '../../src/utils/format';

const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf8');

/** Strip comments so a guard cannot pass or fail on prose. */
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

/** Every component that draws a chip amount while a hand is live. */
const FELT = [
  'src/components/table/SeatSlot.tsx',
  'src/components/table/ActionPanel.tsx',
  'src/components/table/ChipPhysics.tsx',
  'src/components/table/ChipAnimation.tsx',
  'src/components/table/HandHistoryPanel.tsx',
];

describe('formatTableChips - the one chip formatter for the table', () => {
  it('never abbreviates, at any magnitude', () => {
    expect(formatTableChips(117000)).toBe('117,000');
    expect(formatTableChips(247100)).toBe('247,100');
    expect(formatTableChips(68750)).toBe('68,750');
    expect(formatTableChips(1_000_000)).toBe('1,000,000');
    expect(formatTableChips(5_432_100)).toBe('5,432,100');
  });

  it('never truncates a real fraction away', () => {
    // The typed-raise case. 13.37 is what the player asked for.
    expect(formatTableChips(13.37)).toBe('13.37');
    expect(formatTableChips(0.5)).toBe('0.50');
    expect(formatTableChips(0.25)).toBe('0.25');
  });

  it('keeps integers clean - no trailing .00', () => {
    expect(formatTableChips(1500)).toBe('1,500');
    expect(formatTableChips(23)).toBe('23');
  });

  it('survives the values that reach it from a dead seat or a failed read', () => {
    expect(formatTableChips(0)).toBe('0');
    expect(formatTableChips(null)).toBe('0');
    expect(formatTableChips(undefined)).toBe('0');
    expect(formatTableChips(NaN)).toBe('0');
    expect(formatTableChips(Infinity)).toBe('0');
  });

  it('keeps the sign on a negative rather than dropping it', () => {
    expect(formatTableChips(-1500)).toBe('-1,500');
  });
});

describe('formatStackChips - a stack under 100 reads to the penny (Dan 2026-09-04)', () => {
  it('shows two places under 100, "99.99 down to .01"', () => {
    // A 0.02/0.05 stack of 5.37 rendered as "5" on the seat.
    expect(formatStackChips(5.37)).toBe('5.37');
    expect(formatStackChips(5)).toBe('5.00');
    expect(formatStackChips(99.99)).toBe('99.99');
    expect(formatStackChips(0.01)).toBe('0.01');
    expect(formatStackChips(0)).toBe('0.00');
    // Engine float noise is squared off at the cent, never at the chip.
    expect(formatStackChips(23.0000001)).toBe('23.00');
    expect(formatStackChips(-5.5)).toBe('-5.50');
  });

  it('is whole chips from 100 up, never abbreviated', () => {
    expect(formatStackChips(100)).toBe('100');
    expect(formatStackChips(113.37)).toBe('113');
    expect(formatStackChips(1518)).toBe('1,518');
    expect(formatStackChips(117000)).toBe('117,000');
    expect(formatStackChips(NaN)).toBe('0');
  });

  it('is what the seat badge uses, and the seat never rounds a stack itself', () => {
    const seat = read('src/components/table/SeatSlot.tsx');
    expect(seat).toContain('return formatStackChips(amount);');
    expect(seat).not.toContain('amount >= 1 ? Math.round(amount) : amount');
  });

  it('the abbreviating lobby formatter no longer exists to be reached for', () => {
    expect((format as Record<string, unknown>).fmtChips).toBeUndefined();
  });
});

describe('no table surface grows its own K/M ladder again', () => {
  for (const file of FELT) {
    it(`${file} has no K/M abbreviation of its own`, () => {
      const src = code(read(file));
      expect(src, 'K suffix').not.toMatch(/toFixed\(\d\)\s*\}\s*K/);
      expect(src, 'M suffix').not.toMatch(/toFixed\(\d\)\s*\}\s*M/);
    });

    it(`${file} formats chips through the shared formatter`, () => {
      expect(read(file)).toMatch(/formatTableChips/);
    });

    it(`${file} does not reach for the lobby's abbreviating formatter`, () => {
      expect(code(read(file))).not.toMatch(/\bfmtChips\b/);
    });
  }
});
