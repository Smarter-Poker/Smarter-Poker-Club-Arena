/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  LAW - THE HORSE TAG EV CONSOLE IS NOT A BROWSER ROUTE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * fn_horse_tag_ev_significance(date) reads horse_review_rollup and returns, per
 * situation tag, the hand count, big blinds per hand, the spread and a z score:
 * the platform's own read of where its horses are losing and winning EV. On
 * 2026-09-30 its ACL was "=X/postgres" - PUBLIC - plus explicit anon and
 * authenticated, so a logged-out visitor could ask for it, and a probe as anon
 * returned 21 live rows. Horses are players (10.5); this is per-situation
 * win-rate analytics about them, published to anyone who asked.
 *
 * Telemetry Exposure had named it for 14 consecutive runs and Production
 * Integrity Audit had reported anon_definers=1 for about 19 days. Both were
 * right. Migration 20260930181616 revoked all three grants and left
 * service_role alone; anon and authenticated now get 42501.
 *
 * THE TRAP THIS PINS: Supabase grants anon and authenticated DIRECTLY, so
 * revoking PUBLIC alone looks like a closure and is not one. A future migration
 * that re-opens any of the three must fail here rather than in production.
 *
 * IT ALSO PINS THE CRITERION. fn_ca_browser_reachable_telemetry() used to test
 * "asks nothing about who is calling" against a routine's OWN text only, so a
 * routine that refuses strangers through a helper - fn_is_platform_admin(),
 * fn_is_horse_admin() - read as an open console. That blind spot had already
 * cost ten hand-written allowlist rows, and fn_ca_diamond_staff_books was about
 * to be the eleventh. The criterion now follows one level into a helper that
 * consults the caller. Deleting that clause re-opens the false positive, so it
 * is pinned too.
 */
import { describe, expect, it } from 'vitest';
import { migrationCorpus, migrationNames, migrationText } from './helpers/migrationCorpus';

const CLOSING = '20260930181616_close_the_horse_tag_ev_console_to_the_browser.sql';
const FN = 'fn_horse_tag_ev_significance';

const MIG = migrationText(CLOSING);
/** Comments stripped, so a name inside a `--` note is never mistaken for SQL. */
const code = (s: string) => s.replace(/--[^\n]*/g, ' ');

describe('LAW: the horse tag EV console is not a browser route', () => {
  it('revokes PUBLIC, anon and authenticated together, and keeps service_role', () => {
    expect(code(MIG)).toContain(
      `REVOKE ALL ON FUNCTION public.${FN}(date)\n  FROM PUBLIC, anon, authenticated;`
    );
    expect(code(MIG)).toContain(`GRANT EXECUTE ON FUNCTION public.${FN}(date)\n  TO service_role;`);
    // The closure is asserted inside the migration, so it cannot land half done.
    expect(MIG).toContain("has_function_privilege('anon', v_oid, 'EXECUTE')");
    expect(MIG).toContain("has_function_privilege('authenticated', v_oid, 'EXECUTE')");
  });

  it('lets no later migration re-open the grant', () => {
    const later = migrationCorpus().filter((m) => m.name > CLOSING);
    const reopened = later.filter((m) =>
      // a GRANT ... ON FUNCTION ... fn_horse_tag_ev_significance ... TO <browser role>
      new RegExp(
        `GRANT[^;]*\\bON\\s+FUNCTION[^;]*\\b${FN}\\b[^;]*\\bTO\\b[^;]*\\b(PUBLIC|anon|authenticated)\\b`,
        'is'
      ).test(code(m.sql))
    );
    expect(
      reopened.map((m) => m.name),
      `these migrations re-open ${FN} to a browser role; it is service_role only`
    ).toEqual([]);
  });

  it('keeps the criterion able to see a gate behind a helper', () => {
    // The four direct tests stay ...
    for (const needle of [
      "prosrc not ilike '%auth.uid()%'",
      "prosrc not ilike '%auth.role()%'",
      "prosrc not ilike '%auth.jwt()%'",
      "prosrc not ilike '%current_setting%request%'",
    ])
      expect(MIG).toContain(needle);
    // ... and so does the one-level hop that sees fn_is_platform_admin() and friends.
    expect(MIG).toContain('with identity_fn as (');
    expect(MIG).toMatch(
      /not exists \(select 1 from identity_fn i\s+where i\.oid <> p\.oid\s+and p\.prosrc ~ \('\\m' \|\| i\.proname \|\| '\\M'\)\)/
    );
    // The allowlist is still consulted; the hop did not replace it.
    expect(MIG).toContain('from public.ca_browser_definer_allowlist a where a.proname = p.proname');
  });

  it('records a written reason for each routine that stays reachable', () => {
    for (const fn of [
      'fn_capability_available',
      'fn_diamond_arena_leaderboard_period',
      'fn_platform_capabilities',
    ])
      expect(MIG).toContain(`('${fn}',`);
    // The kill-pot trigger is the reason authenticated keeps fn_capability_available.
    expect(MIG).toContain('zz_tables_kill_pot_guard');
    expect(MIG).toContain(
      "has_function_privilege('authenticated', 'public.fn_capability_available(text)'::regprocedure, 'EXECUTE')"
    );
  });

  it('is the only migration that changes this function\u2019s grants', () => {
    const touching = migrationNames().filter((n) =>
      new RegExp(`(GRANT|REVOKE)[^;]*\\b${FN}\\b`, 'is').test(code(migrationText(n)))
    );
    expect(touching).toEqual([CLOSING]);
  });
});
