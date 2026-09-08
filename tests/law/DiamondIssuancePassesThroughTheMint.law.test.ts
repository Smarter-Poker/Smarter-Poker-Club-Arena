/**
 * ===========================================================================
 *  LAW: DIAMOND ISSUANCE PASSES THROUGH THE MINT (2026-09-03)
 * ===========================================================================
 *
 * Diamond Accounting Standard 3.3 DR2 and DR14, 3.2 "Earn" steps 5 and 6, and
 * the Lane B line of section 5.
 *
 * What was true before this lane, measured in production on 2026-09-02:
 * ca_mint_ledger held ZERO rows for any asset, ever; fn_ca_mint_supply
 * ('diamonds') returned 0 against 1,030,092 diamonds actually held; and the
 * single largest promotional source, the 500-diamond signup grant, had not
 * written a journal row since 2026-02-12, because handle_new_user only
 * journaled when it created the profile itself. The horse seeder writes the
 * profile already holding 500, so 416 horses and 208,000 diamonds entered
 * supply in two days with no row in any ledger.
 *
 * Three things are pinned here, all on the TEXT of the two migrations that
 * carry them, so a later CREATE OR REPLACE that starts from an older mirror
 * cannot quietly undo them:
 *
 *   1. The Mint accepts 'house' as a diamond destination and source, and
 *      stamps counterparty + issuance_class on the journal row it writes.
 *   2. handle_new_user journals the grant on the ON CONFLICT path as well as
 *      the INSERT path, under reference 'signup:<uid>', class 'seeded' when
 *      the balance arrived with the profile.
 *   3. The born-with-balance trigger records DR2 and can never raise.
 *
 * Every pin is negative-controlled against the last repo body of the same
 * object: the Mint as shipped on 2026-09-02 and handle_new_user as shipped on
 * 2026-09-01. If a pin passes against those, it is not measuring the rule.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf8');

const MINT_MIGRATION = 'supabase/migrations/20260903002248_diamond_b_the_mint_issues_diamonds.sql';
const BORN_MIGRATION =
  'supabase/migrations/20260903002333_diamond_b_a_balance_born_outside_the_mint_is_recorded.sql';

/** The last shipped body of the Mint before Lane B. */
const PREVIOUS_MINT = 'supabase/migrations/20260902172915_the_mint_issuance_and_retirement.sql';
/** The last shipped body of handle_new_user before Lane B. */
const PREVIOUS_SIGNUP =
  'supabase/migrations/20260901032430_ca_signup_diamonds_journal_their_own_grant.sql';

const MINT_SQL = read(MINT_MIGRATION);
const BORN_SQL = read(BORN_MIGRATION);
const OLD_MINT_SQL = read(PREVIOUS_MINT);
const OLD_SIGNUP_SQL = read(PREVIOUS_SIGNUP);

/** The text of one CREATE [OR REPLACE] FUNCTION block, by name. */
function functionBody(sql: string, name: string, label: string): string {
  const start = sql.search(new RegExp(`CREATE (?:OR REPLACE )?FUNCTION public\\.${name}\\s*\\(`));
  expect(start, `${name} is defined in ${label}`).toBeGreaterThan(-1);
  const open = sql.slice(start).match(/\bAS\s+(\$[a-z_]*\$)/);
  expect(open, `${name} body is dollar-quoted in ${label}`).not.toBeNull();
  const bodyStart = start + open!.index! + open![0].length;
  const end = sql.indexOf(`${open![1]};`, bodyStart);
  expect(end, `${name} body is terminated in ${label}`).toBeGreaterThan(start);
  return sql.slice(start, end);
}

describe('the Mint issues diamonds to a player or to the house', () => {
  for (const fn of ['fn_ca_mint', 'fn_ca_burn']) {
    it(`${fn} accepts the house for diamonds and refuses anything else`, () => {
      const body = functionBody(MINT_SQL, fn, MINT_MIGRATION);
      expect(body).toMatch(/NOT IN \('player', 'house'\)/);
      expect(body).toMatch(/public\.ca_diamond_house/);
      // The house has no row in profiles, so it gets the documented sentinel
      // and never a diamond_transactions row.
      expect(body).toMatch(/00000000-0000-0000-0000-00000000d1a0/);
    });

    it(`${fn} stamps the issuance class and the counterparty on the journal row`, () => {
      const body = functionBody(MINT_SQL, fn, MINT_MIGRATION);
      expect(body).toMatch(/counterparty, issuance_class/);
      expect(body).toMatch(/p_class text DEFAULT 'admin'/);
      expect(body).toMatch(/unknown_issuance_class/);
    });

    it(`${fn} keeps every gate it had: role, whole diamonds, reason, op claim, lock`, () => {
      const body = functionBody(MINT_SQL, fn, MINT_MIGRATION);
      expect(body).toMatch(/the_mint_is_admin_only/);
      expect(body).toMatch(/diamonds_are_whole_numbers/);
      expect(body).toMatch(/idempotency_key_required/);
      expect(body).toMatch(/public\.ca_op_claims/);
      expect(body).toMatch(/pg_advisory_xact_lock\(hashtext\('ca_mint_ledger:'/);
      expect(body).toMatch(/supply_after/);
    });
  }

  it('the mint counterparty is issuance and the burn counterparty is retired', () => {
    expect(functionBody(MINT_SQL, 'fn_ca_mint', MINT_MIGRATION)).toMatch(/'issuance', v_class/);
    expect(functionBody(MINT_SQL, 'fn_ca_burn', MINT_MIGRATION)).toMatch(/'retired', v_class/);
  });

  it('the house branch writes no diamond_transactions row', () => {
    for (const fn of ['fn_ca_mint', 'fn_ca_burn']) {
      const body = functionBody(MINT_SQL, fn, MINT_MIGRATION);
      const house = body.slice(body.indexOf('ca_diamond_house'));
      const player = house.indexOf('FROM public.profiles WHERE id = p_target_id');
      // Everything between the house account and the player branch must be free
      // of a journal insert: the journal is keyed by a user and the house is not.
      const houseBranch = player > -1 ? house.slice(0, player) : house;
      expect(houseBranch).not.toMatch(/INSERT INTO public\.diamond_transactions/);
    }
  });

  it('neither door is executable by a logged-in browser', () => {
    expect(MINT_SQL).toMatch(
      /REVOKE ALL ON FUNCTION public\.fn_ca_mint\([^)]*\) FROM public, anon, authenticated/
    );
    expect(MINT_SQL).toMatch(
      /REVOKE ALL ON FUNCTION public\.fn_ca_burn\([^)]*\) FROM public, anon, authenticated/
    );
    expect(MINT_SQL).not.toMatch(
      /GRANT EXECUTE ON FUNCTION public\.fn_ca_(mint|burn)[^;]*authenticated/
    );
  });

  it('the pre-standard circulation is acknowledged once, not backfilled', () => {
    expect(MINT_SQL).toMatch(/'baseline:diamonds:2026-09-03'/);
    expect(MINT_SQL).toMatch(/ON CONFLICT \(op_id\) DO NOTHING/);
    // The amount is computed from profiles at apply time, never typed in.
    expect(MINT_SQL).toMatch(/SELECT COALESCE\(SUM\(COALESCE\(diamonds, 0\)\), 0\) INTO v_total/);
    expect(MINT_SQL).not.toMatch(/1030092/);
  });

  it('negative control: the 2026-09-02 Mint knew only the player and no class', () => {
    for (const fn of ['fn_ca_mint', 'fn_ca_burn']) {
      const old = functionBody(OLD_MINT_SQL, fn, PREVIOUS_MINT);
      expect(old).not.toMatch(/ca_diamond_house/);
      expect(old).not.toMatch(/issuance_class/);
      expect(old).not.toMatch(/p_class/);
      expect(old).toMatch(/v_(dest|src) (<>|NOT IN) /);
    }
  });
});

describe('the signup grant is journaled on both paths', () => {
  const body = () => functionBody(MINT_SQL, 'handle_new_user', MINT_MIGRATION);

  it('journals under signup:<uid> with both sides named', () => {
    expect(body()).toMatch(/'signup:' \|\| NEW\.id::text/);
    expect(body()).toMatch(/'issuance:signup'/);
    expect(body()).toMatch(/'signup_bonus'/);
  });

  it('the ON CONFLICT path is reached: a profile that already carries 500 is journaled', () => {
    // The old guard was `= 0 AND v_now_diamonds = 500`, which is false for every
    // seeder-created profile. The new one admits both.
    expect(body()).toMatch(/v_now_diamonds = 500 AND COALESCE\(v_prev_diamonds, 0\) IN \(0, 500\)/);
    expect(body()).toMatch(/THEN 'seeded' ELSE 'promotional' END/);
  });

  it('writes the register row and cannot double-count the seed row', () => {
    expect(body()).toMatch(/INSERT INTO public\.ca_mint_ledger/);
    expect(body()).toMatch(
      /m\.op_id IN \('signup:' \|\| NEW\.id::text,\s*'seed:' \|\| NEW\.id::text\)/
    );
  });

  it('a ledger failure can never block a signup', () => {
    const b = body();
    expect(b).toMatch(/EXCEPTION WHEN OTHERS THEN\s*\n\s*PERFORM public\.fn_ca_diamond_incident\(/);
    expect(b).toMatch(/DR2:signup_grant_not_journaled/);
    // The outer handler that keeps auth.users INSERT alive is still there.
    expect(b).toMatch(/INSERT INTO public\.signup_errors/);
  });

  it('nothing else about the signup changed: VIP, multiplier, player number', () => {
    const b = body();
    expect(b).toMatch(/true, 'monthly', NOW\(\) \+ INTERVAL '30 days'/);
    expect(b).toMatch(/1\.0, 'Newcomer'/);
    expect(b).toMatch(/nextval\('public\.profiles_player_number_seq'\)/);
    expect(b).toMatch(/is_reserved_username\(generated_username\)/);
  });

  it('negative control: the 2026-09-01 body journaled only when it granted', () => {
    const old = functionBody(OLD_SIGNUP_SQL, 'handle_new_user', PREVIOUS_SIGNUP);
    expect(old).toMatch(/COALESCE\(v_prev_diamonds, 0\) = 0 AND v_now_diamonds = 500/);
    expect(old).not.toMatch(/IN \(0, 500\)/);
    expect(old).not.toMatch(/'seeded'/);
    expect(old).not.toMatch(/ca_mint_ledger/);
  });
});

describe('a balance born outside the Mint is recorded, and nothing is refused', () => {
  const body = () => functionBody(BORN_SQL, 'fn_ca_diamond_born_with_balance', BORN_MIGRATION);

  it('names the rule it records', () => {
    expect(body()).toMatch(/'DR2:balance_born_outside_the_mint', 'warning'/);
    expect(body()).toMatch(/public\.fn_ca_diamond_incident\(/);
  });

  it('never raises: every write is inside its own EXCEPTION WHEN OTHERS', () => {
    const b = body();
    expect((b.match(/EXCEPTION WHEN OTHERS/g) || []).length).toBeGreaterThanOrEqual(2);
    expect(b).not.toMatch(/RAISE EXCEPTION/);
    // A warning is not a refusal.
    expect(b).toMatch(/RAISE WARNING/);
  });

  it('registers the seed so the supply identity still holds', () => {
    expect(body()).toMatch(/'seed:' \|\| NEW\.id::text/);
    expect(body()).toMatch(/INSERT INTO public\.ca_mint_ledger/);
    expect(body()).toMatch(/ON CONFLICT \(op_id\) DO NOTHING/);
  });

  it('writes no diamond_transactions row: the auth.users row does not exist yet', () => {
    expect(body()).not.toMatch(/INSERT INTO public\.diamond_transactions/);
  });

  it('is an AFTER INSERT trigger on profiles, last in line, and does not filter horses', () => {
    expect(BORN_SQL).toMatch(
      /CREATE TRIGGER zz_ca_diamond_born_with_balance\s*\n\s*AFTER INSERT ON public\.profiles/
    );
    expect(BORN_SQL).toMatch(/WHEN \(NEW\.diamonds IS NOT NULL AND NEW\.diamonds <> 0\)/);
    // is_horse appears as recorded DATA only, never in the WHEN clause or a
    // guard (CLAUDE.md 10.5).
    expect(body()).toMatch(/'is_horse',\s*NEW\.is_horse/);
    expect(BORN_SQL).not.toMatch(/WHEN \([^)]*is_horse/);
    expect(body()).not.toMatch(/IF[^\n]*is_horse/);
  });

  it('the trigger ships in its own migration, with a lock timeout on the hot table', () => {
    expect(BORN_SQL).toMatch(/SET LOCAL lock_timeout = '4s'/);
    expect(BORN_SQL).toMatch(/^BEGIN;$/m);
    expect(BORN_SQL).toMatch(/^COMMIT;$/m);
    // Part 1 must not carry a profiles trigger.
    expect(MINT_SQL).not.toMatch(/CREATE TRIGGER[\s\S]{0,120}ON public\.profiles/);
  });

  it('negative control: neither pre-Lane-B migration knew this rule', () => {
    expect(OLD_MINT_SQL).not.toMatch(/balance_born_outside_the_mint/);
    expect(OLD_SIGNUP_SQL).not.toMatch(/balance_born_outside_the_mint/);
    expect(OLD_SIGNUP_SQL).not.toMatch(/zz_ca_diamond_born_with_balance/);
  });
});
