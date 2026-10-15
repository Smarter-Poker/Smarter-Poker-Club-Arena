/**
 * LAW: A PARKED FLOOR IS NOT AN OVERDUE START, AND A CLOSE WHOSE TABLE IS GONE
 * REFUSES NOTHING (2026-10-15).
 *
 * Dan's owner park 3d9c1ba1 held the floor of all seven clubs from 16:53 to
 * 18:10 UTC, and by design a scoped park holds every tournament in its scope.
 * fn_ca_launch_health read the three events it held as start_overdue and
 * turned the launch red for a stop the owner made on purpose. Its close of
 * 134 cash tables left 9 close rows for tables deleted afterwards, and the
 * floor hold watchdog waited for those 9 to be resumed for ever, so its own
 * alert could not close.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SQL = readFileSync(
  resolve(
    process.cwd(),
    'supabase/migrations/20261015221949_phase7_preserves_an_incident_already_resolved_before_install.sql'
  ),
  'utf8'
);
const CODE = SQL.replace(/^\s*--[^\n]*$/gm, '');
const block = (name: string) => SQL.split(`DO $${name}$`)[1].split(`$${name}$;`)[0];

describe('a parked floor is not an overdue start', () => {
  it('is one transaction with a live proof and exact pre and post images', () => {
    expect(SQL.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(SQL.match(/^COMMIT;$/gm)).toHaveLength(1);
    expect(SQL).toMatch(
      /^-- @live-proof: \(SELECT md5\(pg_get_functiondef\('public\.fn_ca_launch_health\(\)'::regprocedure\)\)='8a0ef4270d9396ef148276482c1346c1'/m
    );
    expect(CODE).toContain(
      "IF md5(def)<>'9940e7b65a9f55eef212928bf7ae3ad5' THEN RAISE EXCEPTION 'launch_health_preimage_refused'"
    );
    expect(CODE).toContain(
      "<>'8a0ef4270d9396ef148276482c1346c1' THEN RAISE EXCEPTION 'launch_health_postimage_refused'"
    );
    expect(CODE).toContain(
      "IF md5(def)<>'9f8b378e6a8cf3a340fe9c007e680e8a' THEN RAISE EXCEPTION 'watchdog_preimage_refused'"
    );
    expect(CODE).toContain(
      "<>'548f8211e96c5856776d7d5725ba9c20' THEN RAISE EXCEPTION 'watchdog_postimage_refused'"
    );
  });

  it('lists a start the operator floor is holding apart from the overdue ones, and still reds every other late start', () => {
    const lh = block('launch_health');
    const replacement = lh.split('n text:=$anchor$')[1].split('$anchor$;')[0];
    expect(replacement).toContain(
      'AND NOT public.fn_ca_launch_health_tournament_held(t.club_id, t.union_id)'
    );
    expect(replacement).toContain("'held_by_operator'");
    // The overdue predicate itself is unchanged.
    expect(replacement.startsWith("t.start_time < now() - interval '15 minutes'")).toBe(true);
  });

  it('reads the hold without a lock and gives a released event the same 15 minute grace', () => {
    const fn = CODE.split(
      'CREATE FUNCTION public.fn_ca_launch_health_tournament_held(p_club uuid, p_union uuid)'
    )[1].split('$function$;')[0];
    expect(fn).toContain('STABLE SECURITY DEFINER');
    expect(fn).not.toContain('advisory');
    expect(fn).toContain("h.mode = 'park'");
    expect(fn).toContain("c.domain = 'floor' AND c.action = 'resume'");
    expect(fn).toContain("c.created_at > now() - interval '15 minutes'");
    expect(CODE).toContain(
      'REVOKE ALL ON FUNCTION public.fn_ca_launch_health_tournament_held(uuid,uuid) FROM PUBLIC, anon, authenticated;'
    );
  });

  it('lets the floor hold watchdog close its alert once every close whose table exists is resumed', () => {
    const wd = block('watchdog');
    const replacement = wd.split('n text:=$anchor$')[1].split('$anchor$;')[0];
    expect(replacement).toContain(
      'AND EXISTS (SELECT 1 FROM public.tables t WHERE t.id = c.table_id)'
    );
    expect(replacement).toContain(
      'fn_ca_launch_cash_close_resumed(c.table_id, c.operation_id) IS NOT TRUE'
    );
  });

  it('preserves existing incident resolutions under the same row lock as its decision', () => {
    expect((CODE.match(/AND status <> 'resolved' FOR UPDATE/g) ?? []).length).toBe(4);
    expect(CODE).toContain('phase7_predecessor_already_installed');
    expect(CODE).toContain('phase7_incident_authority_changed');
    expect(readFileSync('scripts/ci/test_launch_reset_floor.py', 'utf8')).toContain(
      'test-phase7-preserve-resolved-postgres.py'
    );
  });

  it('closes each alert only behind an assertion that its cause is gone, and every incident with a root cause', () => {
    for (const name of ['a', 'b', 'c', 'd']) {
      expect(block(name)).toContain('RAISE EXCEPTION');
    }
    expect(block('c')).toContain(
      'chi.chi < 18.475 AND n.n >= 250000 AND man.manifests = 1 AND man.all_equal_spec AND off.off_ladder = 0'
    );
    expect(block('b')).toContain(
      "FROM public.clubs WHERE id = 'e14bc9f7-736d-425f-8f2c-e78305ebac1d' FOR UPDATE"
    );
    expect((SQL.match(/SELECT public\.fn_ca_incident_action\(/g) ?? []).length).toBe(4);
    expect(block('closed')).toContain("status <> 'resolved' OR root_cause IS NULL");
  });
});
