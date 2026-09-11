/**
 * THE WELCOME SPIN KEEPS ITS OWN BOOKS (2026-09-10, BINDING)
 *
 * Dan 2026-09-10: "free spin should be once for a new user 100 diamonds, and
 * yes its funded by union or club owners, they simply 'receive no diamonds'
 * but are allowing a free 100 diamond spin for new members of the union or
 * club. All paid for by the promo wallet."
 *
 * SUPERSEDES "a free spin pays diamonds and nothing else" (2026-09-09), which
 * bound the daily free spin to diamonds because a chip minted against nothing
 * was a faucet. That law was retired by the ruling above, not weakened by it:
 * the welcome spin may pay a chip because nothing is minted any more and the
 * chip comes out of the host's promo wallet.
 *
 * The retired law was right about one thing, and it is the thing this one is
 * mostly made of. It said:
 *
 *     free spins live in wheel_free_spins, never wheel_spins, so a spin with
 *     no intake cannot put the paid wheel's realised return over 100 percent
 *
 * Moving the welcome spin onto the real wheel is what Dan asked for, and it
 * put a zero-intake spin in the paid wheel's own table. The separation has to
 * be kept inside that table instead, and on 2026-09-11 an audit found four
 * places where it was not. Every pin below is one of those, so the shape
 * cannot come back:
 *
 *   - a welcome spin SAYS it is one, or the page treats it as paid and offers
 *     a spent spin again;
 *   - its payout is charged to the welcome budget and never to chips_paid;
 *   - it takes nothing in, so it adds nothing to the intake;
 *   - it neither spends nor is gated on the paid wheel's diamond float;
 *   - it is not a data point about the paid wheel: the realised-return windows
 *     exclude it, the way they exclude fixtures;
 *   - it is not counted in the rates kept over paid spins;
 *   - it is once per member per host, EVER, enforced by a unique index rather
 *     than a check two requests can both pass;
 *   - the flag that makes it free is an argument of a core no browser can
 *     reach, and both doors ask who is calling before they delegate.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { resolve } from 'path';

const DIR = resolve(__dirname, '..', 'supabase/migrations');
const files = readdirSync(DIR);

function latest(fragment: string): { name: string; sql: string } {
  const name = files
    .filter((f) => f.includes(fragment))
    .sort()
    .pop();
  expect(name, `no migration named like ${fragment}`).toBeTruthy();
  return { name: name as string, sql: readFileSync(resolve(DIR, name as string), 'utf8') };
}

function body(sql: string, fn: string): string {
  const open = Math.max(
    sql.lastIndexOf(`CREATE OR REPLACE FUNCTION public.${fn}(`),
    sql.lastIndexOf(`CREATE FUNCTION public.${fn}(`)
  );
  expect(open, `${fn} has moved or gone`).toBeGreaterThan(-1);
  const start = sql.indexOf('$function$', open);
  const end = sql.indexOf('$function$', start + 10);
  expect(end).toBeGreaterThan(start);
  return sql.slice(start, end);
}

const bank = latest('the_bank_backs_the_promo_wallet');
const doors = latest('the_wheel_doors_ask_who_is_calling');
const books = latest('the_welcome_spin_keeps_its_own_books');

/** The audit's corrected core is the one in force. */
const CORE = body(books.sql, 'fn_wheel_spin_core');

describe('a welcome spin says that it is one', () => {
  it('the result carries the flag the page reads, and a paid spin does not', () => {
    const result = body(books.sql, 'fn_wheel_spin_result');
    expect(result).toContain("'free', COALESCE(s.is_welcome, false)");
    // It is the same function the history is built from, so a past welcome
    // spin is labelled wherever it is shown.
    expect(books.sql).toContain('a spin still does not say whether it was the welcome one');
  });
});

describe('the two sets of books never touch', () => {
  it('the payout is charged to the welcome budget, never to chips_paid', () => {
    expect(CORE).toContain(
      'chips_paid = chips_paid + CASE WHEN p_welcome THEN 0 ELSE v_prize_chips END,'
    );
    expect(CORE).toContain(
      'welcome_chips_paid = welcome_chips_paid + CASE WHEN p_welcome THEN v_value_chips ELSE 0 END,'
    );
    expect(CORE).toContain('IF pool.welcome_chips_paid > cfg.welcome_budget_chips THEN');
  });

  it('it takes nothing in, so the intake does not grow', () => {
    expect(CORE).toContain('v_dia_now      := CASE WHEN p_welcome THEN 0 ELSE v_price END;');
    expect(CORE).toContain('intake_diamonds = intake_diamonds + v_dia_now,');
  });

  it('it neither spends nor is gated on the paid wheel diamond float', () => {
    expect(CORE).toContain(
      'IF NOT p_welcome AND pool.diamond_float + v_dia_now < seg.amount * v_mult THEN'
    );
    expect(CORE).toContain('- CASE WHEN p_welcome THEN 0 ELSE v_prize_dia END,');
    expect(CORE).toContain(
      'diamonds_paid = diamonds_paid + CASE WHEN p_welcome THEN 0 ELSE v_prize_dia END,'
    );
  });

  it('it is not a data point about the paid wheel', () => {
    const metrics = body(books.sql, 'fn_wheel_metrics');
    expect(metrics).toContain('NOT COALESCE(s.is_welcome, false)');
    expect(books.sql).toContain('the realised-return windows still count welcome spins');
  });

  it('it is not counted in a rate kept over paid spins', () => {
    expect(CORE).toContain('spins = spins + CASE WHEN p_welcome THEN 0 ELSE 1 END,');
    expect(CORE).toContain(
      'CASE WHEN NOT p_welcome AND jsonb_array_length(v_locked) > 0 THEN 1 ELSE 0 END,'
    );
  });
});

describe('once per member per host, ever', () => {
  it('is a unique index, not a check two requests can both pass', () => {
    expect(bank.sql).toContain(
      'CREATE UNIQUE INDEX IF NOT EXISTS wheel_spins_one_welcome_per_member'
    );
    expect(bank.sql).toContain('ON public.wheel_spins (host_id, user_id) WHERE is_welcome;');
    expect(bank.sql).toContain('You Have Already Taken Your Welcome Spin Here');
  });

  it('a host that has not funded one does not offer one', () => {
    expect(CORE).toContain('IF COALESCE(cfg.welcome_budget_chips, 0) <= 0 THEN');
    expect(CORE).toContain('The Welcome Spin Is Not Funded Here Yet');
    expect(CORE).toContain('The Host Does Not Take Its Own Welcome Spin');
  });
});

describe('the free flag is not a thing a browser can ask for', () => {
  it('the core takes it, only the two doors set it, and both ask who is calling', () => {
    expect(bank.sql).toContain(
      'REVOKE ALL ON FUNCTION public.fn_wheel_spin_core(uuid, uuid, text, boolean) FROM PUBLIC, anon, authenticated;'
    );
    expect(doors.sql).toContain(
      'RETURN public.fn_wheel_spin_core(p_club_id, p_commit_id, p_client_seed, false);'
    );
    expect(doors.sql).toContain(
      'RETURN public.fn_wheel_spin_core(p_club_id, p_commit_id, p_client_seed, true);'
    );
    expect(body(doors.sql, 'fn_wheel_spin')).toContain('IF auth.uid() IS NULL THEN');
    expect(body(doors.sql, 'fn_wheel_free_spin')).toContain('IF auth.uid() IS NULL THEN');
  });

  it('never mentions is_horse: a horse is a player (CLAUDE.md 10.5)', () => {
    expect(bank.sql).not.toMatch(/is_horse/);
    expect(books.sql).not.toMatch(/is_horse/);
    expect(doors.sql).not.toMatch(/is_horse/);
  });
});
