/**
 * A CHIP IS TWO DECIMAL PLACES, EVERYWHERE IT IS STORED.
 *
 * Phase 3 of the chip-accounting programme. Measured on production before it
 * was written: of the 28 columns in the conservation set, 11 already carried
 * scale 2, 7 carried scale 4, and TEN carried no scale at all. An
 * unconstrained `numeric` performs no rounding on write - it stores whatever
 * decimal expansion it is handed - and that is exactly how
 * tournament_payouts came to hold `55.629999999999995`, a JS double's binary
 * expansion of 55.63, written by a backfill on 2026-08-31. One row in 4.7
 * million, no money mispaid, and the only reason it was one and not many is
 * that every live path happens to round (`Math.round(pot * percent) / 100`).
 *
 * A column with a declared scale ROUNDS on write. That is the difference
 * between this and a CHECK constraint, and it is the whole design: a CHECK
 * refuses, so a prize credit whose float ends in ...9995 would leave a player
 * unpaid - trading a rounding error for an outage. Rounding cannot refuse
 * anybody. The bad value becomes unrepresentable rather than detected, which
 * is what CLAUDE.md 10.11 asks for.
 *
 * THE SPLIT IS PART OF THE LAW. The first attempt included
 * `tournaments.prize_pool` / `.bounty_pool` and DEADLOCKED at 16:25:18 -
 * ALTER TYPE rewrites under ACCESS EXCLUSIVE, and `tournaments` is 147 MB
 * written by every seat and every finish. Nothing applied; the transaction
 * rolled back whole. Those two columns moved to their own migration, run
 * inside the :55 maintenance freeze (CLAUDE.md 13), when no money moves.
 * A test that let them drift back into the live-play migration would be
 * re-arming that deadlock.
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
  return { f, sql: f ? readFileSync(join(MIGRATIONS, f), 'utf8') : '' };
};
const live = read('a_chip_is_two_decimal_places_everywhere_it_is_stored');
const freeze = read('the_tournament_pools_take_their_scale_in_the_maintenance_fre');

/** Every column the two migrations must leave at scale 2. */
const CONSERVATION = [
  ['bomb_pot_award_units', 'amount'],
  ['tournament_escrow', 'prize_balance'],
  ['tournament_escrow', 'fee_balance'],
  ['tournament_escrow', 'bounty_balance'],
  ['tournament_payouts', 'amount'],
  ['tournaments', 'prize_pool'],
  ['tournaments', 'bounty_pool'],
  ['union_wallets', 'chip_balance'],
  ['union_wallets', 'rake_wallet'],
  ['union_wallets', 'total_rake_collected'],
] as const;

describe('a chip is two decimal places everywhere it is stored', () => {
  it('both migrations exist', () => {
    expect(live.f, 'the eight-column migration must not be deleted').toBeTruthy();
    expect(freeze.f, 'the maintenance-freeze migration must not be deleted').toBeTruthy();
  });

  it('every column in the conservation set is given scale 2 by one of the two', () => {
    const both = live.sql + '\n' + freeze.sql;
    for (const [table, column] of CONSERVATION) {
      const alter = new RegExp(`ALTER COLUMN ${column}\\s+TYPE numeric\\(\\d+,2\\)`, 'i');
      expect(alter.test(both), `${table}.${column} must be given a scale of 2`).toBe(true);
    }
  });

  it('scale is given by the TYPE, never by a CHECK that could refuse a payment', () => {
    const both = live.sql + '\n' + freeze.sql;
    // a CHECK on these columns would refuse the write instead of rounding it
    expect(both).not.toMatch(/ADD CONSTRAINT[^;]*CHECK[^;]*round\s*\(/i);
    expect(both).toMatch(/TYPE numeric\(\d+,2\)/);
  });

  it('the hot table is altered ONLY in the freeze migration, and says why', () => {
    // re-arming the 16:25 deadlock is the failure this pin exists for
    expect(live.sql).not.toMatch(/ALTER TABLE public\.tournaments/);
    expect(freeze.sql).toMatch(/ALTER TABLE public\.tournaments/);
    expect(freeze.sql).toMatch(/deadlock/i);
    expect(freeze.sql).toMatch(/freeze/i);
    expect(freeze.sql).toContain('SET LOCAL lock_timeout');
  });

  it('both tournament pool columns move in ONE statement, so the table rewrites once', () => {
    const stmt = freeze.sql.slice(
      freeze.sql.indexOf('ALTER TABLE public.tournaments'),
      freeze.sql.indexOf(';', freeze.sql.indexOf('ALTER TABLE public.tournaments')) + 1
    );
    expect(stmt).toMatch(/prize_pool/);
    expect(stmt).toMatch(/bounty_pool/);
    // total_rake rides the same rewrite: scale 4 rounds only at the FOURTH
    // place, so it can still hold a genuine sub-cent if a rake calculation
    // ever stops rounding. Free to close while the table is already moving.
    expect(stmt).toMatch(/total_rake/);
  });

  it('the union auto-ledger is captured and restored, never hand-retyped', () => {
    // it journals every union wallet movement; a hand-written recreation could drift
    expect(live.sql).toContain('pg_get_triggerdef');
    expect(live.sql).toContain('DROP TRIGGER trg_ca_autoledger');
    expect(live.sql).toContain('EXECUTE v_def');
    expect(live.sql).toMatch(/came back DIFFERENT from how it went away/);
  });

  it('each migration proves the scale it claims', () => {
    for (const m of [live, freeze]) {
      expect(m.sql).toMatch(/numeric_scale IS DISTINCT FROM 2/);
      expect(m.sql).toMatch(/RAISE EXCEPTION 'VERIFY FAILED/);
    }
  });
});
