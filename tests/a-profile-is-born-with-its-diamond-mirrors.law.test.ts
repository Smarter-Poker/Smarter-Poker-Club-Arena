/**
 * A PROFILE IS BORN WITH ITS DIAMOND MIRRORS, AND A MIRROR NEVER INVENTS A
 * NUMBER.
 *
 * `profiles.diamonds` is the canonical diamond store. `user_diamonds`,
 * `user_diamond_balance` and `diamond_wallets` are mirrors of it, and
 * `fn_ca_diamond_snapshot` checks every hour that each profile has a row in
 * all three carrying exactly its balance.
 *
 * That check raised `DR10:mirror_mismatch` NINETY-FOUR times before this was
 * fixed - a detector that fires ninety-four times for one cause is a cause
 * nobody fixed (CLAUDE.md 10.11). Measured 2026-09-07 across 1,192 profiles:
 * five had a missing or disagreeing mirror row, and the whole 500-diamond gap
 * between `profiles` and `diamond_wallets` was one account, `a57d17c9`, which
 * held 500 in the canonical store, had no `diamond_wallets` row at all, and
 * whose `user_diamonds` row said 100.
 *
 * Two causes, both closed:
 *
 *   1. `trg_diamond_side_tables_follow_profiles` fired on UPDATE OF diamonds
 *      and NOT on INSERT, so a profile got its mirror rows the first time its
 *      balance changed and never at birth. One born with a balance and never
 *      touched again had none, for ever.
 *   2. `initialize_user_diamonds`, the signup trigger on auth.users, wrote
 *      `(100, 100)` into `user_diamonds` - and `user_diamonds.balance`
 *      defaulted to 100, the only one of the three mirrors that defaulted to
 *      anything but zero. `profiles.diamonds` defaults to 0 and NO profile
 *      created in the previous fourteen days held a canonical 100, so the
 *      number was never a balance anybody had: the supply meter reads
 *      `profiles.diamonds` alone and never counted it.
 *
 * Nothing was taken from anyone: the one account carrying the invented 100 had
 * its mirror corrected UP to the 500 it actually holds.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

const MIGRATIONS = join(__dirname, '..', 'supabase', 'migrations');
const files = readdirSync(MIGRATIONS)
  .filter((f) => f.endsWith('.sql'))
  .sort();
const read = (needle: string) => {
  const f = files.find((x) => x.includes(needle));
  return { f, sql: f ? readFileSync(join(MIGRATIONS, f), 'utf8') : '' };
};
/** SQL with its comments stripped - the headers quote the very code being banned. */
const code = (sql: string) =>
  sql
    .split('\n')
    .filter((l) => !l.trimStart().startsWith('--'))
    .join('\n')
    .replace(/\/\*[\s\S]*?\*\//g, '');

const born = read('a_profile_is_born_with_its_diamond_mirrors');
const invent = read('a_mirror_never_invents_a_number');

describe('a profile is born with its diamond mirrors', () => {
  it('both migrations exist', () => {
    expect(born.f, 'the INSERT-trigger migration must not be deleted').toBeTruthy();
    expect(invent.f, 'the signup-seed migration must not be deleted').toBeTruthy();
  });

  it('the mirror trigger fires on INSERT as well as UPDATE', () => {
    expect(born.sql).toMatch(
      /CREATE TRIGGER trg_diamond_side_tables_follow_profiles\s+AFTER INSERT OR UPDATE OF diamonds ON public\.profiles/
    );
    // and the body knows an INSERT has no OLD row
    expect(born.sql).toContain("CASE WHEN TG_OP = 'INSERT'");
    // an INSERT at zero still writes the rows: an absent mirror is the hole
    expect(born.sql).toContain("IF TG_OP <> 'INSERT' AND v_delta = 0 THEN RETURN NEW; END IF;");
  });

  it('all three mirrors are written, none is left behind', () => {
    for (const table of ['user_diamonds', 'user_diamond_balance', 'diamond_wallets']) {
      expect(born.sql).toContain(`INSERT INTO public.${table}`);
    }
  });

  it('the signup trigger reads the canonical store instead of seeding 100', () => {
    expect(code(invent.sql)).not.toMatch(/VALUES \(NEW\.id, 100/);
    expect(invent.sql).toContain('FROM public.profiles p WHERE p.id = NEW.id');
    expect(invent.sql).toMatch(/VERIFY FAILED: the signup trigger still seeds an invented 100/);
  });

  it('the column default cannot bring the number back', () => {
    expect(invent.sql).toContain(
      'ALTER TABLE public.user_diamonds ALTER COLUMN balance SET DEFAULT 0'
    );
    expect(invent.sql).toMatch(/VERIFY FAILED: user_diamonds\.balance still defaults to %/);
  });

  it('the correction refuses to run if the board moved underneath it', () => {
    expect(invent.sql).toMatch(/ABORT: % profiles disagree with their mirrors, expected about 5/);
    expect(invent.sql).toMatch(
      /VERIFY FAILED: % profile\(s\) still disagree with a diamond mirror/
    );
  });

  it('the INSERT path is proved against a live row and rolled back', () => {
    expect(born.sql).toContain('zz_rollback_the_probe');
    expect(born.sql).toMatch(/VERIFY FAILED: a profile born with 777 got mirrors/);
    // a probe that could not run says so rather than passing quietly
    expect(born.sql).toContain('MIRROR_PROBE_NOT_RUN');
  });
});
