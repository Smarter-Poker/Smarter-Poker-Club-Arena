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
/**
 * 2026-09-04 (Operation Table Stakes, Slice 1): the cash create path is
 * fn_cash_game_create in SQL, fed by CashGameCreateFlow.tsx. The four
 * controls this file is about are not a limit-table special case any more:
 * OPORD 1.3 section 8 takes straddles, caps and the bomb-pot variant
 * override off EVERY cash game (R2), so a limit table cannot be offered them
 * because nobody can. The pins move to where that is written.
 */
const sql = readFileSync(
  join(process.cwd(), 'supabase/migrations/20260904230000_cash_games_slice_1_hardening.sql'),
  'utf8'
);
const flow = readFileSync(
  join(process.cwd(), 'src/components/cash/CashGameCreateFlow.tsx'),
  'utf8'
);
const tablesInsert = (() => {
  const at = sql.indexOf('INSERT INTO public.tables (');
  const end = sql.indexOf('RETURNING id INTO v_table_id', at);
  if (at < 0 || end < 0) throw new Error('fn_cash_game_create: tables INSERT not found');
  return sql.slice(at, end);
})();

describe('the seven-deuce bounty is offered only where it is paid', () => {
  it('lists exactly the variant the engine settles on', () => {
    // The gate is the same string equality the engine uses.
    expect(sql).toMatch(/'seven_deuce_enabled', [^\n]* AND v_v = 'nlh'/);
    expect(flow).toMatch(/\{variant === 'nlh' && \(\s*<Toggle\s*label="Seven Deuce Bonus"/);
  });

  it('does not offer it on a limit or pineapple table', () => {
    // Each of these reached the toggle and wrote seven_deuce_enabled: true,
    // and none of them could ever be paid.
    for (const dead of ['flh', 'limit_holdem', 'pineapple', 'nlhe']) {
      expect(sql).not.toMatch(new RegExp(`seven_deuce_enabled[^\\n]*'${dead}'`));
    }
  });
});

describe('the three controls a limit table cannot honour', () => {
  it('knows which games are fixed limit', () => {
    // The predicate the stakes ladder is built on. If this stops being true
    // the assertions below are checking nothing.
    expect(isFixedLimitVariant('flh')).toBe(true);
    expect(isFixedLimitVariant('flo8')).toBe(true);
    expect(isFixedLimitVariant('nlh')).toBe(false);
    expect(isFixedLimitVariant('plo4')).toBe(false);
  });

  it('computes the limit gate once, from the chosen variant', () => {
    expect(flow).toMatch(/const limitGame = isFixedLimitVariant\(variant\)/);
    // The tournament tabs have no limit-only control left to gate.
    expect(page).not.toContain('limitGame');
  });

  it('forces straddle off in the written row, not only in the UI', () => {
    // R2: the straddle lane is folded on every cash game, limit or not.
    expect(tablesInsert).toMatch(/straddle_enabled, auto_utg_straddle, voluntary_straddle,/);
    expect(tablesInsert).toMatch(/^\s*false, false, false,\s*$/m);
    expect(sql).toMatch(/'straddle', false/);
  });

  it('writes no cap at all, so the row keeps the column default of false', () => {
    // 010_table_configuration.sql: cap_enabled BOOLEAN DEFAULT false.
    expect(tablesInsert).not.toMatch(/\bcap_enabled\b/);
    expect(tablesInsert).not.toMatch(/\bcap_bb\b/);
  });

  it('writes no bomb-pot variant override, so a bomb hand plays the table variant', () => {
    expect(tablesInsert).not.toMatch(/\bbomb_pot_variant\b/);
  });

  it('offers none of the three, rather than leaving them dead on screen', () => {
    expect(flow).not.toMatch(/label="Auto UTG Straddle"/);
    expect(flow).not.toMatch(/label="Cap"/);
    expect(flow).not.toMatch(/bomb_pot_variant/);
    expect(flow.replace(/\s+/g, ' ')).toContain('Straddles Are Off');
  });
});
