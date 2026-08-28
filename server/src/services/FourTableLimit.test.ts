/**
 * FOUR TABLES. NOBODY, EVER. — Dan 2026-08-24, BINDING
 *
 *   "NO PLAYER OR HORSE CAN EVER PLAY MORE THEN 4 TABLES AT ONCE.
 *    THIS IS A HARD RULE THAT SHOULDN'T BE BROKEN."
 *
 * The rule is enforced in the DATABASE, by a BEFORE trigger on table_seats, so
 * that it holds for every one of the two dozen functions that write seats and
 * for the Node engine that inserts directly. The application ceiling in
 * horseLoadMap is the polite pre-check that stops the engine spamming failed
 * inserts; it is NOT the enforcement, and these tests exist to keep the two
 * from drifting apart and to stop the migration being quietly dropped.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { HORSE_MAX_CONCURRENT_TABLES, horseAtCapacity } from './TournamentRecurringService.js';

const MIGRATIONS = join(process.cwd(), '..', 'supabase', 'migrations');

function limitMigration(): string {
  const f = readdirSync(MIGRATIONS).find((n) => n.includes('four_table_limit'));
  expect(f, 'the four-table-limit migration must exist in supabase/migrations').toBeTruthy();
  return readFileSync(join(MIGRATIONS, f as string), 'utf8');
}

describe('the four-table limit is enforced in the database', () => {
  it('the migration creates a BEFORE trigger on table_seats', () => {
    const sql = limitMigration();
    expect(sql).toMatch(/CREATE TRIGGER trg_enforce_four_table_limit/);
    // BEFORE, or the seat already exists by the time we object.
    expect(sql).toMatch(/BEFORE INSERT OR UPDATE OF left_at ON public\.table_seats/);
    expect(sql).toMatch(/FOR EACH ROW/);
  });

  it('it refuses at four, not at five', () => {
    const sql = limitMigration();
    // The comparison that IS the rule. `> 4` would permit a fifth table.
    expect(sql).toMatch(/v_live\s*>=\s*4/);
  });

  it('it counts live seats at open tables only', () => {
    const sql = limitMigration();
    expect(sql).toMatch(/ts\.left_at IS NULL/);
    expect(sql).toMatch(/t\.status <> 'closed'/);
  });

  it('it never counts the seat being written against itself', () => {
    // Without these a re-occupancy UPDATE, or a second seat at the same table,
    // would inflate the count and lock somebody out below the real limit.
    const sql = limitMigration();
    expect(sql).toMatch(/ts\.id IS DISTINCT FROM NEW\.id/);
    expect(sql).toMatch(/ts\.table_id <> NEW\.table_id/);
  });

  it('vacating a seat is always allowed', () => {
    // A limit that blocked people from LEAVING would be a trap.
    const sql = limitMigration();
    expect(sql).toMatch(/IF NEW\.left_at IS NOT NULL THEN\s*\n\s*RETURN NEW;/);
  });

  it('ships the partial index the count depends on', () => {
    // Without it the count seq-scans table_seats on every seat insert.
    const sql = limitMigration();
    expect(sql).toMatch(/idx_table_seats_user_live/);
    expect(sql).toMatch(/WHERE left_at IS NULL/);
  });

  it('carries a rollback, because it is a Tier 2 change to a hot table', () => {
    const sql = limitMigration();
    expect(sql).toMatch(/ROLLBACK/);
    expect(sql).toMatch(/DROP TRIGGER IF EXISTS trg_enforce_four_table_limit/);
  });
});

describe('the application ceiling agrees with the database', () => {
  it('is the same number', () => {
    const sql = limitMigration();
    expect(HORSE_MAX_CONCURRENT_TABLES).toBe(4);
    expect(sql).toContain(`v_live >= ${HORSE_MAX_CONCURRENT_TABLES}`);
  });

  it('still lets a horse take a fourth table and refuses a fifth', () => {
    expect(horseAtCapacity(3)).toBe(false);
    expect(horseAtCapacity(4)).toBe(true);
  });
});
