import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * THE RESTRICTION HELPERS STOP ANSWERING A CALLER WITH NO ACCOUNT
 *
 * Found by the phase 7 gate of Dan's Club Operations upgrade, by running the
 * estate's own `scripts/ci/audit-live-definer-exposure.mjs` against production
 * rather than trusting that a scheduled workflow had been read by anybody. It
 * was red, with three findings.
 *
 * Proved with nothing but the publishable key - no session, no user:
 *
 *     POST /rest/v1/rpc/fn_ca_player_restricted       200  false
 *     POST /rest/v1/rpc/fn_ca_player_restriction_for  200  {"id":null,"user_id":null,
 *          "scope":null,"reason_code":null,"reason_note":null,"applied_by":null,...}
 *     GET  /rest/v1/ca_player_restrictions            200  []
 *
 * The table is safe - RLS on, no policy - and the definer helpers were the way
 * around it. `fn_ca_player_restriction_for` returns the WHOLE moderation row
 * for any user id a stranger cares to type. Nothing leaked only because the
 * table has no rows yet.
 *
 * The third, `fn_club_member_count`, is a different mistake worth its own pin:
 * its own migration revoked PUBLIC and granted authenticated, and **revoking
 * PUBLIC does not remove a direct grant to anon**, so the intended fix read as
 * done and changed nothing.
 *
 * After the migration, all three answer 401 / 42501 and the audit is green:
 * "anon-readable functions: 7 (0 new)".
 */

const MIGRATION = readFileSync(
  'supabase/migrations/20260905073311_the_restriction_helpers_stop_answering_a_caller_with_no_acco.sql',
  'utf8'
);

describe('the restriction helpers are not anon surface', () => {
  it('revokes PUBLIC and anon together, never one without the other', () => {
    // anon inherits whatever PUBLIC holds, and a direct anon grant survives a
    // PUBLIC-only revoke. Naming one without the other is how each of these
    // three came to be open in the first place, in both directions.
    // From BEGIN onward only. The header QUOTES the other migration's
    // PUBLIC-only revoke in order to explain why it did not work, and a count
    // that cannot tell code from the prose beside it counts the explanation.
    // That mistake cost 20260905042100 its first apply earlier in this phase;
    // it is not going to cost this test a false green.
    const body = MIGRATION.slice(MIGRATION.indexOf('\nBEGIN;'));
    const revokes = body.match(/REVOKE ALL ON FUNCTION[^;]*;/g) ?? [];
    expect(revokes.length, 'three doors are closed').toBe(3);
    for (const r of revokes) {
      expect(r, `names PUBLIC: ${r}`).toContain('PUBLIC');
      expect(r, `names anon: ${r}`).toContain('anon');
    }
  });

  it('leaves the two guard helpers to service_role alone', () => {
    for (const fn of [
      'fn_ca_player_restricted(uuid, text)',
      'fn_ca_player_restriction_for(uuid, text)',
    ]) {
      expect(MIGRATION).toContain(
        `REVOKE ALL ON FUNCTION public.${fn}\n  FROM PUBLIC, anon, authenticated;`
      );
      expect(MIGRATION).toContain(`GRANT EXECUTE ON FUNCTION public.${fn}\n  TO service_role;`);
    }
  });

  it('keeps fn_club_member_count for signed-in callers, as its own migration intended', () => {
    // Not a tightening of somebody else's decision - the carrying out of it.
    expect(MIGRATION).toContain(
      'REVOKE ALL ON FUNCTION public.fn_club_member_count(uuid)\n  FROM PUBLIC, anon;'
    );
    expect(MIGRATION).toContain(
      'GRANT EXECUTE ON FUNCTION public.fn_club_member_count(uuid)\n  TO authenticated, service_role;'
    );
  });

  it('asserts the guard that still has to reach them is SECURITY DEFINER', () => {
    // This is the whole safety argument for revoking authenticated: the only
    // caller is fn_ca_refuse_restricted_entry, which is definer and owned by
    // postgres, so its nested calls never consult the caller's grant. A
    // migration that revokes on the strength of a sentence in its own header
    // is a migration that breaks seating if the sentence is wrong.
    expect(MIGRATION).toContain('fn_ca_refuse_restricted_entry');
    expect(MIGRATION).toContain(
      'the restriction guard is not SECURITY DEFINER, so revoking the helpers just broke seating'
    );
  });

  it('refuses to commit while any of the three still answers anon', () => {
    expect(MIGRATION).toContain("has_function_privilege('anon', r.oid, 'EXECUTE')");
    expect(MIGRATION).toContain('still answers a caller with no account');
  });

  it('changes no schema, so it costs no PostgREST reload', () => {
    // CLAUDE.md section 2 rule 5: GRANT/REVOKE are not in pgrst_ddl_watch's
    // list. A grant-only migration is the cheapest thing this repo can ship,
    // and that is why this one carries no CREATE of any kind.
    expect(MIGRATION).not.toMatch(/^CREATE\s/m);
    expect(MIGRATION).not.toMatch(/^ALTER TABLE/m);
  });
});
