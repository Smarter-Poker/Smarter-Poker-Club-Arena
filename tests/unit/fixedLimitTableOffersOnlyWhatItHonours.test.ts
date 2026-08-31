/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  A FIXED-LIMIT TABLE MUST NOT OFFER WHAT THE ENGINE CANNOT HONOUR
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * From the game-creation audit Dan asked for, 2026-08-31. Four controls on the
 * create-table form wrote settings the engine then ignored or mishandled. Each
 * is a promise the felt does not keep, which is worse than a missing feature:
 * the owner advertises it and the players never see it.
 *
 *  1. SEVEN-DEUCE was offered on `flh`, `limit_holdem`, `nlhe` and `pineapple`.
 *     The engine gate is a string equality — `(game_variant || 'nlh') === 'nlh'`
 *     — so none of those four could ever be paid.
 *  2. STRADDLE was offered on limit tables. `HandController` posts one by
 *     assigning `state.currentBet` with no structure branch, and a straddle is
 *     not counted by `fixedLimitWagerCount`, so the street gains a betting
 *     round the four-wager cap exists to prevent.
 *  3. CAP was offered on limit tables. `ServerTableEngineTurns` assigns the
 *     mandatory fixed size and THEN clamps it with
 *     `Math.min(amount, capRemaining)`, which can emit a wager that is not a
 *     legal size.
 *  4. The BOMB-POT VARIANT OVERRIDE could hand a limit table one pot-limit
 *     hand. That one is refused in the engine as well (see
 *     `resolveBombPotVariant`); this pins the form.
 *
 * Asserted against the SOURCE, the same way `limitUserIntent.test.ts` pins the
 * create-table cards: the page is 2,700 lines with no exported seam here, and a
 * render test would be asserting React rather than the rule.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isFixedLimitVariant } from '../../src/lib/bettingStructure';

const page = readFileSync(join(process.cwd(), 'src/pages/TableConfigPage.tsx'), 'utf8');

describe('the seven-deuce bounty is offered only where it is paid', () => {
  it('lists exactly the variant the engine settles on', () => {
    const line = page.match(/const SEVEN_DEUCE_VARIANTS = new Set\(\[([^\]]*)\]\)/);
    expect(line, 'SEVEN_DEUCE_VARIANTS not found').toBeTruthy();
    const variants = line![1]
      .split(',')
      .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
      .filter(Boolean);
    expect(variants).toEqual(['nlh']);
  });

  it('does not offer it on a limit or pineapple table', () => {
    // Each of these reached the toggle and wrote seven_deuce_enabled: true,
    // and none of them could ever be paid.
    for (const dead of ['flh', 'limit_holdem', 'pineapple', 'nlhe']) {
      expect(page).not.toMatch(new RegExp(`SEVEN_DEUCE_VARIANTS[^)]*'${dead}'`));
    }
  });
});

describe('the three controls a limit table cannot honour', () => {
  it('knows which games are fixed limit', () => {
    // The predicate the page's gate is built on. If this stops being true the
    // assertions below are checking nothing.
    expect(isFixedLimitVariant('flh')).toBe(true);
    expect(isFixedLimitVariant('flo8')).toBe(true);
    expect(isFixedLimitVariant('nlh')).toBe(false);
    expect(isFixedLimitVariant('plo4')).toBe(false);
  });

  it('computes the limit gate once, from the route variant', () => {
    expect(page).toMatch(/const limitGame = isFixedLimitGame\(gameType\)/);
  });

  it('forces straddle off in the written row, not only in the UI', () => {
    // Hiding a control is not enough: a template saved on a no-limit table can
    // carry `autoUtgStraddle: true` onto a limit one.
    expect(page).toMatch(/auto_utg_straddle:\s*!limitGame && config\.autoUtgStraddle/);
    expect(page).toMatch(/voluntary_straddle:\s*!limitGame && config\.voluntaryStraddle/);
    expect(page).toMatch(/straddle_enabled:\s*!limitGame &&/);
  });

  it('forces the cap off in the written row', () => {
    expect(page).toMatch(/cap_enabled:\s*!limitGame && config\.capEnabled/);
    expect(page).toMatch(/cap_bb:\s*!limitGame && config\.capEnabled/);
  });

  it('forces the bomb-pot variant override off in the written row', () => {
    expect(page).toMatch(/bomb_pot_variant:\s*\n?\s*!limitGame &&/);
  });

  it('hides all three controls rather than leaving them dead on screen', () => {
    // A disabled control still says the feature exists. These are gated out.
    expect(page).toMatch(/\{!limitGame && \(/);
    expect(page).toMatch(/label="Auto UTG Straddle"/);
    expect(page).toMatch(/limitGame \? \{ display: 'none' \} : undefined/);
  });
});
