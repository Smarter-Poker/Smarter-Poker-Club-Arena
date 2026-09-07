/**
 * A SEAT-FIRST BOARD SELLS ITS SEATS ONCE.
 *
 * Measured on production 2026-09-06: 35 heads-up events (max_players = 2) took
 * between 3 and 32 PAID entries. The worst, 53e50799, holds prize_pool 1520.00
 * and total_rake 80.00 - exactly 32 x (47.50 + 2.50). Every one of the 35 was
 * all horses, and 31 of them fell inside two hours.
 *
 * The guard that should have stopped it, fn_enforce_tournament_capacity,
 * counted LIVE entrants:
 *
 *     AND COALESCE(status,'registered') NOT IN
 *         ('eliminated','winner','left','withdrawn','cancelled','refunded','busted')
 *
 * which is the right rule for a SEAT and the wrong one for an ENTRY. On a
 * two-handed board a bust-out dropped the count to 1 and the guard admitted -
 * and charged - another entrant into an event that had already been sold.
 * Then again. `tournaments.current_players` is blind in the same way, because
 * fn_sync_seat_first_player_count overwrites it with the live SEATED count.
 *
 * The rule this pins, from CLAUDE.md 10.11 (fix the cause, a detector is not a
 * fix) and 10.8 (never write a third law where one already exists - the count
 * was corrected inside the guard that was already there, not replaced by a
 * second guard beside it):
 *
 *   1. a seat-first board counts EVERY entry, not the survivors;
 *   2. a multi-table event is untouched;
 *   3. the count is taken under the tournament row lock, parent before child;
 *   4. 'sng' is seat-first, as it already is to the seat-count function;
 *   5. the registration doors ask ONE definition of "full" instead of each
 *      reading current_players for itself.
 *
 * These pins read the migration file. The migration proves the live behaviour
 * itself: it reproduces the exact failing state - an event at its cap whose
 * entrants have busted - inside a transaction it rolls back, and aborts if the
 * entry is admitted.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

const MIGRATIONS = join(__dirname, '..', 'supabase', 'migrations');
const file = readdirSync(MIGRATIONS)
  .filter((f) => f.endsWith('.sql'))
  .sort()
  .find((f) => f.includes('a_cap_counts_entries_not_the_seats_filled_right_now'));
const sql = file ? readFileSync(join(MIGRATIONS, file), 'utf8') : '';

/** SQL with its block comments removed - they quote the very words being banned. */
const code = (sql: string) => sql.replace(/\/\*[\s\S]*?\*\//g, '');

/** The body of one CREATE OR REPLACE FUNCTION in the migration. */
function body(fn: string): string {
  const start = sql.indexOf(`CREATE OR REPLACE FUNCTION public.${fn}(`);
  expect(start, `${fn} must be defined in the migration`).toBeGreaterThan(-1);
  const end = sql.indexOf('$function$;', start);
  return sql.slice(start, end);
}

describe('a seat-first board sells its seats once', () => {
  it('the migration exists', () => {
    expect(file, 'the capacity migration must not be deleted').toBeTruthy();
  });

  it('a seat-first board counts every entry, not the survivors', () => {
    const b = body('fn_enforce_tournament_capacity');
    const seatFirst = code(
      b.slice(b.indexOf('IF v_seat_first THEN'), b.indexOf('ELSE\n    -- Multi-table'))
    );
    // the whole point: no status exclusion on this side of the branch
    expect(seatFirst).toMatch(
      /SELECT count\(\*\) INTO v_have[\s\S]*WHERE tournament_id = NEW\.tournament_id;/
    );
    expect(seatFirst).not.toMatch(/eliminated/);
    expect(seatFirst).not.toMatch(/busted/);
  });

  it('a multi-table event still counts live entrants, so nothing else changes', () => {
    const b = body('fn_enforce_tournament_capacity');
    const mtt = b.slice(b.indexOf('ELSE\n    -- Multi-table'));
    expect(mtt).toMatch(
      /'eliminated', 'winner', 'left', 'withdrawn', 'cancelled', 'refunded', 'busted'/
    );
  });

  it('the count is taken under the tournament row lock, parent before child', () => {
    const b = body('fn_enforce_tournament_capacity');
    const lock = b.indexOf('FOR NO KEY UPDATE');
    const count = b.indexOf('SELECT count(*) INTO v_have');
    expect(lock).toBeGreaterThan(-1);
    expect(lock).toBeLessThan(count);
  });

  it("'sng' is seat-first here, as it already is to the seat-count function", () => {
    expect(body('fn_enforce_tournament_capacity')).toMatch(
      /v_seat_first := \(v_variant IN \('spin', 'sng'\) OR v_max <= 2\)/
    );
  });

  it('both registration doors ask one definition of full', () => {
    for (const fn of ['fn_register_horse_for_tournament', 'atomic_tournament_register']) {
      expect(body(fn)).toContain('public.fn_tournament_entry_cap_reached(p_tournament_id)');
    }
    // and that definition counts entries, taking the greater of the two counters
    expect(body('fn_tournament_entry_cap_reached')).toMatch(
      /RETURN GREATEST\(v_counter, COALESCE\(v_entries, 0\)\) >= v_cap;/
    );
  });

  it('the browser door locks the tournament row it never used to read', () => {
    const b = body('atomic_tournament_register');
    const lock = b.indexOf('FOR NO KEY UPDATE');
    const insert = b.indexOf('INSERT INTO tournament_players');
    expect(lock).toBeGreaterThan(-1);
    expect(lock).toBeLessThan(insert);
  });

  it('the migration proves the busted-seat case against live rows and rolls it back', () => {
    expect(sql).toMatch(
      /UPDATE public\.tournaments SET status = 'REGISTERING' WHERE id = v_target;/
    );
    expect(sql).toMatch(/VERIFY FAILED: a seat-first board at its cap admitted another entry/);
    expect(sql).toContain('zz_the_guard_did_not_refuse');
    // a probe that could not run must say so rather than passing quietly
    expect(sql).toContain('CAP_PROBE_NOT_RUN');
  });
});
