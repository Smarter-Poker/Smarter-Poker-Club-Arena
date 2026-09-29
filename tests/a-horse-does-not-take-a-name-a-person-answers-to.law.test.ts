/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  A HORSE DOES NOT TAKE A NAME A PERSON ANSWERS TO (binding, 2026-09-24)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 20260823050000_strip_horse_names_from_human_profiles.sql outlawed one state,
 * in Dan's words: a person's profile carrying the name of a house horse. The
 * guard it installed asked the question from one side only. It fires on the
 * row being written and acts only when that row is a person, so a HORSE
 * written with a name a person is using reached the identical state from the
 * other direction and nothing looked.
 *
 * Measured on production 2026-09-24 as one self-aborting DO block: renaming
 * the first horse by id to the owner's own display_name was permitted in full,
 * and the count of people wearing a horse name went 0 to 1. The only writer
 * there is, createHorse() in server/src/services/HorseOnboarding.ts, picks a
 * name by hashing the horse id across two word lists and never consults the
 * people already on the platform.
 *
 * WHAT THIS LAW PINS, and why each part is here rather than trusted:
 *
 *   1. The person side keeps its old behaviour. It drops the borrowed name and
 *      lets the write through, because it fires on ordinary profile saves.
 *   2. The horse side REFUSES rather than nulling. A null horse name is not a
 *      resolution: ensureHorseComplete() refills an absent name from the same
 *      generator and sweepIncompleteHorses() runs it over the fleet at boot,
 *      so nulling would collide again every boot, for ever.
 *   3. Three conjuncts that a later edit would be tempted to "simplify" away,
 *      each of which was mutation tested against production on 2026-09-24 and
 *      each of which breaks a real path when removed: only people are counted
 *      (126 horse names are shared by two or more horses), a profile does not
 *      collide with itself (flipping is_horse is permitted in service context
 *      and the stored row still reads as a person during that write), and a
 *      blank name is not a collision (a blank display_name is storable).
 *   4. No trigger is created, dropped or reordered. profiles carries five
 *      horse triggers and their order is load bearing; this rule needed none
 *      of that, because trg_reject_horse_name_on_human already fires on
 *      exactly the writes that can introduce a name.
 *   5. THE PART THAT KEEPS IT TRUE LATER: whichever migration defines this
 *      function LAST is the one production runs, so the law reads the last
 *      definition in the whole directory, not this one file. A future
 *      migration that reinstates the one-sided body fails here.
 *
 * Registry: docs/laws.d/a-horse-does-not-take-a-name-a-person-answers-to.md
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const MIGRATIONS = resolve(__dirname, '../supabase/migrations');
const FILE = '20260924183047_a_horse_does_not_take_a_name_a_person_answers_to.sql';
const SQL = readFileSync(resolve(MIGRATIONS, FILE), 'utf8');

const DEFINES = 'CREATE OR REPLACE FUNCTION public.fn_reject_horse_name_on_human';
const PERSON_SIDE_ACTION = 'NEW.display_name := NULL;';

/**
 * The estate's own code() in check-migrations-are-live.mjs blanks every
 * dollar quoted body, which is precisely the text under test here, so this
 * law strips line comments only and keeps the body.
 *
 * EVERY NEGATIVE BELOW IS ASSERTED AGAINST THIS AND NEVER THE RAW FILE. The
 * migration's header discusses nulling a horse's name at length, in order to
 * explain why it is the wrong answer; a raw toContain would match that
 * explanation and pass while the code did the opposite.
 */
function withoutComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, '');
}

/**
 * ...and one assertion needs the string literals gone too. The preflight of
 * this migration compares against the LITERAL TEXT of the existing trigger
 * definition, so the file legitimately contains the words CREATE TRIGGER
 * inside quotes while creating no trigger at all.
 */
function withoutCommentsOrLiterals(sql: string): string {
  return withoutComments(sql).replace(/'(?:[^']|'')*'/g, "''");
}

/** The horse side is what follows the person side's one action. */
function horseSideOf(sql: string): string {
  const src = withoutComments(sql);
  const opens = src.indexOf(PERSON_SIDE_ACTION);
  expect(opens, 'the person side no longer drops the borrowed name').toBeGreaterThan(-1);
  const closes = src.indexOf('END $function$', opens);
  expect(closes, 'the rewritten function has no end').toBeGreaterThan(opens);
  return src.slice(opens + PERSON_SIDE_ACTION.length, closes);
}

/**
 * Every migration that defines the function, oldest first.
 *
 * Read ONCE, at import, and not inside the test. The directory holds around
 * three thousand files and the scan is the slow part; done per test it
 * exceeded the 5s default on a cold filesystem and failed a green law for
 * timing rather than for truth.
 */
const DEFINING: string[] = readdirSync(MIGRATIONS)
  .filter((f) => f.endsWith('.sql'))
  .sort()
  .filter((f) => readFileSync(resolve(MIGRATIONS, f), 'utf8').includes(DEFINES));

describe('a horse does not take a name a person answers to', () => {
  it('the person side still drops the name instead of failing the save', () => {
    const code = withoutComments(SQL);
    const branch = code.indexOf('IF COALESCE(NEW.is_horse, false) = false THEN');
    expect(branch, 'the person branch is gone').toBeGreaterThan(-1);
    expect(code.indexOf(PERSON_SIDE_ACTION)).toBeGreaterThan(branch);
    // A player editing something unrelated must not be refused over a name.
    expect(horseSideOf(SQL)).not.toContain('RETURN NULL');
  });

  it('the horse side refuses, and never answers with a null name', () => {
    const horse = horseSideOf(SQL);
    expect(horse).toContain('RAISE EXCEPTION');
    expect(horse).toContain("ERRCODE = '23514'");
    // The whole point of 2 in the header: nulling loops with the boot sweep.
    expect(
      horse,
      'the horse side nulls the name, which ensureHorseComplete refills at the next boot'
    ).not.toContain('NEW.display_name := NULL');
    // ...and the reasoning is on the record rather than only in this test.
    expect(SQL).toContain('ensureHorseComplete would refill it');
  });

  it.each([
    ['only people are counted', 'NOT COALESCE(u.is_horse, false)'],
    ['a profile does not collide with itself', 'u.id IS DISTINCT FROM NEW.id'],
    ['a blank name is not a collision', "coalesce(btrim(NEW.display_name), '') <> ''"],
    ['the comparison is trimmed and case folded', 'lower(btrim(u.display_name))'],
  ])('the horse side keeps the conjunct: %s', (_why, conjunct) => {
    expect(horseSideOf(SQL)).toContain(conjunct);
  });

  it('creates, drops and reorders no trigger on profiles', () => {
    const bare = withoutCommentsOrLiterals(SQL);
    expect(bare).not.toMatch(/CREATE\s+(CONSTRAINT\s+)?TRIGGER/i);
    expect(bare).not.toMatch(/DROP\s+TRIGGER/i);
    expect(bare).not.toMatch(/ALTER\s+TABLE[\s\S]{0,200}?TRIGGER/i);
  });

  it('states a proof a reader can run, and asserts its own post state', () => {
    expect(SQL).toMatch(/@live-proof:/);
    // The proof reads a persistent comment, which the migration also installs.
    expect(SQL).toContain('COMMENT ON FUNCTION public.fn_reject_horse_name_on_human()');
    expect(SQL).toContain('$verify$');
    expect(SQL).toContain('$preflight$');
  });

  it('the LAST definition in the directory is the two sided one', () => {
    expect(DEFINING.length, 'nothing defines the guard at all').toBeGreaterThan(0);
    const last = DEFINING[DEFINING.length - 1];
    const horse = horseSideOf(readFileSync(resolve(MIGRATIONS, last), 'utf8'));
    expect(
      horse,
      `${last} defines fn_reject_horse_name_on_human after this law and its horse ` +
        'side does not refuse; a one sided guard is how a person lost their name once'
    ).toContain('RAISE EXCEPTION');
    expect(horse).toContain('NOT COALESCE(u.is_horse, false)');
  });
});
