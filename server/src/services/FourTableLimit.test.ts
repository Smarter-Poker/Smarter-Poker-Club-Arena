/**
 * FOUR TABLES. NOBODY, EVER. — Dan 2026-08-24, BINDING
 *
 *   "NO PLAYER OR HORSE CAN EVER PLAY MORE THEN 4 TABLES AT ONCE.
 *    THIS IS A HARD RULE THAT SHOULDN'T BE BROKEN."
 *
 * The rule is enforced in the DATABASE, by BEFORE triggers on the two tables a
 * commitment can be created in, so that it holds for every one of the two
 * dozen functions that write seats, the six that write registrations, and the
 * Node engine that inserts directly. The application ceiling in horseLoadMap is
 * the polite pre-check that stops the engine spamming failed inserts; it is NOT
 * the enforcement, and these tests exist to keep the two from drifting apart
 * and to stop the migrations being quietly dropped.
 *
 * ── WHY THESE TESTS FOLLOW THE LATEST MIGRATION, 2026-08-28 ──
 *
 * They used to read the ONE file whose name contained 'four_table_limit' and
 * assert against its function body. That is a trap in a repo where a function
 * is redefined by a later migration: the old file never changes, so the suite
 * stays green while pinning a body production stopped running. These now
 * resolve the LAST migration that redefines each function — which is what the
 * database is actually executing.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { HORSE_MAX_CONCURRENT_TABLES, horseAtCapacity } from './TournamentRecurringService.js';

const MIGRATIONS = join(process.cwd(), '..', 'supabase', 'migrations');

/** The most recent migration that redefines `fnName`, by filename order. */
function latestMigrationDefining(fnName: string): string {
  const files = readdirSync(MIGRATIONS)
    .filter((n) => n.endsWith('.sql'))
    .sort();
  const match = files
    .filter((n) =>
      readFileSync(join(MIGRATIONS, n), 'utf8').includes(
        `CREATE OR REPLACE FUNCTION public.${fnName}`
      )
    )
    .pop();
  expect(match, `a migration must define public.${fnName}`).toBeTruthy();
  return readFileSync(join(MIGRATIONS, match as string), 'utf8');
}

const seatRule = () => latestMigrationDefining('fn_enforce_four_table_limit');
const bookingRule = () => latestMigrationDefining('fn_enforce_booking_game_cap');
const loadFn = () => latestMigrationDefining('fn_concurrent_game_load');
const enforcementInstall = () =>
  readFileSync(
    join(MIGRATIONS, '20260828_the_four_table_claim_is_atomic_and_counts_bookings.sql'),
    'utf8'
  );

/**
 * The EXECUTABLE half. These migrations carry long write-ups that quote the
 * rules they implement, so a naive search for a forbidden token matches the
 * paragraph explaining why the token is forbidden.
 */
const code = (sql: string) => sql.replace(/--.*$/gm, '');

describe('the four-table limit is enforced in the database', () => {
  it('creates a BEFORE trigger on table_seats', () => {
    const sql = enforcementInstall();
    expect(sql).toMatch(/CREATE TRIGGER trg_enforce_four_table_limit/);
    // BEFORE, or the seat already exists by the time we object.
    expect(sql).toMatch(/BEFORE INSERT OR UPDATE OF left_at ON public\.table_seats/);
    expect(sql).toMatch(/FOR EACH ROW/);
  });

  it('refuses at four, not at five', () => {
    // The comparison that IS the rule. `> 4` would permit a fifth table.
    expect(seatRule()).toMatch(/v_live\s*>=\s*4/);
  });

  it('counts live seats at open tables only', () => {
    const sql = loadFn();
    expect(sql).toMatch(/ts\.left_at IS NULL/);
    expect(sql).toMatch(/t\.status <> 'closed'/);
  });

  it('never counts the row being written against itself', () => {
    // Without these a re-occupancy UPDATE, or a second seat at the same table,
    // would inflate the count and lock somebody out below the real limit.
    const sql = loadFn();
    expect(sql).toMatch(/p_exclude_seat_id/);
    expect(sql).toMatch(/p_exclude_table_id/);
    // And the seat trigger must actually PASS them, or the parameters are decor.
    expect(seatRule()).toMatch(
      /fn_concurrent_game_load\(NEW\.user_id, NEW\.id, NEW\.table_id, v_tournament\)/
    );
  });

  it('vacating a seat is always allowed', () => {
    // A limit that blocked people from LEAVING would be a trap.
    expect(seatRule()).toMatch(/IF NEW\.left_at IS NOT NULL THEN\s*\n\s*RETURN NEW;/);
  });

  it('ships the partial indexes the count depends on', () => {
    // Without them the count seq-scans a hot table on every seat insert.
    expect(enforcementInstall()).toMatch(/idx_tournament_players_user_open/);
    const legacy = readdirSync(MIGRATIONS).find((n) => n.includes('four_table_limit')) as string;
    const legacySql = readFileSync(join(MIGRATIONS, legacy), 'utf8');
    expect(legacySql).toMatch(/idx_table_seats_user_live/);
    expect(legacySql).toMatch(/WHERE left_at IS NULL/);
  });

  it('carries a rollback, because it is a Tier 2 change to a hot table', () => {
    const sql = enforcementInstall();
    expect(sql).toMatch(/ROLLBACK/);
    expect(sql).toMatch(/DROP TRIGGER IF EXISTS trg_enforce_booking_game_cap/);
  });
});

/**
 * 2026-08-28. The measured defect: 24 accounts over the cap, and not one of
 * them over on SEATS. Every breach was a booking, and bookings had no
 * enforcement at all — four application callers each read the load, each
 * passed, and then all booked.
 */
describe('a booking counts, and is claimed atomically', () => {
  it('creates a BEFORE trigger on tournament_players', () => {
    const sql = bookingRule();
    expect(sql).toMatch(/CREATE TRIGGER trg_enforce_booking_game_cap/);
    expect(sql).toMatch(/BEFORE INSERT OR UPDATE OF status ON public\.tournament_players/);
  });

  it('scopes the trigger to status, so the 5s chip sync never pays for it', () => {
    // `BEFORE INSERT OR UPDATE` unqualified would fire on every chips write
    // for every live entrant every five seconds.
    expect(bookingRule()).not.toMatch(/BEFORE INSERT OR UPDATE ON public\.tournament_players/);
  });

  it('refuses at four, not at five', () => {
    expect(bookingRule()).toMatch(/v_load\s*>=\s*4/);
  });

  it('never refuses an entrant who is already in - including registered -> playing', () => {
    // Late registration promotes registered -> playing. Refusing that strands
    // a paid entrant off the felt over a rule about ENTERING.
    expect(bookingRule()).toMatch(
      /TG_OP = 'UPDATE' AND OLD\.status IN \('registered', 'playing'\)/
    );
  });

  it('leaving is always allowed', () => {
    // Eliminated, winner, unregistered: all reduce the count.
    expect(bookingRule()).toMatch(/NEW\.status NOT IN \('registered', 'playing'\)/);
  });

  it('both triggers take the SAME per-account lock, or the claim is not atomic', () => {
    // This is the whole fix. Two callers reading 3 and both writing is what
    // produced the 24 rows; one shared key per account makes check-and-claim
    // indivisible across the seat path, the booking path and atomic_table_buyin.
    const key =
      /pg_advisory_xact_lock\(hashtextextended\('table_cap:' \|\| NEW\.user_id::text, 0\)\)/;
    expect(seatRule()).toMatch(key);
    expect(bookingRule()).toMatch(key);
  });

  it('counts a booking only until its tournament starts', () => {
    // RUNNING must stay absent: its entrants hold seats, which clause (1)
    // already counts. Counting both puts every regular at an instant 2.
    const sql = loadFn();
    expect(sql).toMatch(/tr\.status IN \('ANNOUNCED', 'REGISTERING'\)/);
    expect(sql).not.toMatch(/tr\.status IN \([^)]*'RUNNING'/);
  });

  it('never counts a seat-first chair twice', () => {
    // A spin sells its seats while still REGISTERING, so the same game arrives
    // as both a seat and a booking. Excluding RUNNING cannot catch that.
    expect(loadFn()).toMatch(/NOT EXISTS/);
    expect(loadFn()).toMatch(/t2\.tournament_id = tp\.tournament_id/);
  });

  it('has no is_horse in any of the three bodies - CLAUDE.md 10.5', () => {
    // Identical rule for everyone. Checked against the code, not the prose:
    // the write-up quotes the rule and would match itself.
    expect(code(seatRule())).not.toMatch(/is_horse/);
    expect(code(bookingRule())).not.toMatch(/is_horse/);
    expect(code(loadFn())).not.toMatch(/is_horse/);
  });
});

describe('the application ceiling agrees with the database', () => {
  it('is the same number', () => {
    expect(HORSE_MAX_CONCURRENT_TABLES).toBe(4);
    expect(seatRule()).toContain(`v_live >= ${HORSE_MAX_CONCURRENT_TABLES}`);
    expect(bookingRule()).toContain(`v_load >= ${HORSE_MAX_CONCURRENT_TABLES}`);
  });

  it('still lets a horse take a fourth table and refuses a fifth', () => {
    expect(horseAtCapacity(3)).toBe(false);
    expect(horseAtCapacity(4)).toBe(true);
  });
});
