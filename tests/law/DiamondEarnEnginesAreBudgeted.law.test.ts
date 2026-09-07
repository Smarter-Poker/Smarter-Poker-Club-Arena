/**
 * LAW: EVERY DIAMOND EARN ENGINE HAS A BUDGET LINE AND A DAILY CAP LEDGER
 * ===========================================================================
 * `docs/DIAMOND-ACCOUNTING-STANDARD.md` DR7 asks for `CHECK (spent <= budget)`
 * and a per-user per-day cap enforced by constraint. Dan's risk rule (swarm
 * brief 12) forbids shipping that first: a constraint that refuses an award
 * stops a player being paid for something they already did. What shipped is
 * the LEDGER - it charges every promotional credit to its engine's budget
 * line, adds it to that player's day total, and files an incident when a line
 * is crossed. It must stay a reporter.
 *
 * Measured before it shipped (30 days to 2026-09-03, journal credits only):
 * trivia 14,260 across 489 rows, catalog_v2 2,460 across 55, other 440,
 * legacy_credit 20. Only catalog_v2 was budgeted by anything at all, and it
 * was budgeted by a constant inside the function that spends it.
 *
 * This law pins the shape of the migration that created it:
 *   1. The journal trigger function names BOTH DR7 rules
 *      (`DR7:engine_over_budget`, `DR7:user_over_daily_cap`) and carries an
 *      `EXCEPTION WHEN OTHERS` handler that turns its own failure into
 *      `DR7:ledger_write_failed`. It contains no RAISE. A bookkeeping trigger
 *      that can abort an INSERT into `diamond_transactions` is a trigger that
 *      can stop an earn, which is the thing Dan's rule 12 forbids.
 *   2. The engine map covers every reference shape lane 3 documented, so a
 *      row that names its engine is never filed under `other`.
 *   3. `enter_trivia_tournament_v2` credits `ca_diamond_house` and writes a
 *      `ca_diamond_house_ledger` row for the entry-fee cut it used to burn by
 *      omission (DR14). 216 diamonds vanished this way across three events.
 *   4. `award_diamonds_v2` reads the profile FOR UPDATE (the lost-update fix)
 *      and stamps `issuance_class` on the journal row it writes.
 *
 * Every pin carries a negative control so a regex that matches nothing cannot
 * pass by accident.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const MIGRATION =
  'supabase/migrations/20260903002841_diamond_e_every_earn_engine_has_a_budget_line.sql';

const text = fs.readFileSync(path.join(process.cwd(), MIGRATION), 'utf8');

/** The body of one CREATE OR REPLACE FUNCTION ... <tag> ... <tag>; block. */
function functionBody(source: string, name: string, tag = '$fn$'): string {
  const start = source.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
  expect(start, `${name} is defined in the migration`).toBeGreaterThanOrEqual(0);
  const open = source.indexOf(tag, start);
  const close = source.indexOf(`${tag};`, open + tag.length);
  expect(open, `${name} body opens with ${tag}`).toBeGreaterThan(start);
  expect(close, `${name} body closes with ${tag};`).toBeGreaterThan(open);
  return source.slice(open + tag.length, close);
}

const LEDGER = functionBody(text, 'fn_ca_diamond_earn_ledger');
const ENGINE_MAP = functionBody(text, 'fn_ca_diamond_engine_of');
const TRIVIA = functionBody(text, 'enter_trivia_tournament_v2', '$function$');

// A counterfeit body that a careless "make DR7 real" rewrite would produce.
// Every pin below must FAIL against it, or the pin is not looking at anything.
const COUNTERFEIT = `
  IF v_spent > v_budget THEN
    RAISE EXCEPTION 'engine over budget';
  END IF;
  IF v_awarded > v_cap THEN
    RAISE EXCEPTION 'daily cap';
  END IF;
`;

const RAISES = /RAISE\s+(EXCEPTION|WARNING)/i;
const SWALLOWS = /EXCEPTION\s+WHEN\s+OTHERS\s+THEN/i;

describe('every diamond earn engine has a budget line (DR7)', () => {
  it('the ledger trigger names both DR7 rules', () => {
    expect(LEDGER).toContain('DR7:engine_over_budget');
    expect(LEDGER).toContain('DR7:user_over_daily_cap');
    expect(COUNTERFEIT).not.toContain('DR7:engine_over_budget');
  });

  it('the ledger trigger never raises, it files DR7:ledger_write_failed instead', () => {
    expect(SWALLOWS.test(LEDGER), 'EXCEPTION WHEN OTHERS handler present').toBe(true);
    expect(LEDGER).toContain('DR7:ledger_write_failed');
    expect(RAISES.test(LEDGER), 'the ledger trigger contains no RAISE').toBe(false);
    // negative control: the counterfeit is exactly what this pin must reject
    expect(RAISES.test(COUNTERFEIT)).toBe(true);
    expect(SWALLOWS.test(COUNTERFEIT)).toBe(false);
  });

  it('the trigger fires only on a credit, and only AFTER the row is written', () => {
    expect(text).toMatch(
      /CREATE TRIGGER trg_ca_diamond_earn_ledger\s+AFTER INSERT ON public\.diamond_transactions/
    );
    expect(text).toMatch(/WHEN \(NEW\.amount > 0\)/);
    expect(text).not.toMatch(/CREATE TRIGGER trg_ca_diamond_earn_ledger\s+BEFORE/);
  });

  it('the engine map covers every reference shape lane 3 documented', () => {
    const prefixes = [
      'trivia_tourn_',
      'trivia_session_',
      'trivia_wheel_',
      'challenge_claim',
      'streak_milestone_',
      'signup:',
      'easter_egg_',
      'video_favorite_',
      'vip_stipend_',
    ];
    for (const p of prefixes) {
      expect(ENGINE_MAP, `the engine map knows the ${p} reference shape`).toContain(
        `starts_with(p_reference_id, '${p}')`
      );
    }
    // negative control: a shape that was never documented is not invented here
    expect(ENGINE_MAP).not.toContain("starts_with(p_reference_id, 'poker_hand_')");
  });

  it('an unattributable row falls to other, never to a real engine', () => {
    expect(ENGINE_MAP).toMatch(/ELSE 'other'\s*END;/);
  });

  it('the engine map is pure, so it can be run over history', () => {
    expect(text).toMatch(
      /CREATE OR REPLACE FUNCTION public\.fn_ca_diamond_engine_of\([\s\S]*?\)\s*RETURNS text\s*LANGUAGE sql\s*IMMUTABLE/
    );
  });

  it('horses are players: neither the ledger nor the map branches on is_horse', () => {
    // CLAUDE.md 10.5. The only mention of is_horse anywhere in this migration
    // is the COMMENT saying the table never filters it.
    expect(LEDGER).not.toMatch(/is_horse/i);
    expect(ENGINE_MAP).not.toMatch(/is_horse/i);
    expect(TRIVIA).not.toMatch(/is_horse/i);
    // negative control: the comment that says so does exist, so a regex
    // looking for the string cannot be matching nothing at all.
    expect(text).toMatch(/never filters is_horse/);
  });
});

describe('nothing is burned by omission (DR14)', () => {
  it('the trivia tournament cut is credited to the house', () => {
    expect(TRIVIA).toMatch(/UPDATE public\.ca_diamond_house\s+SET balance = balance \+ v_cut/);
    expect(TRIVIA).toContain('v_cut := v_fee - v_net;');
  });

  it('the house credit is explained by a ledger row with an idempotent reference', () => {
    expect(TRIVIA).toContain('INSERT INTO public.ca_diamond_house_ledger');
    expect(TRIVIA).toContain("'trivia_tourn_cut_'");
    expect(text).toMatch(/reference\s+text NOT NULL UNIQUE/);
  });

  it('the fee, the pool and the cut still add up (the rate is unchanged)', () => {
    // floor(10 percent) is Dan's decision 8 to change, not this lane's.
    expect(TRIVIA).toContain('v_net := v_fee - floor(v_fee*0.10)::int;');
  });
});

describe('award_diamonds_v2 cannot lose an update', () => {
  it('the profile read takes FOR UPDATE', () => {
    expect(text).toContain('FROM public.profiles\\n     WHERE id = p_user_id\\n       FOR UPDATE;');
  });

  it('the patch is asserted against the live body rather than pasted over it', () => {
    expect(text).toContain('902c18015fd648bc50ca75525340c8e7');
    expect(text).toMatch(/does not occur exactly once in award_diamonds_v2/);
    expect(text).toMatch(/patch moved % characters, expected %/);
  });

  it('the journal row it writes names its counterparty and its issuance class', () => {
    expect(text).toContain("''promo_budget:catalog_v2''");
    expect(text).toContain("''promotional''");
    expect(text).toContain('counterparty, issuance_class');
  });
});

describe('the catalogs keep their history (D21)', () => {
  it('all three pricing catalogs have a history trigger', () => {
    for (const t of [
      'diamond_reward_catalog',
      'daily_challenge_catalog',
      'trivia_diamond_award_limits',
    ]) {
      expect(text).toContain(`CREATE TABLE IF NOT EXISTS public.${t}_history`);
      expect(text).toMatch(new RegExp(`AFTER INSERT OR UPDATE OR DELETE ON public\\.${t}\\b`));
    }
    // negative control: a table that has no diamond price gets no history here
    expect(text).not.toContain('CREATE TABLE IF NOT EXISTS public.profiles_history');
  });

  it('the history writer never raises either', () => {
    const hist = functionBody(text, 'fn_ca_diamond_catalog_history');
    expect(SWALLOWS.test(hist)).toBe(true);
    expect(RAISES.test(hist)).toBe(false);
  });

  it('history records who made the change', () => {
    expect(text).toContain('db_role    text NOT NULL DEFAULT CURRENT_USER');
    expect(text).toContain("current_setting('application_name', true)");
  });
});

describe('the migration is one transaction and is honest about its numbers', () => {
  it('opens once, commits once, and bounds its lock wait', () => {
    expect(text.match(/^BEGIN;$/gm)?.length).toBe(1);
    expect(text.match(/^COMMIT;$/gm)?.length).toBe(1);
    expect(text).toContain("SET LOCAL lock_timeout = '4s'");
  });

  it('says in the file that the budgets and caps are proposals, not Dan rulings', () => {
    expect(text).toContain('PROPOSED PLACEHOLDERS');
    expect(text).toContain('Dan sets the real numbers');
  });
});
