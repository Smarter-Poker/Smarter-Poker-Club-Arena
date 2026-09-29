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
