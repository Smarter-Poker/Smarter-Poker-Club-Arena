/**
 * A CHECK THAT NEVER RUNS LOOKS LIKE A CHECK FINDING NOTHING
 * (2026-09-02, Phase 1 of 6).
 *
 * The payout audit ends with six money checks reporting zero. Every one of
 * those zeros is worth exactly as much as the evidence that the check ran, and
 * there was none. A detector wired into a path nobody executes, a scheduler
 * pointed at a URL that 404s, an engine that has not restarted since the check
 * was written - all three produce the same output as a healthy platform.
 *
 * NOT HYPOTHETICAL, AND NOT ONLY MINE:
 *   - Open Claw fired /api/cron/rakeback-period-settle every Monday for weeks
 *     at a handler that had never been written. 281,108.01 chips of player
 *     rakeback accrued behind those silent 404s.
 *   - fn_spin_unpaid_check timed out on every call before 2026-08-31 and said
 *     so to nobody.
 *   - fn_pay_backed_payout_shortfalls ran hourly against a candidate query
 *     that excluded the events it existed to pay.
 *
 * Each pin below is one of the ways that silence gets back in. Fix your
 * change; never weaken a pin.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { sliceMethod } from '../testHelpers/sourceWindow.js';

const migration = readFileSync(
  join(
    __dirname,
    '../../../supabase/migrations/20260902012048_a_check_that_never_runs_looks_like_a_check_finding_nothing.sql'
  ),
  'utf8'
);
const gameServer = readFileSync(join(__dirname, '../GameServer.ts'), 'utf8');

/** The set the registry seeds, and the set the driver must stamp. */
const CHECKS = [
  'fn_payout_guarantee_check',
  'fn_cash_pot_conservation_check',
  'fn_backpay_unfinalised_bounty_pools',
  'fn_pay_backed_payout_shortfalls',
  'fn_detect_results_without_a_hand',
  'fn_tournament_money_conservation',
];

describe('a check that has never run is visible, not invisible', () => {
  it('the registry is SEEDED with the expected set', () => {
    // Without the seed, a check that never fires has no row and no age, and
    // reads as nothing rather than as missing.
    expect(migration).toContain('INSERT INTO public.money_check_heartbeat');
    for (const c of CHECKS) {
      expect(migration, `${c} is not seeded into the registry`).toContain(`'${c}'`);
    }
  });

  it('a NULL last_run_at counts as stale', () => {
    expect(migration).toContain('(r.last_run_at IS NULL)');
    expect(migration).toContain("'never_run', v_never");
  });

  it('staleness is measured against each check own interval, not one global number', () => {
    expect(migration).toContain('r.age_min > r.every_min * v_mult');
  });
});

describe('the heartbeat is written by the driver, not by the check', () => {
  it('GameServer stamps every one of the six', () => {
    for (const c of CHECKS) {
      expect(gameServer, `${c} runs without a heartbeat`).toContain(
        `this.recordMoneyCheckRun('${c}'`
      );
    }
  });

  it('the check functions do NOT record themselves', () => {
    // A check that records its own run proves only that somebody called it
    // once. What needs proving is that the engine's timer is executing it.
    expect(migration).not.toMatch(
      /CREATE OR REPLACE FUNCTION public\.fn_payout_guarantee_check[\s\S]*fn_record_money_check_run/
    );
  });

  it('the recorder cannot break the pass it is measuring', () => {
    const fn = migration.slice(
      migration.indexOf('CREATE OR REPLACE FUNCTION public.fn_record_money_check_run'),
      migration.indexOf('COMMENT ON FUNCTION public.fn_record_money_check_run')
    );
    expect(fn).toContain('EXCEPTION WHEN OTHERS THEN');
    // And the TypeScript side reports rather than throwing.
    const helper = sliceMethod(gameServer, 'private async recordMoneyCheckRun(');
    expect(helper).toContain('GameServer.money_check_heartbeat_failed');
    expect(helper).toContain('GameServer.money_check_heartbeat_threw');
  });
});

describe('the board is read after the checks have stamped', () => {
  it('fn_money_check_health runs at the end of the hourly pass', () => {
    // Matched on the RPC name alone, never on its surrounding whitespace:
    // Prettier collapsed this call onto one line the first time another agent
    // touched GameServer, and a pin that reads formatting fails on a change
    // that means nothing - the same mistake in a different costume as the
    // fixed-size source window this repo already outlawed.
    const healthAt = gameServer.indexOf("'fn_money_check_health'");
    const lastStampAt = gameServer.indexOf(
      "this.recordMoneyCheckRun('fn_backpay_unfinalised_bounty_pools'"
    );
    expect(healthAt).toBeGreaterThan(-1);
    expect(lastStampAt).toBeGreaterThan(-1);
    expect(healthAt).toBeGreaterThan(lastStampAt);
  });

  it('a failure to read the board is reported', () => {
    expect(gameServer).toContain('GameServer.money_check_health_failed');
    expect(gameServer).toContain('GameServer.money_check_health_threw');
  });

  it('the board read is NOT nested inside another check try block', () => {
    // The first draft put it inside the bounty back-pay's try, so a throw from
    // THAT rpc skipped the health read entirely - the one instrument whose job
    // is to notice when a check stops, silenced by a check stopping. Same
    // watchdog-shares-a-failure-domain mistake this estate wrote down about
    // publish-watchdog. The bounty catch must close BEFORE the health try opens.
    const bountyCatchAt = gameServer.indexOf(
      "reportError(bbEx, 'GameServer.bounty_backpay_threw')"
    );
    const healthAt = gameServer.indexOf("'fn_money_check_health'");
    expect(bountyCatchAt).toBeGreaterThan(-1);
    expect(healthAt).toBeGreaterThan(bountyCatchAt);
  });
});

describe('it is a check, not a cure', () => {
  it('moves no money', () => {
    expect(migration).not.toContain('fn_credit_and_log');
    expect(migration).not.toMatch(/UPDATE\s+public\.club_members/);
  });

  it('one open alert per quiet check, keyed on the check name', () => {
    expect(migration).toContain("'money_check_stale'");
    expect(migration).toMatch(/r\.check_name\);/);
  });

  it('both functions are closed to browser roles', () => {
    expect(migration).toMatch(
      /REVOKE ALL ON FUNCTION public\.fn_record_money_check_run\(text, jsonb\)\s*\n?\s*FROM PUBLIC, anon, authenticated;/
    );
    expect(migration).toMatch(
      /REVOKE ALL ON FUNCTION public\.fn_money_check_health\(numeric\)\s*\n?\s*FROM PUBLIC, anon, authenticated;/
    );
  });
});
