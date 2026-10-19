/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  THE DAILY LOGIN STREAK COUNTS CONSECUTIVE DAYS (2026-10-19)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * The daily login reward is 10 on day one and 5 more for every consecutive
 * day, to 110. From 2026-09-07 every login paid 10: award_diamonds_v2 counted
 * the run with `WHERE d = v_today - rn`, rn is ROW_NUMBER() (a bigint), and
 * `date - bigint` does not exist, so the statement raised 42883 - inside an
 * `EXCEPTION WHEN others THEN v_streak := 0` that swallowed it. Nothing said a
 * word for six weeks.
 *
 * Migration 20261019092327 counts with `v_today - rn::int`, removes the
 * handler that hid the error, and settles the logins already underpaid once,
 * through add_diamonds_to_balance under one reference per player.
 *
 * These pins keep the cast, keep the mask out, and keep the rule itself: the
 * streak is the run of consecutive prior Chicago days with a daily_login
 * credit ending yesterday, plus today.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(
  join(
    process.cwd(),
    'supabase/migrations/20261019092327_the_daily_login_streak_counts_consecutive_days_again.sql'
  ),
  'utf8'
);
const fn = sql.slice(
  sql.indexOf('CREATE OR REPLACE FUNCTION public.award_diamonds_v2('),
  sql.indexOf('$function$;') + '$function$;'.length
);
const loginBranch = fn.slice(
  fn.indexOf("IF p_action_key = 'daily_login' THEN"),
  fn.indexOf("ELSIF p_action_key = 'easter_egg' THEN")
);

/**
 * The SQL, line for line: rank the player's distinct prior days newest first
 * (rn = 1 for the most recent) and count the days that sit exactly rn days
 * before today. A gap ends the run, because every later day is then more than
 * rn days back.
 */
function streakFor(today: string, priorDays: string[]): number {
  const day = (iso: string) => Math.round(Date.parse(`${iso}T00:00:00Z`) / 86_400_000);
  const t = day(today);
  const ranked = [...new Set(priorDays.map(day))].filter((d) => d < t).sort((a, b) => b - a);
  const run = ranked.filter((d, i) => d === t - (i + 1)).length;
  return run + 1;
}
const reward = (streak: number) => Math.min(10 + (streak - 1) * 5, 110);

describe('the daily login streak counts consecutive days', () => {
  it('counts the run with an integer offset, which is the type date - n needs', () => {
    expect(loginBranch).toMatch(/WHERE d = v_today - rn::int;/);
    expect(loginBranch).not.toMatch(/WHERE d = v_today - rn;/);
  });

  it('no exception handler hides a failure to count the streak', () => {
    expect(loginBranch).not.toMatch(/EXCEPTION/);
    expect(loginBranch).not.toMatch(/v_streak := 0/);
  });

  it("keeps the rule: 10 on day one, 5 more a day, 110 at most, from the player's own login days", () => {
    expect(fn).toMatch(/c_login_base\s+constant integer := 10;/);
    expect(fn).toMatch(/c_login_step\s+constant integer := 5;/);
    expect(fn).toMatch(/c_login_max\s+constant integer := 110;/);
    expect(loginBranch).toMatch(
      /v_requested := LEAST\(c_login_base \+ \(v_streak - 1\) \* c_login_step, c_login_max\);/
    );
    expect(loginBranch).toMatch(/AND transaction_type = 'daily_login'\s+AND amount > 0/);
    expect(loginBranch).toMatch(
      /AND \(created_at AT TIME ZONE 'America\/Chicago'\)::date < v_today\s+GROUP BY 1/
    );
  });

  it('the counting rule gives the streaks the players earned', () => {
    // kingfish on 2026-10-19 after logging in 10-11 through 10-18: day 9, 50.
    const run = [
      '2026-10-11',
      '2026-10-12',
      '2026-10-13',
      '2026-10-14',
      '2026-10-15',
      '2026-10-16',
      '2026-10-17',
      '2026-10-18',
    ];
    expect(streakFor('2026-10-19', run)).toBe(9);
    expect(reward(streakFor('2026-10-19', run))).toBe(50);
    // A missed day starts over.
    expect(streakFor('2026-10-19', ['2026-10-16', '2026-10-17'])).toBe(1);
    // Older days behind a gap never count.
    expect(streakFor('2026-10-19', ['2026-10-10', '2026-10-11', '2026-10-18'])).toBe(2);
    // The ceiling.
    expect(reward(25)).toBe(110);
    expect(reward(1)).toBe(10);
  });

  it('replaces exactly the live body it was written against, and proves the new one', () => {
    expect(sql).toMatch(/IS DISTINCT FROM '5c3f0cfa1e932d72b52c667374fbcb8c'/);
    expect(sql).toMatch(/IF md5\(v_src\) IS DISTINCT FROM '[0-9a-f]{32}' THEN/);
    expect(sql).toMatch(
      /REVOKE ALL ON FUNCTION public\.award_diamonds_v2\(uuid, text, text, text, jsonb\) FROM PUBLIC, anon, authenticated;/
    );
    expect(sql).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.award_diamonds_v2\(uuid, text, text, text, jsonb\) TO service_role;/
    );
  });

  it('settles the underpaid logins once, through the idempotent credit path, never with a job', () => {
    const backpay = sql.slice(sql.indexOf('DO $backpay$'));
    expect(backpay).toMatch(/public\.add_diamonds_to_balance\(/);
    expect(backpay).toMatch(/'daily_login_streak_backpay:' \|\| r\.user_id::text/);
    expect(sql).not.toMatch(/cron\.schedule/i);
    // No hand-written journal row: the only insert is the award path's own.
    expect(backpay).not.toMatch(/INSERT INTO public\.diamond_transactions/);
    expect(sql.split('INSERT INTO public.diamond_transactions').length - 1).toBe(1);
    // The derivation is checked against the streaks the function itself recorded.
    expect(sql).toMatch(/the derivation disagrees with streaks the function recorded/);
    // What the probe found, asserted so a moved board aborts the install.
    expect(sql).toMatch(/"47965354-0e56-43ef-931c-ddaab82af765": 620/);
    expect(sql).toMatch(/"2d1cd6c3-5700-4af9-a271-d4863fdab20d": 95/);
    expect(sql).toMatch(/"9b027798-9532-403f-a5c1-15554ce2959c": 40/);
  });

  it('pays horses exactly as humans: nothing in the settlement reads is_horse', () => {
    const backpay = sql.slice(sql.indexOf('DO $backpay$'));
    expect(backpay).not.toMatch(/is_horse/);
  });
});
