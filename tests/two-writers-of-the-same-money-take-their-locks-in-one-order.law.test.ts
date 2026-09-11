/**
 * TWO WRITERS OF THE SAME MONEY TAKE THEIR LOCKS IN ONE ORDER.
 *
 * Read from the Postgres log for the 24 hours to 2026-09-06 15:15 UTC: 875
 * deadlocks, 2,916 statements cancelled by statement_timeout, 6,969 row-lock
 * waits over a second, and 2,731 of those waits on ONE advisory lock. Behind
 * "WINNER prize credit failed after 3 retries", behind every fee the sweep had
 * to settle, behind every 2nd place the reconciler had to pay, behind the
 * nine spin bookings that died at the thaw, was one of five lock-order
 * inversions. Dan, 2026-09-06: "I WANT HARD CODED FIXES FOR THINGS THAT BREAK
 * ... FIXED AT THE ROOT CAUSE AND STOPPED FROM HAPPENING AGAIN."
 *
 * Five migrations, one rule each, every one a lock order and nothing else:
 *
 *  1. The reporting rollup triggers take pg_advisory_xact_lock_SHARED(918273645);
 *     only the range rebuilds take the exclusive form. An exclusive lock held
 *     to commit by every wallet and rake row was a global queue for chips.
 *  2. accepted-hand settlement locks its exact tournament roster in user_id
 *     order and retires the delayed bulk chip-sync writer.
 *  3. fn_settle_tournament_rake locks club_wallets before it credits the
 *     union wallet or the club treasury - the order atomic_distribute_rake
 *     already uses - and holds the tournament FOR NO KEY UPDATE (249 a day).
 *  4. atomic_seat_cashout_locked locks the game row before the seat, parent
 *     before child, the order the finish trigger already uses (131 a day).
 *  5. fn_seat_horse_in_seat_first_game takes the player's Daily Missions
 *     lock before the game row, the order the hand_history path uses.
 *
 * These pins read the migration files, not the database; the migrations
 * prove the live definitions themselves and abort if they do not hold.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

const MIGRATIONS = join(__dirname, '..', 'supabase', 'migrations');
const files = readdirSync(MIGRATIONS)
  .filter((f) => f.endsWith('.sql') || f.endsWith('.sql.pending'))
  .sort();
const read = (needle: string) => {
  const f = files.find((x) => x.includes(needle));
  return { f, sql: f ? readFileSync(join(MIGRATIONS, f), 'utf8') : '' };
};
const m1 = read('the_reporting_rollup_shares_its_lock_instead_of_serialising');
const m2 = read('tournament_chips_are_synced_in_one_order');
const m3 = read('tournament_rake_settles_in_the_same_lock_order_as_cash_rake');
const m4 = read('a_seat_cashout_locks_the_game_before_the_seat');
const m5 = read('seating_a_horse_takes_the_missions_lock_before_the_game_row');
const m7 = read('one_seat_first_repair_runs_at_a_time');
const m8 = read('non_satellite_terminal_settlement_commits_one_stored_receipt');
const m9 = read('stage_b_current_postimage_contraction');

/** The body of one CREATE OR REPLACE FUNCTION in a migration. */
function body(sql: string, fn: string): string {
  const start = sql.indexOf(`CREATE OR REPLACE FUNCTION public.${fn}(`);
  expect(start, `${fn} must be defined in the migration`).toBeGreaterThan(-1);
  const end = sql.indexOf('$function$;', start);
  return sql.slice(start, end);
}

describe('two writers of the same money take their locks in one order', () => {
  it('all five migrations exist', () => {
    for (const m of [m1, m2, m3, m4, m5])
      expect(m.f, 'a lock-order migration must not be deleted').toBeTruthy();
  });

  it('1. the reporting triggers share the lock; only the rebuilds hold it exclusively', () => {
    for (const fn of ['trg_ca_reporting_wallet_insert', 'trg_ca_reporting_rake_insert']) {
      const b = body(m1.sql, fn);
      expect(b).toContain('pg_advisory_xact_lock_shared(918273645)');
      expect(b).not.toMatch(/pg_advisory_xact_lock\(918273645\)/);
    }
    // the migration refuses to apply if anything else takes the lock
    expect(m1.sql).toContain("prosrc ~ '918273645'");
    expect(m1.sql).toContain(
      "RAISE EXCEPTION 'VERIFY FAILED: % other function(s) reference the reporting lock"
    );
    // shared rows are upserted in club_id order
    expect(body(m1.sql, 'trg_ca_reporting_wallet_insert')).toMatch(
      /ca_reporting_tournament_clubs_for_user\(NEW\.user_id\) c\s+ORDER BY c\.club_id/
    );
  });

  it('2. accepted-hand chips lock the exact roster before its in-transaction mirror', () => {
    const b = body(m8.sql, 'fn_ca_settle_hand_stacks_absolute');
    const lock = b.indexOf('ORDER BY tp.user_id,tp.id\n       FOR UPDATE;');
    const update = b.indexOf('UPDATE public.tournament_players tp');
    expect(lock).toBeGreaterThan(-1);
    expect(lock).toBeLessThan(update);
    expect(m9.sql).toContain('DROP FUNCTION public.fn_sync_tournament_chips(uuid,jsonb) RESTRICT;');
  });

  it('3. tournament rake settles club_wallets -> union_wallets | clubs, like cash rake', () => {
    const b = body(m3.sql, 'fn_settle_tournament_rake');
    const lock = b.indexOf(
      'FROM public.club_wallets WHERE club_id = v_t.club_id FOR NO KEY UPDATE'
    );
    expect(lock).toBeGreaterThan(-1);
    expect(lock).toBeLessThan(b.indexOf('public.increment_union_wallet('));
    expect(lock).toBeLessThan(b.indexOf('public.credit_club_rake_to_treasury('));
    expect(b).toContain('WHERE t.id = p_tournament_id FOR NO KEY UPDATE;');
    expect(b).not.toContain('WHERE t.id = p_tournament_id FOR UPDATE;');
  });

  it('4. a seat cashout locks advisory -> game -> seat', () => {
    const b = body(m4.sql, 'atomic_seat_cashout_locked');
    const adv = b.indexOf("hashtextextended('table_cap:'");
    const game = b.indexOf('FROM tournaments WHERE id = v_tournament FOR NO KEY UPDATE');
    const seat = b.indexOf('FROM table_seats');
    expect(adv).toBeGreaterThan(-1);
    expect(game).toBeGreaterThan(adv);
    expect(seat).toBeGreaterThan(game);
  });

  it('5. seating a horse takes the missions lock before the game row', () => {
    const b = body(m5.sql, 'fn_seat_horse_in_seat_first_game');
    const lock = b.indexOf('public.fn_lock_daily_mission_user(p_user_id)');
    const game = b.indexOf('FROM public.tournaments WHERE id = p_tournament_id FOR UPDATE');
    expect(lock).toBeGreaterThan(-1);
    expect(lock).toBeLessThan(game);
  });

  it('6. only one seat-first repair pass runs at a time, and it declines rather than waits', () => {
    // The repair loops over up to 25 games in ONE transaction, so every lock it
    // takes is held to the end. Two passes cycle whatever order each uses -
    // three deadlocks in the twelve minutes after m5 landed. A sweep has no
    // reason to run twice at once, so the second caller returns immediately.
    const b = body(m7.sql, 'fn_repair_seat_first_games');
    const guard = b.indexOf('pg_try_advisory_xact_lock');
    const loop = b.indexOf('FOR v_t IN');
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(loop);
    expect(b).toContain("'repaired', 0, 'horses_seated', 0");
    // try_, never the blocking form: a pass that waits can deadlock on the wait
    expect(b).not.toMatch(
      /PERFORM\s+pg_advisory_xact_lock\(hashtextextended\('ca:seat-first-repair/
    );
  });

  it('none of the six moves a chip', () => {
    for (const m of [m1, m2, m3, m4, m5, m7]) {
      // a lock-order migration replaces function bodies; it never touches balances directly
      const outside = m.sql.replace(/CREATE OR REPLACE FUNCTION[\s\S]*?\$function\$;/g, '');
      // statements, not the quoted markers the verify blocks search for
      expect(outside).not.toMatch(
        /^\s*UPDATE public\.(club_members|wallets|club_wallets|union_wallets|clubs)\b/m
      );
      expect(outside).not.toMatch(/^\s*INSERT INTO public\.(wallet_transactions|chip_ledger)\b/m);
    }
  });
});
