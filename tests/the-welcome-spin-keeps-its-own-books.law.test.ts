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
  return { name: name as string, sql: read(name as string) };
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

/**
 * THE LAW READS WHAT IS DEPLOYED, NOT A MIGRATION IT WAS WRITTEN AGAINST
 * (2026-09-11). This pinned `latest('the_welcome_spin_keeps_its_own_books')`
 * by name, so when the next migration rewrote fn_wheel_spin_core the law went
 * on reading the OLD file and went on passing green while production
 * contradicted three of its claims. That is the SECOND time a law here has
 * gone stale that way, and a law nobody can trust is worse than no law.
 *
 * So the migration is resolved by what it DEFINES: the last one to declare the
 * function is the one in force, which is exactly how Postgres sees it. A
 * rewrite of any of these functions now has to bring the law with it.
 */
/**
 * ONE READ OF THE CORPUS PER FILE, NOT ONE PER FUNCTION (2026-09-11).
 *
 * supabase/migrations holds 2,917 files and 32MB, and inForce has to scan all
 * of them to find the last declaration of a function. Re-reading the corpus per
 * NAME is what put this file and about seventy-five other migration-scanning
 * laws over vitest's 5 second budget under the full suite's parallelism: every
 * one a timeout, none an assertion failure, all green when run alone. The
 * contents are cached by filename instead, and this file went from 1.3s to
 * under a tenth of that.
 */
const fileCache = new Map<string, string>();
function read(f: string): string {
  const hit = fileCache.get(f);
  if (hit !== undefined) return hit;
  const sql = readFileSync(resolve(DIR, f), 'utf8');
  fileCache.set(f, sql);
  return sql;
}

const inForceCache = new Map<string, { name: string; sql: string }>();
function inForce(fn: string): { name: string; sql: string } {
  const hit = inForceCache.get(fn);
  if (hit) return hit;
  const hits = files
    .filter((f) => f.endsWith('.sql'))
    .filter((f) => {
      const sql = read(f);
      return (
        sql.includes(`CREATE OR REPLACE FUNCTION public.${fn}(`) ||
        sql.includes(`CREATE FUNCTION public.${fn}(`)
      );
    })
    .sort();
  expect(hits.length, `no migration defines ${fn}`).toBeGreaterThan(0);
  const name = hits[hits.length - 1];
  const found = { name, sql: read(name) };
  inForceCache.set(fn, found);
  return found;
}

const bank = latest('the_bank_backs_the_promo_wallet');
const books = latest('the_welcome_spin_keeps_its_own_books');

/** Whichever migration currently declares each of these is the one that governs. */
const coreFile = inForce('fn_wheel_spin_core');
const resultFile = inForce('fn_wheel_spin_result');
const metricsFile = inForce('fn_wheel_metrics');
const paidDoor = inForce('fn_wheel_spin');
const welcomeDoor = inForce('fn_wheel_welcome_spin');
const CORE = body(coreFile.sql, 'fn_wheel_spin_core');

describe('a welcome spin says that it is one', () => {
  it('the result carries the flag the page reads, and a paid spin does not', () => {
    const result = body(resultFile.sql, 'fn_wheel_spin_result');
    expect(result).toContain("'welcome', COALESCE(s.is_welcome, false)");
    // `free` was the retired daily spin's word. A payload that still said it
    // would be describing a feature that no longer exists.
    expect(result).not.toContain("'free',");
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
    // The bound is the WINDOW, not the lifetime total (2026-09-11), and the
    // spin's own row is not written when this fires, so the assertion is made
    // on the figure the gate used plus what this spin just paid.
    expect(CORE).toContain(
      'IF p_welcome AND v_welcome_spent + v_value_chips > cfg.welcome_budget_chips THEN'
    );
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
    const metrics = body(metricsFile.sql, 'fn_wheel_metrics');
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

describe('a welcome spin is the whole wheel or it is not offered', () => {
  it('the budget is asked once, about the biggest prize, before anything is offered', () => {
    // The spend and the top prize both come from the one helper (2026-09-11);
    // the core used to call fn_wheel_welcome_spent and do its own arithmetic.
    expect(CORE).toContain('FROM public.fn_wheel_welcome_room(v_host) r;');
    expect(CORE).toContain('IF v_welcome_spent + v_welcome_top > cfg.welcome_budget_chips THEN');
    expect(CORE).toContain('The Welcome Spins Here Are Gone For Now');
  });

  it('no tier is ever locked for costing too much against the budget', () => {
    // This is the defect the 2026-09-11 audit found: the budget was checked
    // tier by tier, so the later a member joined the worse their wheel got.
    expect(CORE).not.toContain("'reason', 'welcome_budget'");
    // The budget still appears, as the ONE gate up top. What must never come
    // back is a per-segment test of it inside the eligibility loop.
    const loop = CORE.slice(
      CORE.indexOf('FOR seg IN SELECT'),
      CORE.indexOf('v_eligible := v_eligible')
    );
    expect(loop).not.toContain('welcome_budget');
    expect(loop).not.toContain('welcome_chips_paid');
    // The exposure gate is the PAID wheel's alone, which is what frees the
    // welcome spin from it without giving it the paid game's intake to spend.
    expect(CORE).toContain(
      'IF NOT p_welcome AND pool.chips_paid + seg.amount * v_mult > v_intake_chips'
    );
  });

  it('the page asks the same question the door asks, from the same helper', () => {
    const state = body(inForce('fn_wheel_welcome_state').sql, 'fn_wheel_welcome_state');
    expect(state).toContain('FROM public.fn_wheel_welcome_room(v_host) r;');
    expect(state).toContain("v_reason := 'pot_empty'");
    expect(state).toContain("'top_prize_chips', v_top");
  });

  it('the window is derived from the spins, never a counter something has to reset', () => {
    const spent = body(inForce('fn_wheel_welcome_spent').sql, 'fn_wheel_welcome_spent');
    expect(spent).toContain('FROM public.wheel_spins s');
    expect(spent).toContain('AND s.is_welcome');
    expect(spent).toContain('s.created_at >= now() - make_interval(days => p_days)');
    // 0 means for ever. A reset job would be a cron presented as the
    // resolution, which CLAUDE.md 10.12 forbids outright.
    expect(spent).toContain('COALESCE(p_days, 0) <= 0');
  });
});

describe('one question, and every reader asks the same one', () => {
  /**
   * The post-phase-2 audit found fn_diamond_games_entry asking whether the
   * budget merely EXCEEDED the spend, while the door and the page required the
   * window to cover the TOP PRIZE. A probe on production showed the club
   * lobby, the wallet, the cash buy-in and the tournament sign-up all saying
   * "Welcome Spin Ready" on a host whose door then refused. Three copies of
   * one rule is what caused it, so there is one copy.
   */
  const room = body(inForce('fn_wheel_welcome_room').sql, 'fn_wheel_welcome_room');

  it('the helper is the only place the top prize is worked out', () => {
    expect(room).toContain('max(CASE WHEN g.kind');
    expect(CORE).not.toContain('max(CASE WHEN g.kind');
    expect(body(inForce('fn_wheel_welcome_state').sql, 'fn_wheel_welcome_state')).not.toContain(
      'max(CASE WHEN g.kind'
    );
  });

  it('and a budget of zero is unfunded, not open with nothing in it', () => {
    expect(room).toContain('o_open := COALESCE(cfg.welcome_budget_chips, 0) > 0');
    expect(room).toContain('AND o_spent + o_top <= cfg.welcome_budget_chips');
  });

  it.each([
    ['fn_wheel_spin_core', () => CORE],
    [
      'fn_wheel_welcome_state',
      () => body(inForce('fn_wheel_welcome_state').sql, 'fn_wheel_welcome_state'),
    ],
    [
      'fn_diamond_games_entry',
      () => body(inForce('fn_diamond_games_entry').sql, 'fn_diamond_games_entry'),
    ],
  ])('%s asks it through the helper', (_name, get) => {
    expect(get()).toContain('public.fn_wheel_welcome_room(');
  });

  it('no browser role may call the helper', () => {
    const sql = inForce('fn_wheel_welcome_room').sql;
    expect(sql).toContain('REVOKE ALL ON FUNCTION public.fn_wheel_welcome_room(uuid) FROM PUBLIC;');
    expect(sql).toContain('REVOKE ALL ON FUNCTION public.fn_wheel_welcome_room(uuid) FROM anon;');
    expect(sql).toContain(
      'REVOKE ALL ON FUNCTION public.fn_wheel_welcome_room(uuid) FROM authenticated;'
    );
  });
});

describe('the operator console can see its own switch and its own window', () => {
  /**
   * Neither was ever in fn_wheel_state's config payload, so the page read
   * undefined: the pill said Off however the switch was set, "Turn It Off"
   * posted NOT false = true so it could never be turned off, and the Budget
   * Window field always showed the 30 day default. That last one writes: the
   * console posts budget and window together, so an operator on 7 days who
   * saved a budget change silently put their window back to 30.
   */
  const state = body(inForce('fn_wheel_state').sql, 'fn_wheel_state');

  it('both are in the config the console reads', () => {
    expect(state).toContain("'welcome_spin_enabled', COALESCE(cfg.welcome_spin_enabled, false)");
    expect(state).toContain(
      "'welcome_budget_period_days', COALESCE(cfg.welcome_budget_period_days, 0)"
    );
  });

  it('and the console reads them rather than assuming a default', () => {
    const ops = readFileSync(
      resolve(__dirname, '..', 'src/pages/club/ClubWheelOperationsPage.tsx'),
      'utf8'
    );
    expect(ops).toContain('Boolean(cfg?.welcome_spin_enabled)');
    expect(ops).toContain('String(c?.welcome_budget_period_days ?? 30)');
    const service = readFileSync(
      resolve(__dirname, '..', 'src/services/DiamondWheelService.ts'),
      'utf8'
    );
    expect(service).toContain('welcome_budget_period_days: num(cfg.welcome_budget_period_days)');
  });
});

describe('the welcome flag is not a thing a browser can ask for', () => {
  it('the core takes it, only the two doors set it, and both ask who is calling', () => {
    expect(bank.sql).toContain(
      'REVOKE ALL ON FUNCTION public.fn_wheel_spin_core(uuid, uuid, text, boolean) FROM PUBLIC, anon, authenticated;'
    );
    expect(body(paidDoor.sql, 'fn_wheel_spin')).toContain(
      'RETURN public.fn_wheel_spin_core(p_club_id, p_commit_id, p_client_seed, false);'
    );
    expect(body(welcomeDoor.sql, 'fn_wheel_welcome_spin')).toContain(
      'RETURN public.fn_wheel_spin_core(p_club_id, p_commit_id, p_client_seed, true);'
    );
    expect(body(paidDoor.sql, 'fn_wheel_spin')).toContain('IF auth.uid() IS NULL THEN');
    expect(body(welcomeDoor.sql, 'fn_wheel_welcome_spin')).toContain('IF auth.uid() IS NULL THEN');
  });

  it('never mentions is_horse: a horse is a player (CLAUDE.md 10.5)', () => {
    expect(bank.sql).not.toMatch(/is_horse/);
    expect(books.sql).not.toMatch(/is_horse/);
    expect(coreFile.sql).not.toMatch(/is_horse/);
    expect(welcomeDoor.sql).not.toMatch(/is_horse/);
  });
});
