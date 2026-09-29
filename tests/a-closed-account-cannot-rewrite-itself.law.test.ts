/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  A CLOSED ACCOUNT CANNOT REWRITE ITSELF (2026-09-29, binding)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Closing an account scrubs the profile and soft-deletes the Auth user, which
 * removes its sessions - but not the access tokens already issued. PostgREST
 * checks a token's signature and expiry, not its session, and this project's
 * tokens live for days. Measured on production in a rolled-back transaction:
 * the walkthrough account closed from the Android emulator could still set its
 * own display_name with its own token. Any device still signed in to a closed
 * account could write a name and a picture straight back.
 *
 * THE LAW: an UPDATE of a profile whose status is 'deleted' made with that
 * account's own token (auth.uid() = the row) is refused, whatever path it takes;
 * everyone else - the service role, jobs, staff - is unaffected.
 *
 * AND ITS OTHER HALF: `authenticated` holds UPDATE on profiles.status, so an
 * open profile's own session could mark itself 'deleted' and then not undo it -
 * a one-call lockout (measured). Only fn_close_account, called with the
 * service role, closes an account: fn_only_close_account_closes_an_account
 * refuses the owner's token setting 'deleted'.
 *
 * Registry: docs/laws.d/a-closed-account-cannot-rewrite-itself.md
 */
import { describe, expect, it } from 'vitest';
import { latestDeclaring } from './helpers/migrations';

const FN = 'fn_a_closed_account_cannot_rewrite_itself';
const { name: MIGRATION, sql: SQL } = latestDeclaring(FN);

describe(`${FN} (in force: ${MIGRATION})`, () => {
  it('refuses a change made with the closed account’s own token, and nothing else', () => {
    const start = SQL.indexOf('AS $function$');
    const body = SQL.slice(start, SQL.indexOf('$function$;', start + 13));
    expect(body).toMatch(
      /IF auth\.uid\(\) IS NOT DISTINCT FROM OLD\.id THEN\s+RAISE EXCEPTION 'ACCOUNT_CLOSED/
    );
    expect(body).toMatch(/USING ERRCODE = '42501'/);
    // One condition only: a wider rule would also stop the service role and
    // the database's own jobs, which is what keeps the books and the tombstone.
    expect(body.match(/\bIF\b/g)?.length).toBe(2); // IF ... END IF
  });

  it('fires before every update of a profile whose status is deleted, and only those', () => {
    expect(SQL).toMatch(
      /CREATE TRIGGER trg_a_closed_account_cannot_rewrite_itself\s+BEFORE UPDATE ON public\.profiles\s+FOR EACH ROW\s+WHEN \(OLD\.status = 'deleted'\)\s+EXECUTE FUNCTION public\.fn_a_closed_account_cannot_rewrite_itself\(\);/
    );
    expect(SQL).not.toMatch(/SECURITY DEFINER/);
  });
});

const CLOSER = 'fn_only_close_account_closes_an_account';
const { name: CLOSER_MIGRATION, sql: CLOSER_SQL } = latestDeclaring(CLOSER);

describe(`${CLOSER} (in force: ${CLOSER_MIGRATION})`, () => {
  it('refuses the owner’s own token marking its open profile closed, and nothing else', () => {
    const start = CLOSER_SQL.indexOf('AS $function$');
    const body = CLOSER_SQL.slice(start, CLOSER_SQL.indexOf('$function$;', start + 13));
    expect(body).toMatch(
      /IF auth\.uid\(\) IS NOT DISTINCT FROM OLD\.id THEN\s+RAISE EXCEPTION 'ACCOUNT_CLOSE_REQUIRED/
    );
    expect(body.match(/\bIF\b/g)?.length).toBe(2);
    expect(CLOSER_SQL).not.toMatch(/SECURITY DEFINER/);
  });

  it('fires only when an update would close a profile that is not closed', () => {
    expect(CLOSER_SQL).toMatch(
      /CREATE OR REPLACE TRIGGER trg_only_close_account_closes_an_account\s+BEFORE UPDATE ON public\.profiles\s+FOR EACH ROW\s+WHEN \(NEW\.status = 'deleted' AND OLD\.status IS DISTINCT FROM 'deleted'\)\s+EXECUTE FUNCTION public\.fn_only_close_account_closes_an_account\(\);/
    );
    // Its own trigger, never a DROP of the first one: that is an ACCESS
    // EXCLUSIVE lock on profiles, and it deadlocked against live traffic.
    expect(CLOSER_SQL.replace(/--[^\n]*/g, '')).not.toMatch(/DROP TRIGGER/i);
  });
});
