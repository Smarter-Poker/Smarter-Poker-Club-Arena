/**
 * AN ALERT THAT REPEATS HOURLY BURIES THE ONES THAT DO NOT (2026-09-01).
 *
 * fn_raise_server_financial_alert inserted unconditionally, so every hourly
 * check that found the same unfixed thing filed it again. Measured on the open
 * set before this changed:
 *
 *   fn_close_settlement_period          244 open rows describing ONE problem
 *   FeeReconciler.prize_disbursement     18 open rows describing TWO
 *   drift_incident:fn_ca_money_rpc_drift 10 open rows describing ONE
 *   FeeReconciler.bbj_unlinkable         94 open rows describing 33
 *
 * A critical that matters was one line among those. The dedupe key gives one
 * OPEN alert per thing that is wrong rather than one per pass over it.
 *
 * Each pin below is one of those, or one of the ways the fix could be undone
 * by accident. Fix your change; never weaken a pin.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { sliceBlockAfter } from '../testHelpers/sourceWindow.js';

const read = (p: string) => readFileSync(join(__dirname, p), 'utf8');
const migrations = join(__dirname, '../../../supabase/migrations');
const dedupeMigration = readFileSync(
  join(migrations, '20260901190226_an_alert_that_repeats_hourly_buries_the_ones_that_do_not.sql'),
  'utf8'
);
const cashMigration = readFileSync(
  join(migrations, '20260901190656_a_cash_pot_reaches_a_player_or_it_is_a_bug.sql'),
  'utf8'
);
const alerts = read('./financialAlerts.ts');
const feeReconciler = read('./FeeReconciler.ts');
const gameServer = read('../GameServer.ts');

describe('the alert primitive can dedupe', () => {
  it('takes a dedupe key and returns the open row instead of writing a second', () => {
    expect(dedupeMigration).toMatch(/p_dedupe_key text DEFAULT NULL/);
    expect(dedupeMigration).toContain("fa.context ->> 'dedupe_key' = v_key");
    expect(dedupeMigration).toMatch(/IF v_id IS NOT NULL THEN\s*\n\s*RETURN v_id;/);
  });

  it('a deduped alert is NOT reported as throttled', () => {
    // NULL is the throttle signal and the wrapper escalates a throttled
    // CRITICAL to Sentry on the grounds that it was never recorded. A deduped
    // alert WAS recorded. Returning NULL would move the noise, not remove it.
    const dedupeAt = dedupeMigration.indexOf("fa.context ->> 'dedupe_key' = v_key");
    const throttleAt = dedupeMigration.indexOf('IF v_recent >= 60 THEN');
    expect(dedupeAt).toBeGreaterThan(-1);
    expect(throttleAt).toBeGreaterThan(dedupeAt);
  });

  it('leaves exactly one overload, so no caller can keep the old behaviour by arity', () => {
    expect(dedupeMigration).toMatch(
      /DROP FUNCTION IF EXISTS public\.fn_raise_server_financial_alert\(text, text, text, jsonb\);/
    );
  });

  it('the flood guard survives', () => {
    expect(dedupeMigration).toContain('IF v_recent >= 60 THEN');
  });
});

describe('the wrapper passes it through without changing the old contract', () => {
  it('dedupeKey is optional and omitted entirely when absent', () => {
    expect(alerts).toMatch(/dedupeKey\?: string/);
    // Spread, not `p_dedupe_key: undefined` — a null key would be sent on every
    // existing call and the RPC would have to defend itself against it.
    expect(alerts).toContain('...(dedupeKey ? { p_dedupe_key: dedupeKey } : {})');
  });
});

describe('the repeat offenders actually pass a key', () => {
  it('prize disbursement files one alert per tournament, keyed on the tournament', () => {
    // Bounded by the loop, never by a byte count.
    const block = sliceBlockAfter(feeReconciler, 'for (const r of rows)');
    expect(block.length).toBeGreaterThan(0);
    expect(block).toContain("'FeeReconciler.prize_disbursement'");
    // The last argument is the dedupe key, and it is the tournament id.
    expect(block).toMatch(/r\.tournament_id\s*\n?\s*\);/);
  });

  it('the bbj conditions carry a stable key', () => {
    expect(feeReconciler).toMatch(/'bbj_unlinkable'\s*\n?\s*\)/);
    expect(feeReconciler).toMatch(/'bbj_drift'\s*\n?\s*\)/);
  });
});

describe('the cash pot check', () => {
  it('states the invariant it is checking', () => {
    expect(cashMigration).toContain('abs(pot - rake - bbj - awarded) > 0.01');
  });

  it('does not alert on a hand whose whole pot went to the jackpot', () => {
    // Corrected on its first live run: both hands it found were fully
    // accounted, pot 0.30 = rake 0.03 + bbj 0.27, and owed nobody.
    expect(cashMigration).toContain('winner_count = 0 AND pot - rake - bbj > 0.01');
  });

  it('reports conditions, not writes, because the dedupe path returns an existing id', () => {
    expect(cashMigration).toContain("'conditions_alerted'");
    expect(cashMigration).not.toContain("'alerts_raised'");
  });

  it('moves no money', () => {
    expect(cashMigration).not.toContain('fn_credit_and_log');
    expect(cashMigration).not.toMatch(/UPDATE\s+public\.club_members/);
  });

  it('is bounded to a window it can actually finish', () => {
    // The ceiling was 720 hours for about an hour. A 168-hour window read
    // 463,506 rows and returned once, then hit the statement timeout on the
    // next call when the database was busier - the shape of every check here
    // that quietly stopped working. 48 is double what the engine asks for and
    // half of what has been seen to fail.
    expect(cashMigration).toContain('LEAST(GREATEST(COALESCE(p_since_hours, 24), 1), 48)');
    expect(gameServer).toContain('p_since_hours: 24');
  });

  it('is closed to browser roles', () => {
    expect(cashMigration).toMatch(
      /REVOKE ALL ON FUNCTION public\.fn_cash_pot_conservation_check\(integer\)\s*\n?\s*FROM PUBLIC, anon, authenticated;/
    );
  });

  it('GameServer calls it', () => {
    expect(gameServer).toContain("'fn_cash_pot_conservation_check'");
    expect(gameServer).toContain('GameServer.cash_pot_check_failed');
    expect(gameServer).toContain('GameServer.cash_pot_check_threw');
  });
});
