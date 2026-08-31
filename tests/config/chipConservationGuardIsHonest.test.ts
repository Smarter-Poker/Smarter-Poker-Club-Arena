/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  A GUARD THAT FIRES ON A FIFTH OF ALL GAMES IS NOT A GUARD
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `fn_spin_chip_conservation_check` closes a real hole: every money
 * guard in the estate watches the prize, and none of them counts the chips on
 * the felt. A chip mint moves no money - the prize pool is fixed at buy-in
 * time - so a bug that hands a busted player a fresh stack keeps every
 * existing audit green while changing who WINS.
 *
 * The first cut of the check measured every variant, and reported 281 of 1,341
 * games broken. That number was an artefact, not a finding: for a multi-table
 * tournament with late registration, seats × starting_chips is simply not the
 * expected chip total, because seats and stacks keep arriving after the clock
 * starts. Shipping it would have taught whoever reads financial_alerts to
 * close this alert unread, which is worse than having no alert at all.
 *
 * So the check is scoped to 'spin' and 'sng', the two variants where the
 * identity is exact - over the 3,307 such games completed in the 24h before it
 * shipped, ZERO had late registration, re-entry, add-ons or early-bird chips.
 *
 * This test pins that scope in the migration text. If someone widens the check
 * to all variants, or drops the rebuy exclusion, or adds an is_horse filter,
 * CI says so here rather than production saying so with a false alarm.
 *
 * Reads the SQL as TEXT: no database connection, runs on every pull request.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const DIR = resolve(__dirname, '../../supabase/migrations');
const GUARD = resolve(DIR, '20260831234000_spin_chip_conservation_guard.sql');
const SCHEDULE = resolve(DIR, '20260831234100_spin_chip_conservation_guard_schedule.sql');

const guardSql = readFileSync(GUARD, 'utf8');
const scheduleSql = readFileSync(SCHEDULE, 'utf8');

/** The SQL with `--` comments removed, so prose about a filter is not a filter. */
const guardCode = guardSql
  .split('\n')
  .map((line) => line.replace(/--.*$/, ''))
  .join('\n');

/** The function body only, so header prose can say anything it likes. */
const body = guardSql.slice(
  guardSql.indexOf('AS $function$'),
  guardSql.indexOf('$function$;'),
);

describe('the chip conservation guard measures only what it can measure', () => {
  it('restricts itself to the two fixed-entry variants', () => {
    expect(body).toMatch(/t\.variant\s+IN\s*\(\s*'spin'\s*,\s*'sng'\s*\)/);
  });

  it('does not measure variants whose seat count grows after the clock starts', () => {
    for (const variant of ['freezeout', 'satellite', 'bounty', 'mystery_bounty']) {
      expect(body).not.toContain(`'${variant}'`);
    }
  });

  it('skips games with rebuy or add-on chips rather than guessing their value', () => {
    expect(body).toMatch(/NOT EXISTS/);
    expect(body).toMatch(/'rebuy'\s*,\s*'addon'\s*,\s*'addon_refund'/);
  });

  it('compares the chips on the felt against seats x starting_chips', () => {
    expect(body).toMatch(/count\(\*\)[\s\S]{0,180}\*\s*t\.starting_chips/);
    expect(body).toMatch(/sum\(tp\.chips\)/);
  });

  it('treats horses as players, CLAUDE.md 10.5', () => {
    expect(guardCode).not.toMatch(/is_horse/i);
    expect(guardCode).not.toMatch(/p_include_horses/i);
  });

  it('reads and alerts, and repairs nothing', () => {
    // The only write is the alert row. No UPDATE of chips, stacks or wallets.
    expect(body).not.toMatch(/\bUPDATE\s+public\./i);
    expect(body).not.toMatch(/\bDELETE\s+FROM\b/i);
    const inserts = body.match(/\bINSERT\s+INTO\s+public\.(\w+)/gi) ?? [];
    expect(inserts).toHaveLength(1);
    expect(inserts[0]).toMatch(/financial_alerts/);
  });

  it('is closed to anon and authenticated, and open to service_role', () => {
    expect(guardSql).toMatch(/REVOKE ALL ON FUNCTION[\s\S]*FROM anon;/);
    expect(guardSql).toMatch(/REVOKE ALL ON FUNCTION[\s\S]*FROM authenticated;/);
    expect(guardSql).toMatch(/GRANT EXECUTE ON FUNCTION[\s\S]*TO service_role;/);
    // and proves it in the migration rather than trusting the grant took
    expect(guardSql).toMatch(/has_function_privilege\('anon'/);
    expect(guardSql).toMatch(/has_function_privilege\('service_role'/);
  });
});

describe('the schedule points at the function it claims to', () => {
  it('runs hourly at :49, a minute no other hourly job holds', () => {
    expect(scheduleSql).toMatch(/'49 \* \* \* \*'/);
  });

  it('calls the function this migration pair defines', () => {
    expect(scheduleSql).toContain('public.fn_spin_chip_conservation_check(');
  });

  it('takes the advisory lock so two runs cannot overlap', () => {
    expect(scheduleSql).toMatch(/pg_try_advisory_lock\(hashtext\('spin_chip_conservation'\)\)/);
  });

  it('verifies the job landed instead of trusting cron.schedule', () => {
    expect(scheduleSql).toMatch(/RAISE EXCEPTION 'spin_chip_conservation_hourly was not scheduled'/);
  });
});
