/**
 * THE REGISTER NEVER LOSES A MOVEMENT, AND A HORSE GETS THE SAME SEVEN DAYS.
 *
 * On 2026-09-08 at 05:37 UTC the diamond money identity broke for the first
 * time since the register was built: players held more diamonds than
 * `ca_mint_ledger` recorded, and the gap grew every minute until it reached
 * 2,236.
 *
 * The cause was one line. `fn_ca_register_diamond_journal_row` computed
 * `supply_after` under `pg_advisory_xact_lock('ca_mint_ledger:diamonds')`. An
 * xact-scoped advisory lock is held until the CALLER'S transaction commits, not
 * until the insert finishes - so every diamond movement on the platform took one
 * global lock and held it for the rest of whatever transaction it belonged to.
 * That was survivable while a transaction moved diamonds once; it stopped being
 * survivable the moment one transaction could claim several challenges at once,
 * and twenty-seven movements died on `lock_timeout` and went unrecorded.
 *
 * The scan under the lock was never the problem - 8,961 rows, single-digit
 * milliseconds. The SCOPE of the lock was. A profiler would have called the
 * function fast.
 *
 * What this law pins, and every pin is a bug that actually shipped:
 *
 *  1. The follow path takes NO transaction-scoped global lock. Comments are
 *     stripped before looking, because the first version of this very check
 *     failed on the new body's own explanation of what it no longer does - the
 *     same "a mention is not a call" mistake fixed the same night in
 *     `fn_ca_diamond_unreachable_money`.
 *  2. A register that cannot be written is an INCIDENT, never a refused reward.
 *     The diamonds have already moved and the journal row already stands.
 *  3. A horse claims its whole still-claimable seven-day set, oldest first - not
 *     only what the current transaction completed. 35,581 rows worth 2,233,572
 *     diamonds across 1,002 horses were earned, unreachable, and days from
 *     expiring when this was found. A human in that position still has a Claim
 *     button (CLAUDE.md 10.5).
 *  4. Hitting the per-user daily cap files NOTHING. Once DR7:user_over_daily_cap
 *     flips out of `log` on 2026-09-14 a thousand horses will meet that cap every
 *     day, and filing it would rebuild the always-on alarm removed in the same
 *     migration. (Until the flip the cap refuses nothing at all - which is why
 *     1,558,308 diamonds settled in the first quarter of an hour rather than
 *     being metered over the window, for humans and horses alike.)
 *  5. Retention never deletes a completed challenge inside the streak horizon:
 *     `get_challenge_streak` has no lower bound, so a 60-day floor would have
 *     made any longer streak uncomputable.
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

/** SQL with its line comments removed - a mention is not a call. */
const code = (sql: string) => sql.replace(/--[^\n]*/g, '');

describe('the register never loses a movement', () => {
  const register = read('the_register_lost_a_movement');
  const review = read('what_the_second_review_found');

  it('does not take a transaction-scoped global lock on the follow path', () => {
    const body = register.slice(
      register.indexOf('CREATE OR REPLACE FUNCTION public.fn_ca_register_diamond_journal_row'),
      register.indexOf('COMMENT ON COLUMN public.ca_mint_ledger.supply_after')
    );
    expect(body.length).toBeGreaterThan(200);
    expect(code(body)).not.toContain('pg_advisory_xact_lock');
    expect(code(body)).not.toContain('pg_advisory_lock');
  });

  it('still writes a register row for every movement it follows', () => {
    expect(register).toContain('INSERT INTO public.ca_mint_ledger');
    expect(register).toContain('ON CONFLICT (op_id) DO NOTHING');
  });

  it('asserts the money identity is exact before it commits', () => {
    expect(register).toContain("fn_ca_mint_supply('diamonds')");
    expect(register).toMatch(/the register and the players still disagree/);
  });

  it('re-registers only what an incident recorded as lost', () => {
    expect(register).toContain("rule = 'MINT:register_follow_failed'");
    expect(register).toContain('fn_ca_register_diamond_journal_row(v_inc.journal_id)');
    // never a blanket replay of every unregistered journal row: the register was
    // seeded from balances, so replaying history would double the supply
    expect(code(register)).not.toMatch(/FROM\s+public\.diamond_transactions\s+dt\s+LEFT JOIN/i);
  });

  it('creates nothing scheduled to repair it again (CLAUDE.md 10.12)', () => {
    const c = code(register);
    expect(c).not.toMatch(/cron\.schedule/i);
    expect(c).not.toMatch(/fn_\w*_(repair|backpay|redrive|sweep|catchup|heal)\w*/i);
  });
});

describe('a horse gets the same seven days a human gets', () => {
  const review = read('what_the_second_review_found');

  /** Only what the migration WRITES into the two function bodies - never its own
   *  $ca_from$ markers, which necessarily quote the text being replaced. */
  const replacements = (review.match(/\$ca_to\$[\s\S]*?\$ca_to\$/g) ?? []).join('\n');

  it('claims the whole still-claimable window, oldest first, on both overloads', () => {
    const windows = replacements.match(/u\.completed_at >= now\(\) - interval '7 days'/g) ?? [];
    expect(windows.length).toBe(2);
    const ordered = replacements.match(/ORDER BY u\.completed_at, u\.id/g) ?? [];
    expect(ordered.length).toBe(2);
  });

  it('never goes back to claiming only what this transaction completed', () => {
    // the old predicate survives only as the marker being replaced
    expect(replacements).not.toContain('u.completed_at = now()');
    // and the migration refuses to commit if any live function still carries it
    expect(review).toContain("p.prosrc LIKE '%u.completed_at = now()%'");
    expect(review).toContain('still claim only what this transaction completed');
  });

  it('does not file an incident when the refusal is the daily cap', () => {
    const guards = replacements.match(/IF SQLERRM NOT LIKE '%daily_cap%' THEN/g) ?? [];
    expect(guards.length).toBe(2);
  });

  it('stops the pass at the first refusal instead of retrying every row', () => {
    const exits = replacements.match(/\n\s+EXIT;\n/g) ?? [];
    expect(exits.length).toBe(2);
  });
});

describe('the instruments are honest', () => {
  const review = read('what_the_second_review_found');

  it('uses the DR13 rule mode instead of only reporting it', () => {
    expect(review).toContain(
      "v_sev := CASE WHEN v_mode = 'refuse' THEN 'critical' ELSE 'warning' END"
    );
    expect(review).toContain('v_sev,');
  });

  it('requires a literal call, not a mention, in the reachability detector', () => {
    expect(review).toContain("fn_ca_diamond_rule_mode(''' || r.rule || ''')");
  });

  it('files each alarm kind at most once a day', () => {
    const dedupes = review.match(/AND i\.occurred_at > now\(\) - interval '24 hours'/g) ?? [];
    expect(dedupes.length).toBe(2);
  });

  it('excludes fixtures from the concentration figure', () => {
    const conc = review.slice(review.indexOf('INTO v_top, v_humans'), review.indexOf('v_conc :='));
    expect(conc).toContain('fn_ca_is_fixture_account');
  });

  it('names the sink and player spend separately', () => {
    expect(review).toContain("'player_spend_30d', v_player");
    expect(review).toContain("'sink_total_30d', v_sink_raw");
  });

  it('keeps completed challenges beyond the streak horizon', () => {
    expect(review).toContain('p_challenge_days integer DEFAULT 400');
    expect(review).toContain('p_challenge_days < 400');
    expect(review).toContain('p_abandoned_days integer DEFAULT 60');
  });
});
