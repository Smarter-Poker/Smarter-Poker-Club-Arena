/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  EVERY LEAK TAG CARRIES A DENOMINATOR (2026-09-05)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * detectLeaks used to `return tags` as soon as the hand won, so 21 of its 23
 * tags existed only on losses. A tag that only fires on a loss cannot be
 * ranked: its total measures how often the shape occurs in big pots, never
 * whether the shape is a mistake.
 *
 * It was found and fixed twice, one tag at a time - river_aggr (2026-09-01),
 * river_raise_war (2026-09-02) - each time noting "same fix, same naming
 * rule". Nobody generalised it, so twenty-one tags kept the defect.
 *
 * WHAT THE ONE-SIDED RANKING SAID, measured over 7 days on 2026-09-05:
 *
 *   river_aggr_lost   27,486 hands   -1,941,955bb   <- "the biggest leak"
 *   big_bet_fold      17,142 hands     -599,131bb
 *   coldcall_stackoff  4,572 hands     -396,270bb
 *
 * WHAT THE MIRROR SAYS. river_aggr_won carries 43,282 hands and +2,551,149bb,
 * so river aggression is +609,194bb NET and profitable in six of seven
 * variants. Only NLH is negative at all (-11,816bb over 15,201 hands, 52.3%
 * wins) and that is ~1.4 sigma from zero - not a finding. Tightening the
 * horses off river aggression, which the one-sided table plainly invited,
 * would have removed a winning line and made them easier to beat.
 *
 * THE LAW.
 *   1. Outcome-independent situations record both sides: `x` on a loss,
 *      `x_won` on a win.
 *   2. The fold family is NOT mirrored and must not be - big_bet_fold,
 *      big_fold_river, big_fold_early and bet_fold_line all require a fold,
 *      and a folded hand never wins. Their negative net IS the fold.
 *   3. Loss-side names never change. HorseSelfTuner matches exact strings
 *      (nonnut_flush_stackoff, big_bet_fold, preflop_stackoff, ...), so a
 *      rename silently stops the tuner seeing a leak.
 *
 * Registry: docs/laws.d/server-src-services-EveryLeakTagHasADenominator.md
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REVIEW = readFileSync(resolve(HERE, 'HorseHandReview.ts'), 'utf8');
const TUNER = readFileSync(resolve(HERE, 'HorseSelfTuner.ts'), 'utf8');
const CODE = REVIEW.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

/** Situations that exist whether the hand won or lost. */
const MIRRORED = [
  'limped_pot_bloat',
  'coldcall_stackoff',
  'nonnut_flush_stackoff',
  'second_nut_flush_stackoff',
  'dominated_straight_stackoff',
  'preflop_stackoff',
  'river_raise_paidoff',
  'straight_into_flush_stackoff',
  'nonnut_straight_stackoff',
  'underfull_stackoff',
  'weak_kicker_trips_stackoff',
  'top_pair_weak_kicker_stackoff',
  'plo_underfull_stackoff',
  'plo_toppair_no_redraw_stackoff',
];

/** Requires a fold, so it can never have a win side. */
const FOLD_ONLY = ['big_bet_fold', 'big_fold_river', 'big_fold_early', 'bet_fold_line'];

/** The exact strings HorseSelfTuner matches on. Renaming one blinds it. */
const TUNER_READS = [
  'nonnut_flush_stackoff',
  'second_nut_flush_stackoff',
  'dominated_straight_stackoff',
  'big_bet_fold',
  'preflop_stackoff',
];

describe('every leak tag carries a denominator', () => {
  it('the win-side early return is gone', () => {
    // The single line that made twenty-one tags unrankable: a `return tags`
    // reached whenever the hand won, before any situation was recorded.
    expect(CODE).not.toMatch(/if \(row\.netBB > 0\)[\s\S]{0,600}?return tags;/);
    expect(CODE).toContain('const won = row.netBB > 0;');
  });

  it('every outcome-independent situation goes through flag()', () => {
    for (const tag of MIRRORED) {
      expect(CODE, `${tag} must be recorded on both sides`).toContain(`flag('${tag}')`);
      expect(CODE, `${tag} must not be pushed loss-only`).not.toContain(`tags.push('${tag}')`);
    }
  });

  it('flag records the win side under a _won name', () => {
    expect(CODE).toMatch(/tags\.push\(won \? `\$\{name\}_won` : name\)/);
  });

  it('the river pair keeps its historical spellings', () => {
    // river_aggr_won and river_raise_war_won predate this change and four
    // months of rows carry them. Renaming would orphan that history.
    expect(CODE).toContain("tags.push(won ? 'river_aggr_won' : 'river_aggr_lost')");
    expect(CODE).toContain("tags.push(won ? 'river_raise_war_won' : 'river_raise_war')");
  });

  it('the fold family stays one-sided, and says why', () => {
    expect(CODE).toContain('if (!won && folded && investedBB >= FLAG_BB)');
    for (const tag of FOLD_ONLY) {
      expect(CODE, `${tag} must never be mirrored`).not.toContain(`flag('${tag}')`);
    }
  });

  it('no loss-side name the tuner matches has been renamed', () => {
    for (const tag of TUNER_READS) {
      expect(REVIEW, `${tag} is emitted`).toContain(`'${tag}'`);
      expect(TUNER, `${tag} is still read by the tuner`).toContain(`'${tag}'`);
    }
  });

  it('the tuner is not fed the mirrors by accident', () => {
    // The _won names must not appear in the tuner: it counts leaks, and a win
    // is not a leak. When the tuner eventually moves to EV it should do so
    // deliberately, with a league run behind it.
    expect(TUNER).not.toMatch(/_won'/);
  });

  it('tags are de-duplicated', () => {
    // nonnut_flush_stackoff is reachable from the Omaha block and the NLH
    // board-demotion block both.
    expect(CODE).toContain('return [...new Set(tags)]');
  });
});
