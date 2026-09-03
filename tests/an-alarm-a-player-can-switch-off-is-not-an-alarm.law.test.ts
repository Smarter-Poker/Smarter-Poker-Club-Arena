import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * AN ALARM A PLAYER CAN SWITCH OFF IS NOT AN ALARM (binding)
 *
 * fn_resolve_settled_financial_alerts shipped SECURITY DEFINER, VOLATILE, and
 * executable by `authenticated`, with nothing in its body consulting
 * auth.uid(), auth.role(), auth.jwt() or the request. p_apply => false listed
 * the platform's open financial alerts; p_apply => true cleared them, including
 * the earner_not_paid class that fires when a tournament did not pay somebody.
 *
 * The damage from that shape is not disclosure, it is erasure that looks like
 * health: an unpaid player's alarm, silently resolved, is indistinguishable
 * afterwards from a payout that went fine.
 *
 * There is already a live reader for this - fn_ca_browser_reachable_telemetry()
 * behind scripts/ci/check-telemetry-exposure.mjs - and it caught this one. But
 * it reads the DATABASE, which means it can only fail AFTER a grant has shipped
 * and is standing in production. It failed every branch in the repository for
 * the hours this grant stood, because the gate is shared and the database is
 * shared.
 *
 * This law reads the MIGRATIONS instead, so the same mistake is refused at the
 * point it is written rather than the point it is deployed. The two are not
 * redundant: one guards the estate, this one guards the diff.
 *
 * WHAT IS ALLOWED, deliberately: fn_raise_financial_alert keeps its grant to
 * `authenticated`. The browser client raises alerts through it
 * (src/services/FinancialAlertService.ts) and it is throttled for that reason.
 * RAISING an alarm is not the same act as CLEARING one, and only the second is
 * closed here. A law that banned both would have broken a working path to fix
 * an unrelated hole.
 */

const MIGRATIONS = resolve(__dirname, '../supabase/migrations');

/** A routine whose name says it ends, clears or settles an alert. */
const CLEARS_AN_ALARM =
  /fn_[a-z0-9_]*(resolve|clear|dismiss|silence|acknowledge)[a-z0-9_]*alert[a-z0-9_]*/i;

/** ...or says it the other way round: alert-something-resolve. */
const CLEARS_AN_ALARM_REVERSED =
  /fn_[a-z0-9_]*alert[a-z0-9_]*(resolve|clear|dismiss|silence|acknowledge)[a-z0-9_]*/i;

function clearsAnAlarm(fnName: string): boolean {
  return CLEARS_AN_ALARM.test(fnName) || CLEARS_AN_ALARM_REVERSED.test(fnName);
}

function allMigrations(): Array<{ file: string; sql: string }> {
  return readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((file) => ({ file, sql: readFileSync(resolve(MIGRATIONS, file), 'utf8') }));
}

/** Strip comments so a GRANT quoted in prose is not read as a GRANT. */
function code(sql: string): string {
  return sql
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n');
}

describe('an alarm a player can switch off is not an alarm', () => {
  it('no migration grants an alert-clearing routine to the browser', () => {
    const offences: string[] = [];

    for (const { file, sql } of allMigrations()) {
      const grants = code(sql).match(/GRANT[\s\S]{0,400}?;/gi) ?? [];
      for (const grant of grants) {
        if (!/\bEXECUTE\b/i.test(grant)) continue;

        // Read the roles from AFTER the TO keyword, not from the whole
        // statement. Matching the statement meant \bPUBLIC\b had to be
        // case-sensitive to avoid hitting the `public.` schema qualifier that
        // every one of these grants carries - and a lowercase `to public` then
        // walked straight through. Postgres does not care about the case.
        const to = grant.split(/\bTO\b/i)[1];
        if (!to) continue;
        // PUBLIC is listed first because it is the WORST of the three: it
        // includes anon, so it hands the routine to a caller with no account
        // at all. The first version of this law omitted it and passed a
        // mutation that granted the routine to PUBLIC.
        if (!/\b(PUBLIC|anon|authenticated)\b/i.test(to)) continue;

        const named = grant.match(/fn_[a-z0-9_]+/gi) ?? [];
        for (const fn of named) {
          if (clearsAnAlarm(fn)) offences.push(`${file}: ${fn}`);
        }
      }
    }

    expect(
      offences,
      `these grants hand an alert-clearing routine to a signed-in browser:\n${offences.join('\n')}`
    ).toEqual([]);
  });

  it('the routine that caused this law is revoked, and guarded for a clean rebuild', () => {
    const mine = allMigrations().filter(({ sql }) =>
      sql.includes('fn_resolve_settled_financial_alerts')
    );
    expect(mine.length, 'nothing in the repo closes this grant').toBeGreaterThan(0);

    const joined = mine.map((m) => m.sql).join('\n');
    expect(joined).toMatch(/REVOKE ALL ON FUNCTION public\.fn_resolve_settled_financial_alerts/);
    expect(joined).toContain('authenticated');

    // The CREATE for this routine was never committed - it was applied straight
    // to the database. A bare REVOKE naming a function a clean rebuild has
    // never created fails on an empty database, trading a live hole for a
    // broken bootstrap.
    expect(
      joined,
      'the revoke is not guarded, so it will fail on a database that never created the routine'
    ).toContain('to_regprocedure');
  });

  it('leaves the raise path alone, because raising is not clearing', () => {
    const joined = allMigrations()
      .map((m) => code(m.sql))
      .join('\n');
    const revokedRaiser = joined.match(
      /REVOKE[\s\S]{0,200}?fn_raise_financial_alert[\s\S]{0,200}?;/gi
    );
    for (const r of revokedRaiser ?? []) {
      expect(
        r,
        'the browser client raises alerts through fn_raise_financial_alert; revoking it breaks a working path'
      ).not.toMatch(/\bauthenticated\b/);
    }
  });
});
