/**
 * A BUDGET IS NOT ONE ROW, AND A GUARD NEVER FAILS OPEN.
 *
 * `fn_ca_diamond_earn_ledger` maintained the promotional spend as a running
 * total: every award of one engine in one month did
 *
 *     ON CONFLICT (period, engine) DO UPDATE
 *       SET spent_diamonds = diamond_reward_budgets.spent_diamonds + EXCLUDED.spent_diamonds
 *
 * and held that row lock until the awarding transaction committed. On
 * 2026-09-08, from 05:37:01 - the same second the diamond register began failing
 * for the same reason - it lost **5,860 awards worth 399,948 diamonds** to
 * SQLSTATE 55P03 lock timeouts, plus 21 deadlocks.
 *
 * The counter was the least of it. The whole body sits in one
 * `EXCEPTION WHEN OTHERS`, so a timeout on that first statement also skipped the
 * per-user daily write AND both rule evaluations - and `v_refuse` is set inside
 * the block and raised outside it, so a failed write does not refuse, it
 * PERMITS. With `DR7:engine_over_budget` and `DR7:user_over_daily_cap` flipping
 * to `refuse` on 2026-09-14, the guard would have failed OPEN under exactly the
 * load that makes it fail. No test would have caught that: at one award a second
 * nothing times out.
 *
 * Every pin below is one of those facts:
 *
 *  1. The hot path appends a row; it never adds to a shared total.
 *  2. The spent figure is the frozen baseline plus the appended rows - the same
 *     seed-then-append shape as the register, so history is never replayed and
 *     never doubled.
 *  3. The per-user write happens BEFORE anything that could contend, because it
 *     used to be lost every time the budget write timed out.
 *  4. A write that could not complete while a rule is armed is CRITICAL and says
 *     a guard did not run. The award is still paid: a player never loses an
 *     earned reward to our bookkeeping (10.9 rule 3).
 *  5. The report reads the same function the rule reads.
 *  6. Nothing scheduled repairs any of it (10.12).
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
  if (!f) throw new Error(`no migration matching ${needle}`);
  return readFileSync(join(MIGRATIONS, f), 'utf8');
};
const code = (sql: string) => sql.replace(/--[^\n]*/g, '');

describe('a budget is not one row', () => {
  const sql = read('the_budget_stops_being_one_row');
  const body = code(sql);

  it('never adds to the shared budget total on the award path', () => {
    expect(body).not.toContain('SET spent_diamonds = diamond_reward_budgets.spent_diamonds');
  });

  it('appends one row per award instead', () => {
    expect(body).toContain('INSERT INTO public.ca_diamond_engine_spend');
    expect(body).toContain('ON CONFLICT (journal_id) DO NOTHING');
  });

  it('keys the append on the journal id so a replay counts once', () => {
    expect(body).toContain('journal_id  uuid        UNIQUE');
  });

  it('reports spend as the frozen baseline plus what was appended', () => {
    expect(body).toContain('CREATE OR REPLACE FUNCTION public.fn_ca_diamond_engine_spent');
    expect(body).toContain('b.spent_diamonds FROM public.diamond_reward_budgets b');
    expect(body).toContain('SUM(s.amount) FROM public.ca_diamond_engine_spend s');
  });

  it('creates the budget line without touching its total', () => {
    expect(body).toContain('ON CONFLICT (period, engine) DO NOTHING');
  });

  it('writes the per-user row before anything that could contend', () => {
    const fn = body.slice(
      body.indexOf('CREATE OR REPLACE FUNCTION public.fn_ca_diamond_earn_ledger')
    );
    expect(fn.indexOf('diamond_user_daily_awards')).toBeGreaterThan(-1);
    expect(fn.indexOf('diamond_user_daily_awards')).toBeLessThan(
      fn.indexOf('ca_diamond_engine_spend')
    );
  });
});

describe('a guard never fails open', () => {
  const sql = read('the_budget_stops_being_one_row');
  const body = code(sql);

  it('escalates a failed write to critical while a rule is armed', () => {
    expect(body).toContain("public.fn_ca_diamond_rule_mode('DR7:engine_over_budget') = 'refuse'");
    expect(body).toContain("CASE WHEN v_armed THEN 'critical' ELSE 'warning' END");
  });

  it('records that neither cap was evaluated for that award', () => {
    expect(body).toContain('rules_armed');
    expect(sql).toContain('The guard failed OPEN.');
  });

  it('still pays the award when the bookkeeping fails', () => {
    // the handler files an incident and returns; it never re-raises
    const handler = body.slice(body.indexOf('EXCEPTION WHEN OTHERS THEN'));
    expect(handler).toContain('fn_ca_diamond_incident');
    expect(handler.slice(0, handler.indexOf('END;'))).not.toContain('RAISE EXCEPTION');
  });

  it('keeps both rules able to refuse after the flip', () => {
    expect(body).toContain("v_refuse := 'DR7:engine_over_budget'");
    expect(body).toContain("v_refuse := COALESCE(v_refuse, 'DR7:user_over_daily_cap')");
    expect(body).toContain('promotional issuance refused');
  });
});

describe('the report and the rule read one number', () => {
  const body = code(read('the_budget_stops_being_one_row'));

  it('points the trial balance at the same function', () => {
    expect(body).toContain('SUM(public.fn_ca_diamond_engine_spent(b.period, b.engine))');
  });

  it('asserts the two agree before it commits', () => {
    expect(body).toContain('the trial balance and the rule disagree about what has been spent');
  });

  it('asserts the figure reconciles to baseline plus appended', () => {
    expect(body).toContain('the spent figure does not reconcile');
  });

  it('creates nothing scheduled to repair it again', () => {
    expect(body).not.toMatch(/cron\.schedule/i);
    expect(body).not.toMatch(/fn_\w*_(repair|backpay|redrive|sweep|catchup|heal)\w*/i);
  });
});
