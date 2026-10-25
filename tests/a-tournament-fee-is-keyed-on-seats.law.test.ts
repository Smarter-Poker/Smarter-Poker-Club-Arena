/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE TOURNAMENT FEE IS KEYED ON SEATS — AND THE DATABASE SAYS SO TOO
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `rakeRateFor` in src/utils/buyIn.ts is the single source of truth for which
 * rate a format pays, and it keys on SEATS because a label is exactly the
 * thing that varies between six writers. Until 2026-08-31 the rule lived only
 * in TypeScript: 9,357 rows in `tournaments` break it, 3,415 of them by
 * OVERCHARGING and 5,942 by undercharging, and no constraint on the table
 * could see either — both existing CHECKs are ceilings, so a fee of 0.00 on a
 * 100-chip MTT satisfies every guard the table has.
 *
 * `supabase/migrations/20260901110000_the_seat_keyed_fee_becomes_law_going_forward.sql`
 * puts the rule where the writers are. This file is what keeps the two copies
 * from drifting, and what keeps the three properties that make the migration
 * safe from being quietly edited out:
 *
 *   1. the SQL rate ladder is the TypeScript rate ladder;
 *   2. the guard is DATE-GATED, so a legacy row stays updatable — the
 *      whole-dollar CHECK of 2026-08-21 was not, and it turned 9,814 rows
 *      read-only with two decided SNGs stranded mid-payout;
 *   3. nothing in it validates a NOT VALID constraint or rewrites history.
 *
 * If a pin here fails, fix the change — do not weaken the pin.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

import { rakeRateFor, splitBuyIn } from '../src/utils/buyIn';

const MIGRATION =
  'supabase/migrations/20260901110000_the_seat_keyed_fee_becomes_law_going_forward.sql';

const sql = fs.readFileSync(path.join(process.cwd(), MIGRATION), 'utf8');

/** The file without its prose, so a pin cannot be satisfied by a comment
 *  describing the code it is meant to find. */
const code = sql.replace(/^\s*--.*$/gm, '');

describe('the seat-keyed fee rule is enforced in the database', () => {
  it('the guard fires on insert and on a repricing, and on nothing else', () => {
    expect(code).toMatch(
      /CREATE TRIGGER trg_tournament_fee_seat_rule\s+BEFORE INSERT OR UPDATE OF buy_in_amount, buy_in_fee ON public\.tournaments/
    );
    expect(code).toContain('FOR EACH ROW EXECUTE FUNCTION public.fn_tournament_fee_seat_rule()');
  });

  it('is gated on created_at, so a legacy row can still be updated', () => {
    // The gate is the difference between a guard and the 2026-08-21 outage.
    expect(code).toContain("timestamptz '2026-09-01 00:00:00+00'");
    expect(code).toMatch(
      /COALESCE\(NEW\.created_at, now\(\)\) < public\.fn_tournament_fee_rule_cutover\(\)/
    );
    expect(code).toMatch(/RETURN NEW;/);
  });

  it('never validates a NOT VALID constraint and never rewrites a price', () => {
    // VALIDATE CONSTRAINT would abort on 3,299 legacy rows and lock the table
    // on its way out. UPDATE/DELETE on tournaments would be a backfill, which
    // is the thing Dan's ruling forbids.
    expect(code).not.toMatch(/VALIDATE\s+CONSTRAINT/i);
    expect(code).not.toMatch(/UPDATE\s+public\.tournaments/i);
    expect(code).not.toMatch(/DELETE\s+FROM\s+public\.tournaments/i);
  });

  it('is safe to re-run', () => {
    expect(code).toContain('DROP TRIGGER IF EXISTS trg_tournament_fee_seat_rule');
    expect(code).toContain('DROP CONSTRAINT IF EXISTS ledger_reconcile_log_entity_type_check');
    expect(code).toContain("cron.unschedule('tournament-fee-law-hourly')");
    for (const fn of [
      'fn_tournament_fee_rule_cutover',
      'fn_tournament_seat_rake_rate',
      'fn_tournament_expected_fee',
      'fn_tournament_fee_seat_rule',
      'fn_tournament_fee_violations',
      'fn_tournament_fee_law_check',
    ]) {
      expect(code, `${fn} must be CREATE OR REPLACE`).toContain(
        `CREATE OR REPLACE FUNCTION public.${fn}`
      );
    }
  });
});

describe('the SQL rate ladder is the TypeScript rate ladder', () => {
  // Read the rates out of the mirror function rather than trusting the prose
  // above it. If someone edits the CASE, these move with it and the
  // expectations below fail against rakeRateFor.
  const mirror = code.slice(
    code.indexOf('CREATE OR REPLACE FUNCTION public.fn_tournament_seat_rake_rate')
  );

  it('spin pays nothing, and both columns are consulted', () => {
    expect(mirror).toMatch(/lower\(COALESCE\(p_variant, ''\)\) = 'spin'/);
    expect(mirror).toMatch(/upper\(COALESCE\(p_tournament_type, ''\)\) = 'SPIN'/);
    expect(rakeRateFor({ variant: 'spin', maxPlayers: 3 })).toBe(0);
    expect(rakeRateFor({ tournamentType: 'SPIN', maxPlayers: 3 })).toBe(0);
  });

  it('one or two seats pay five percent', () => {
    expect(mirror).toMatch(/COALESCE\(p_max_players, 0\) BETWEEN 1 AND 2\s+THEN 0\.05/);
    expect(rakeRateFor({ maxPlayers: 1 })).toBe(0.05);
    expect(rakeRateFor({ maxPlayers: 2 })).toBe(0.05);
  });

  it('everything else pays ten, and an unknown seat count is never the cheap one', () => {
    expect(mirror).toMatch(/ELSE 0\.10/);
    expect(rakeRateFor({ maxPlayers: 3 })).toBe(0.1);
    expect(rakeRateFor({ maxPlayers: 0 })).toBe(0.1);
    expect(rakeRateFor({ maxPlayers: null })).toBe(0.1);
  });

  it('the fee floors to cents, exactly as feeToCents does', () => {
    expect(code).toContain('floor(COALESCE(p_total, 0) * COALESCE(p_rate, 0) * 100) / 100');
    // The rungs that a rounding fee would break: 1 and 5 took nothing when the
    // fee floored to whole chips, and 15 rounded UP through the 10% ceiling.
    for (const [total, rate, fee] of [
      [1, 0.1, 0.1],
      [5, 0.1, 0.5],
      [15, 0.1, 1.5],
      [20, 0.1, 2],
      [2, 0.05, 0.1],
      [10, 0.05, 0.5],
      [0, 0.1, 0],
    ] as const) {
      expect(splitBuyIn(total, rate).fee, `${total} at ${rate}`).toBe(fee);
      expect(Math.floor(total * rate * 100) / 100).toBe(fee);
    }
  });
});

describe('the drift alarm files findings where the money checks already live', () => {
  it('writes into ledger_reconcile_log as a critical finding', () => {
    expect(code).toContain('INSERT INTO public.ledger_reconcile_log');
    expect(code).toContain("'tournament_fee_law'");
    expect(code).toMatch(/'critical'/);
  });

  it('the entity_type check accepts the value the alarm emits', () => {
    // The constraint is an allowlist; an alarm that emits an unlisted value
    // throws instead of reporting, which is the loudest possible way to be
    // silent.
    const constraint = code.slice(
      code.indexOf('ADD CONSTRAINT ledger_reconcile_log_entity_type_check')
    );
    expect(constraint).toContain("'tournament_fee_law'::text");
    expect(constraint).toContain("'rake_law'::text");
  });

  it('files each tournament once, so an overlapping run is free', () => {
    expect(code).toMatch(/WHERE NOT EXISTS \(/);
    expect(code).toContain("l.metadata->>'tournament_id' = v.tournament_id::text");
  });

  it('cannot spam the 9,357 legacy rows', () => {
    expect(code).toMatch(
      /tr\.created_at >= COALESCE\(p_since, public\.fn_tournament_fee_rule_cutover\(\)\)/
    );
  });

  it('runs hourly, and not on a minute another reconciler owns', () => {
    expect(code).toMatch(/cron\.schedule\('tournament-fee-law-hourly', '25 \* \* \* \*'/);
    // :40 is the rake-law alarm, :55 the six-hourly ledger reconcile.
    expect(code).not.toMatch(/'tournament-fee-law-hourly', '(40|55|0) /);
  });

  it('is not a browser surface', () => {
    expect(code).toMatch(
      /REVOKE ALL ON FUNCTION public\.fn_tournament_fee_law_check\(timestamptz\)\s+FROM PUBLIC, anon, authenticated;/
    );
    expect(code).toMatch(
      /REVOKE ALL ON FUNCTION public\.fn_tournament_fee_seat_rule\(\)\s+FROM PUBLIC, anon, authenticated;/
    );
  });
});
