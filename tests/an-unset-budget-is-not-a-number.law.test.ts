/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  LAW - AN UNSET REWARD BUDGET IS UNSET, NOT A NUMBER NOBODY SET
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * CLAUDE.md 10.86 rule 1: "'I could not tell' is a distinct outcome and must
 * have its own name. Never fold it into pending, green, empty, zero or
 * silence."
 *
 * fn_ca_diamond_earn_ledger created an engine's diamond_reward_budgets line
 * for a new period as
 *
 *     COALESCE((SELECT b.budget_diamonds ... b.period < v_period
 *                ORDER BY b.period DESC LIMIT 1), <a literal>)
 *
 * so an engine that had never had a line got one of two and a half million
 * Diamonds, written by a trigger, approved by nobody. Under ruling 21 the
 * engine total refuses no player - but fn_ca_diamond_budget_reality then
 * compared real issuance against it and printed a ratio, which is rule 1's
 * failure exactly: a plausible-looking value standing in for "nobody has said".
 * That is section 6 item 8 of docs/DIAMOND-DESTINATIONS-DESIGN-2026-09-21.md,
 * and it was still live on 2026-10-04.
 *
 * THE FIX SETS NO NUMBER, and this law is here to keep it that way. Only the
 * invented fallback went. The carry-forward is a real decision the code
 * already makes and it is sound - a month with no new instruction continues
 * the last plan somebody set - so it stays. With no earlier line at all the
 * column is left NULL, which is what this schema already calls unset: the
 * column is nullable and its own CHECK is named
 * ca_budget_is_a_number_or_nothing.
 *
 * The health function needed no change. Measured on production 2026-10-04 in a
 * rolled-back transaction: a line created for an engine that had never had one
 * came out with budget_diamonds NULL, a NULL ratio, and the verdict "NO PLAN
 * SET. Refuses nobody either way (ruling 21); this is simply unstated."
 *
 * The 2.5 million lines already recorded (daily_mission_milestones, signup)
 * are NOT rewritten by that migration. They are section 6 item 7, "Dan's to
 * set", and 10.9 forbids rewriting a recorded line to make a number look tidy.
 */
import { describe, expect, it } from 'vitest';
import { migrationNames, migrationText } from './helpers/migrationCorpus';
import { sliceBetween } from './helpers/sourceWindow';

const named = (suffix: string) => {
  const name = migrationNames()
    .filter((n) => n.endsWith(suffix))
    .at(-1);
  if (!name) throw new Error(`the migration ${suffix} is missing`);
  return migrationText(name);
};
const BOOKS = named('_the_diamond_books_do_not_invent_a_number.sql');

const BUDGET = sliceBetween(
  BOOKS,
  '-- 2. AN UNSET REWARD BUDGET IS UNSET',
  '-- 3. THE ESTATE IS AS IT WAS'
);
const FINAL = sliceBetween(BOOKS, '-- 3. THE ESTATE IS AS IT WAS', 'COMMIT;');

const INVENTED = /2500000/g;

describe('an unset reward budget is unset, not a number nobody set', () => {
  it('edits the live trigger in place, with its md5 pinned and the reversal proved', () => {
    expect(BUDGET).toContain("'348f0603eaec4a1f91c7a6102eb9fcd2'");
    expect((BUDGET.match(/IF md5\(v_def\) <> '[0-9a-f]{32}' THEN/g) ?? []).length).toBe(1);
    expect((BUDGET.match(/IF md5\(replace\(/g) ?? []).length).toBe(1);
    expect(BUDGET).toContain('EXECUTE replace(v_def, v_old, v_new);');
  });

  it('proves the fallback it removes occurs exactly once', () => {
    expect(BUDGET).toContain(
      "v_n := (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old);"
    );
    expect(BUDGET).toMatch(/IF v_n <> 1 THEN/);
    expect(BUDGET).toContain('the invented budget fallback occurs % times, expected 1');
  });

  it('mentions the invented figure exactly once - in the text it deletes', () => {
    // v_old carries it; v_new must not, or the pin below is watching nothing
    // and the live body would still read as carrying an approved plan.
    expect(BUDGET.match(INVENTED)?.length).toBe(1);
    const removed = BUDGET.slice(BUDGET.indexOf('v_old :='), BUDGET.indexOf('v_new :='));
    expect(removed.match(INVENTED)?.length).toBe(1);
  });

  it('keeps the carry-forward: only the fallback goes', () => {
    expect(BUDGET).toContain('(SELECT b.budget_diamonds FROM public.diamond_reward_budgets b');
    expect(BUDGET).toContain('WHERE b.engine = v_engine AND b.period < v_period');
    expect(BUDGET).toContain('ORDER BY b.period DESC LIMIT 1),');
    expect(FINAL).toContain('the earn ledger lost its carry-forward or one of its rules');
  });

  it('names the absent plan rather than folding it into a value (10.86 rule 1)', () => {
    expect(BUDGET).toMatch(/"I could not tell" is a distinct outcome/);
    expect(BUDGET).toContain('ca_budget_is_a_number_or_nothing');
    expect(BUDGET).toMatch(/NO PLAN SET/);
  });

  it('refuses to land if the live body still invents one', () => {
    expect(FINAL).toContain("IF position('2500000' IN v_txt) > 0 THEN");
    expect(FINAL).toContain('the earn ledger still invents a budget');
  });

  it('leaves the only cap that refuses, and the failure name, alone (ruling 21)', () => {
    expect(FINAL).toContain('DR7:user_over_daily_cap');
    expect(FINAL).toContain('DR7:ledger_write_failed');
  });

  it('requires the health function to still have a name for an unset plan', () => {
    expect(FINAL).toContain('fn_ca_diamond_budget_reality');
    expect(FINAL).toContain('no longer names an unset plan');
  });

  it('sets no budget, price, rate or cap of its own', () => {
    // No INSERT or UPDATE of a plan anywhere in the migration: the recorded
    // lines are Dan's (section 6 item 7) and 10.9 forbids tidying them.
    expect(BOOKS).not.toMatch(/INSERT INTO public\.diamond_reward_budgets/);
    expect(BOOKS).not.toMatch(/UPDATE public\.diamond_reward_budgets/);
    expect(BOOKS).not.toMatch(/INSERT INTO public\.diamond_engine_daily_caps/);
    expect(BOOKS).not.toMatch(/UPDATE public\.ca_arena_settings/);
  });
});
