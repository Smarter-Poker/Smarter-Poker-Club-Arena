/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  A DIAMOND TABLE HAS ONE SHAPE, AND BOTH SIDES NAME THE SAME COLUMNS
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * WHY THIS EXISTS (2026-09-12)
 *
 * "Is this a plain Diamond cash table" was answered in six places: five SQL
 * functions and the engine's own boundary. On the morning of 2026-09-12 the
 * five SQL copies had six different md5s and three different answers, and both
 * kinds of error were live at once.
 *
 *   TOO STRICT. `fn_poker_diamond_top_up` was written before straddles, run it
 *   twice and bomb pots were permitted, and none of the three migrations that
 *   permitted them lifted its refusal. A table with any of them on could be
 *   bought into, seated and dealt, and the player could then never top up.
 *
 *   TOO LOOSE, which is the direction that costs money. It read an UNSET rake
 *   as zero and never read `rake_cap_bb` at all. UNSET IS NOT OFF in this
 *   arena: the engine reads an absent column as the CHIP schedule's default,
 *   so a table admitted on a NULL is a table the engine then refuses to load,
 *   with the player's Diamonds already reserved into a seat that cannot deal.
 *
 * The SQL half is one function now, `fn_poker_diamond_plain_cash_table`, and
 * every Diamond money door and staff door reads it. This law guards the half
 * that a shared SQL function cannot: the engine's TypeScript boundary is the
 * SIXTH copy, it runs in a different language in a different process, and
 * nothing but this test can notice when one of the two learns about a column
 * and the other does not.
 *
 * WHAT IS COMPARED, AND WHAT IS NOT. The two must name the same columns. They
 * must NOT phrase the rule identically: SQL says `IS DISTINCT FROM 0` where
 * TypeScript says `typeof !== 'number' || !== 0`, because a NULL and an absent
 * key are the same fact expressed in two type systems. So the assertion is on
 * the SET OF COLUMNS each one decides with, which is the thing that drifts.
 *
 * The per-hand checks are deliberately outside it. Whole blinds, a whole ante
 * and the bomb-pot ante live only in the boundary because they are arithmetic
 * about a hand rather than the shape of a row, and the SQL doors carry their
 * own whole-amount check separately.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { sliceBetween, sliceMethod } from './helpers/sourceWindow';

const at = (p: string) => readFileSync(resolve(__dirname, '..', p), 'utf8');

const MIGRATION =
  'supabase/migrations/20260912061500_one_rule_says_what_a_plain_diamond_cash_table_is.sql';
const BOUNDARY = 'server/src/domain/DiamondCashBoundary.ts';

/** Every column the rule decides with, in the order it does not matter. */
const SHAPE_COLUMNS = [
  'all_in_or_fold',
  'allow_run_it_twice',
  'bbj_percent',
  'cap_enabled',
  'cluster_id',
  'game_variant',
  'insurance_enabled',
  'is_template',
  'nit_game',
  'pineapple_holdem',
  'rake_cap_bb',
  'rake_percent',
  'run_it_twice',
  'seven_deuce_enabled',
  'status',
  'tournament_id',
];

/* A column name, as either language spells it, taken from the body of the one
   decision rather than from the file. Anchored on the structure: the SQL
   predicate from its `SELECT NOT (` to the `);` that closes it, and the
   boundary from its function signature to its matching brace. */
const namesIn = (src: string): string[] =>
  Array.from(new Set(src.match(/\b[a-z][a-z0-9_]{3,}\b/g) ?? []))
    .filter((word) => SHAPE_COLUMNS.includes(word))
    .sort();

describe('LAW - the SQL rule and the engine boundary decide with the same columns', () => {
  const sqlRule = sliceBetween(at(MIGRATION), 'SELECT NOT (', '$fn$;');
  const boundary = sliceMethod(
    at(BOUNDARY),
    'export function assertDiamondCashTable(table: Record<string, unknown>): void {'
  );
  /* The row-shape decision only: everything from the signature to the throw
     that ends it. The whole-amount and bomb-ante checks that follow are about
     a hand, not a row, and the SQL doors carry their own. */
  const boundaryShape = sliceBetween(
    boundary,
    'const disabled = [',
    'Diamond Plain Cash Table Required'
  );

  it('the SQL rule exists and is the one every door reads', () => {
    const migration = at(MIGRATION);
    expect(migration).toContain(
      'CREATE OR REPLACE FUNCTION public.fn_poker_diamond_plain_cash_table'
    );
    for (const door of [
      'fn_poker_diamond_buyin',
      'fn_poker_diamond_top_up',
      'fn_poker_diamond_set_table_straddle',
      'fn_poker_diamond_set_table_run_it_twice',
      'fn_poker_diamond_set_table_bomb_pot',
    ]) {
      expect(migration, `${door} is not named by the migration that unified the rule`).toContain(
        door
      );
    }
  });

  it('the SQL rule names every column of the shape and no other', () => {
    expect(namesIn(sqlRule)).toEqual([...SHAPE_COLUMNS].sort());
  });

  it('the engine boundary names every column of the shape and no other', () => {
    expect(namesIn(boundaryShape)).toEqual([...SHAPE_COLUMNS].sort());
  });

  it('so neither side can learn about a column the other has not', () => {
    expect(namesIn(sqlRule)).toEqual(namesIn(boundaryShape));
  });

  it('the hand settler is exempt, and that is deliberate', () => {
    /* By settlement the hand has been dealt. Refusing to settle a dealt hand
       on a feature flag parks the table with the seat stuck, which is the
       exact failure the run-it-twice work was written to avoid. */
    expect(at(MIGRATION)).toMatch(/settler must not refuse a dealt hand on a feature flag/);
  });
});
